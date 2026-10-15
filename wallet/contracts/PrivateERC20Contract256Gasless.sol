// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import "@sodalabs/bubble-core-contracts/contracts/bubble/MpcCore.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@sodalabs/bubble-core-contracts/contracts/bubble/DecryptionCaller.sol";
import {IWrappedNative} from "./PrivateERC20Contract256.sol";
import {
    PrivateERC20Contract256Storage,
    UnshieldRequest,
    OPRFToken,
    privateERC20Storage,
    privateBalanceOf
} from "./libraries/PrivateERC20GaslessStorage.sol";
import {PrivateOPRFNotes} from "./libraries/PrivateOPRFNotes.sol";

/// @title PrivateERC20Contract256Gasless
/// @notice Implementation of ERC20 token standard with enhanced privacy features using MPC
/// @dev This contract implements the ERC20 standard while ensuring confidentiality of token transactions through encryption.
///      This contract is deployed using an UUPS proxy.
///      Gasless variant: ERC-2771. A trusted PrivateERC20GaslessForwarder verifies the user's EIP-712 authorization
///      and calls the normal entrypoints with the signer appended to calldata; `_msgSender()` returns it.
///      Admin functions ignore the forwarder. OPRF note logic lives in the linked PrivateOPRFNotes library; only the
///      IT owner can route a note's value away from the IT owner.
///
/// @notice Key Features:
/// @notice Privacy Enhancement:
/// @dev The contract utilizes encryption techniques to encrypt sensitive data such as token balances and allowances.
/// Encryption is performed using system-wide encryption keys to safeguard transaction details.
///
/// @notice Encrypted Balances and Allowances:
/// @dev Token balances and allowances are stored in handles form within the contract's state variables.
/// In order to get the actual value, the user should call the soda proxy and ask to encrypt the value using the user's secret key.
/// This ensures that sensitive information remains confidential and inaccessible to unauthorized parties.
///
/// @notice Integration with MPC Core:
/// @dev The contract leverages functionalities provided by an external component called MpcCore.
/// This component likely implements cryptographic operations such as encryption, decryption, and signature verification
/// using techniques like Multi-Party Computation (MPC).
///
/// @notice Token Transfer Methods:
/// @dev The contract provides multiple transfer methods, allowing token transfers in encrypted, handles and clear (unencrypted) forms.
/// Transfers can occur between addresses with encrypted token values, handles to values or clear token values.
///
/// @notice Approval Mechanism:
/// @dev An approval mechanism is implemented to allow token holders to grant spending permissions (allowances) to other addresses.
/// Approvals are also stored in handles form within the contract's state variables.
contract PrivateERC20Contract256Gasless is DecryptionCaller, UUPSUpgradeable, Ownable2StepUpgradeable, ReentrancyGuardUpgradeable, PausableUpgradeable {
    /// @notice Emitted when tokens are transferred in the clear
    /// @param _from The address of the sender
    /// @param _to The address of the recipient
    /// @param _value The amount of tokens transferred
    event Transfer(address indexed _from, address indexed _to, uint256 _value);
    /// @notice Emitted when tokens are transferred using encrypted amounts
    /// @param from The address of the sender
    /// @param to The address of the recipient
    /// @param amount The encrypted amount credited to the recipient
    event PrivateTransfer(address indexed from, address indexed to, gtUint256 amount);
    /// @notice Emitted when an approval is set
    /// @param _owner The address of the token owner
    /// @param _spender The address of the spender
    /// @param _value The amount of tokens approved (only for clear approvals)
    event Approval(address indexed _owner, address indexed _spender, uint256 _value);
    /// @notice Emitted when an approval is set (for encrypted approvals)
    /// @param _owner The address of the token owner
    /// @param _spender The address of the spender
    event Approval(address indexed _owner, address indexed _spender);
    event Shield(address indexed from, uint256 amount);
    event Unshield(address indexed to, uint256 amount);
    event UnshieldRequested(address indexed to, uint256 amount);
    event UnshieldFailed(address indexed to, uint256 amount);
    event MasterUpdated(address indexed oldMaster, address indexed newMaster);
    event EmergencyRecovery(address indexed owner, uint256 amount);
    event NativeRecovered(address indexed to, uint256 amount);
    event TrustedForwarderUpdated(address indexed oldForwarder, address indexed newForwarder);
    
    // OPRF Minting Events
    event OPRFMinted(address indexed user, gtUint128 x, gtUint128 y, gtUint256 q);
    
    // OPRF Split Events
    event OPRFSplit(address indexed user, gtUint128 xrRemainder, gtUint256 qRemainder, gtUint128 yRemainder, gtUint128 xrPay, gtUint256 qPay, gtUint128 yPay);
    event OPRFSplitForRecipient(address indexed user, address indexed recipient, gtUint128 xrRemainder, gtUint256 qRemainder, gtUint128 yRemainder, gtUint128 xrPay, gtUint256 qPay, gtUint128 yPay);
    
    // OPRF Merge Events
    event OPRFMerged(address indexed user, gtUint128 xrMerged, gtUint256 qMerged, gtUint128 yMerged);
    
    // OPRF Transfer/Burn Events
    event OPRFTransferred(address indexed sender, address indexed recipient, gtUint256 amount);
    event OPRFBurned(address indexed user, address indexed recipient, gtUint256 burnedAmount);
    
    // Token Invalidation Events (using encrypted handles instead of IDs)
    // Reason codes: 1=split, 2=merged, 3=burned
    event OPRFTokenInvalidated(address indexed user, gtUint128 x, gtUint256 q, uint128 y, uint8 reason);
    
    // PrivateERC20Contract256Storage, UnshieldRequest and OPRFToken live in libraries/PrivateERC20GaslessStorage.sol
    // (same ERC-7201 slot and layout) so the linked PrivateOPRFNotes library shares them.

    /// @custom:storage-location erc7201:bubble.storage.PrivateERC20Contract256Gasless
    struct GaslessStorage {
        address trustedForwarder;
    }

    /// keccak256(abi.encode(uint256(keccak256("bubble.storage.PrivateERC20Contract256Gasless")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant GaslessStorageLocation = 0x38e7adbcbe191d7f1929993d33efe57b08508e3833304253c54c257eaf22b600;

    function _getGaslessStorage() private pure returns (GaslessStorage storage $) {
        assembly {
            $.slot := GaslessStorageLocation
        }
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ---------------------------------------------------------------------------------------------
    // ERC-2771 context
    // ---------------------------------------------------------------------------------------------

    /// @notice The forwarder whose calls carry the signer as the last 20 bytes of calldata.
    function trustedForwarder() public view returns (address) {
        return _getGaslessStorage().trustedForwarder;
    }

    function isTrustedForwarder(address forwarder) public view returns (bool) {
        return forwarder != address(0) && forwarder == trustedForwarder();
    }

    /// @notice Sets the gasless forwarder. Zero disables gasless calls.
    function setTrustedForwarder(address forwarder) external onlyOwner {
        require(forwarder != address(this), "Forwarder cannot be token");
        GaslessStorage storage $g = _getGaslessStorage();
        emit TrustedForwarderUpdated($g.trustedForwarder, forwarder);
        $g.trustedForwarder = forwarder;
    }

    function _isForwarded() private view returns (bool) {
        return isTrustedForwarder(msg.sender) && msg.data.length >= 20;
    }

    function _msgSender() internal view override returns (address) {
        if (_isForwarded()) {
            return address(bytes20(msg.data[msg.data.length - 20:]));
        }
        return msg.sender;
    }

    function _msgData() internal view override returns (bytes calldata) {
        if (_isForwarded()) {
            return msg.data[:msg.data.length - 20];
        }
        return msg.data;
    }

    function _contextSuffixLength() internal view override returns (uint256) {
        return _isForwarded() ? 20 : 0;
    }

    /// @dev Who chose an OPRF op's arguments: the signer on a forwarded call, otherwise `tx.origin`
    ///      (the owner EOA, also when executing through its Safe). On a direct call, any contract the user
    ///      transacts with in that transaction acts with the user's authority over note destinations.
    ///      Facilitator relays stay closed: `tx.origin` is the facilitator, not the user.
    function _authorizer() private view returns (address) {
        return _isForwarded() ? _msgSender() : tx.origin;
    }

    /// @dev Admin functions are never authorized by a forwarded signature.
    function _checkOwner() internal view override {
        if (owner() != msg.sender) {
            revert OwnableUnauthorizedAccount(msg.sender);
        }
    }

    function acceptOwnership() public override {
        require(!_isForwarded(), "Not via forwarder");
        super.acceptOwnership();
    }

    /// @notice Consumes the signer's GCACL transient insert grant so this token may validate the signer's
    ///         ciphertexts for the rest of the transaction. Only the forwarder calls this, right before the
    ///         forwarded operation.
    function consumeInsertGrant(uint256 insertNonce, bytes calldata insertSignature) external {
        require(_isForwarded(), "Only forwarder");
        MpcCore.transientInsertPermission(_msgSender(), insertNonce, insertSignature);
    }

    /// @dev Value ciphertexts must belong to the caller: the signer on a forwarded call, or the direct caller /
    ///      `tx.origin` (an owner EOA executing through its Safe). The `tx.origin` arm is the same phishing class
    ///      as `_authorizer`: a contract the user calls in that transaction can pass the user's public IT into
    ///      `approve` or `transfer` and receive decrypt permission. A stranger cannot. Facilitator relays do not
    ///      take this arm, because the call is forwarded and `tx.origin` is the facilitator.
    function _validateOwnIt(itUint256 memory it) private returns (gtUint256) {
        require(
            it.userAddress == _msgSender() || (!_isForwarded() && it.userAddress == tx.origin),
            "IT not owned by caller"
        );
        return MpcCore.validateCiphertext(it);
    }

    /// @dev Raw-handle entrypoints: `account` (the real caller or the signer) must already hold rights on `value`.
    function _requireHandlePermitted(gtUint256 value, address account) private view {
        require(MpcCore.isPermitted(value, account), "Handle not permitted");
    }

    /// @notice Initializes the token contract, assigning the contract owner and setting the underlying ERC20 token
    /// @param name_ The name of the token
    /// @param symbol_ The symbol of the token
    /// @param underlying_ The address of the underlying ERC20 token
    /// @param owner_ The address that will own the token
    /// @param master_ The master address for unshield operations
    function initialize(
        string memory name_,
        string memory symbol_,
        address underlying_,
        address owner_,
        address master_
    ) public initializer {
        _initialize(name_, symbol_, underlying_, owner_, master_, false);
    }

    /// @notice Initializes the token contract with wrapped-native configuration.
    function initialize(
        string memory name_,
        string memory symbol_,
        address underlying_,
        address owner_,
        address master_,
        bool underlyingIsWrappedNative_
    ) public initializer {
        _initialize(name_, symbol_, underlying_, owner_, master_, underlyingIsWrappedNative_);
    }

    /// @notice Initializes the token contract with wrapped-native configuration.
    function initializeWithWrappedNative(
        string memory name_,
        string memory symbol_,
        address underlying_,
        address owner_,
        address master_,
        bool underlyingIsWrappedNative_
    ) public initializer {
        _initialize(name_, symbol_, underlying_, owner_, master_, underlyingIsWrappedNative_);
    }

    function _initialize(
        string memory name_,
        string memory symbol_,
        address underlying_,
        address owner_,
        address master_,
        bool underlyingIsWrappedNative_
    ) internal {
        require(underlying_ != address(0), "Underlying cannot be zero address");
        require(owner_ != address(0), "Owner cannot be zero address");
        require(master_ != address(0), "Master cannot be zero address");
        
        __Ownable_init(owner_);
        __ReentrancyGuard_init();
        __Pausable_init();
        
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        $._name = name_;
        $._symbol = symbol_;
        $.master = master_;
        $.underlying = IERC20(underlying_);
        $.underlyingIsWrappedNative = underlyingIsWrappedNative_;
        $.underlyingDecimals = IERC20Metadata(underlying_).decimals();
        $.zero = MpcCore.setPublic256(0);
        // Permit the contract to use the zero handle
        MpcCore.permitThis($.zero);
        
        // Initialize OPRF key using MPC's secure random generation
        $._oprfKey = MpcCore.rand128();
        MpcCore.permitThis($._oprfKey);
    }

    receive() external payable {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        require($.underlyingIsWrappedNative && msg.sender == address($.underlying), "Unexpected native sender");
    }
    
    /**
     * @dev Returns the PrivateERC20Contract256Storage storage location.
     */
    function _getPrivateERC20Contract256Storage() internal pure returns (PrivateERC20Contract256Storage storage $) {
        return privateERC20Storage();
    }
    
    /**
     * @dev Should revert when `msg.sender` is not authorized to upgrade the contract.
     */
    function _authorizeUpgrade(address _newImplementation) internal virtual override onlyOwner {}
    /// @notice Returns the name of the token
    /// @return The token name
    function name() public view returns (string memory) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        return $._name;
    }
    /// @notice Returns the symbol of the token
    /// @return The token symbol
    function symbol() public view returns (string memory) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        return $._symbol;
    }
    /// @notice Returns the number of decimals used to get its user representation
    /// @return The number of decimals
    function decimals() public view returns (uint8) {
        return _getUnderlyingDecimals();
    }
    /// @notice Returns the total supply of tokens
    /// @return The total supply
    function totalSupply() public view returns (uint256) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        return $._totalSupply;
    }
    /// @notice Returns the master address (receives unshielded tokens)
    /// @return The master address
    function master() public view returns (address) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        return $.master;
    }

    /// @notice Returns the address of the underlying ERC20 token
    /// @return The underlying token address
    function underlying() public view returns (address) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        return address($.underlying);
    }

    /// @notice Returns whether underlying token is configured as wrapped-native (WETH/WPOL style).
    function underlyingIsWrappedNative() public view returns (bool) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        return $.underlyingIsWrappedNative;
    }

    /// @notice Returns the decrypt ID of the most recently created decryption request (e.g. from unshield).
    /// @dev Used by off-chain tests and relayers to fetch callback tx_data via GetDecryption and submit the callback.
    /// @return The decrypt ID, or 0 if no request has been made yet.
    function getLastDecryptRequestId() external view returns (uint256) {
        return decryptCounter > 0 ? decryptCounter - 1 : 0;
    }
    
    /// @notice Updates the master address (receives unshielded tokens)
    /// @param newMaster The new master address
    /// @dev Only the owner can call this function
    /// @dev The new master address cannot be the zero address
    function setMaster(address newMaster) external onlyOwner {
        require(newMaster != address(0), "Master cannot be zero address");
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        address oldMaster = $.master;
        $.master = newMaster;
        emit MasterUpdated(oldMaster, newMaster);
    }

    /// @notice Pauses user-facing token operations.
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resumes user-facing token operations.
    function unpause() external onlyOwner {
        _unpause();
    }
    
    /// @notice Emergency recovery function to transfer all underlying tokens to the owner
    /// @dev Only the owner can call this function
    /// @dev This function pauses the contract, transfers all underlying ERC20 tokens held by the contract
    ///      to the owner, and resets totalSupply to zero.
    /// @dev Use this function only in emergency situations
    /// @return The amount of tokens recovered
    function emergencyRecovery() external onlyOwner nonReentrant returns (uint256) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        if (!paused()) {
            _pause();
        }

        address ownerAddress = owner();
        uint256 balance = $.underlying.balanceOf(address(this));
        
        if (balance > 0) {
            require($.underlying.transfer(ownerAddress, balance), "Transfer failed");
            emit EmergencyRecovery(ownerAddress, balance);
        }

        $._totalSupply = 0;
        
        return balance;
    }

    /// @notice Recovers accidental native-token dust sent to the contract.
    /// @dev Only owner can recover. Intended for operational cleanup.
    /// @param to Recipient of recovered native tokens.
    /// @param amount Amount to recover; set to 0 to recover full balance.
    /// @return recoveredAmount The recovered native-token amount.
    function recoverNative(address to, uint256 amount) external onlyOwner nonReentrant returns (uint256 recoveredAmount) {
        require(to != address(0), "Recipient cannot be zero address");
        uint256 nativeBalance = address(this).balance;
        recoveredAmount = amount == 0 ? nativeBalance : amount;
        require(recoveredAmount <= nativeBalance, "Insufficient native balance");
        (bool sent, ) = payable(to).call{value: recoveredAmount}("");
        require(sent, "Native transfer failed");
        emit NativeRecovered(to, recoveredAmount);
    }
    /// @notice Returns the handle of the caller's balance
    /// @dev The balance is returned as a handle that requires encryption and decryption under the user's secret key to get the actual value
    /// @return The balance handle
    function balanceOf() public view returns (gtUint256) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        return $.balances[_msgSender()];
    }

    /// @notice Returns the handle to the balance of the given address
    /// @dev The balance is returned as a handle that requires encryption and decryption under the user's secret key to get the actual value.
    /// Returns zero handle if balance is uninitialized, which can be used by clients to determine if decryption is needed.
    /// @param add The address to get the balance from
    /// @return The balance handle (zero if uninitialized)
    function balanceOf(address add) public view returns (gtUint256) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        return $.balances[add];
    }

    /// @notice Returns the handle to the balance of the given address
    /// @dev The balance is returned as a handle that requires encryption and decryption under the user's secret key to get the actual value
    /// @param add The address to get the balance from
    /// @return The balance handle
    function _balanceOf(address add) private view returns (gtUint256) {
        return privateBalanceOf(add);
    }

    // ---------------------------------------------------------------------------------------------
    // User entrypoints. Each one is a thin wrapper that passes the real caller to the internal
    // implementation; on a forwarded call `_msgSender()` is the signer.
    // ---------------------------------------------------------------------------------------------

    /// @notice Transfers tokens using an encrypted and signed value
    /// @param _to The address to transfer to
    /// @param _it The encrypted and signed transfer amount
    /// @return The handle to the transfer's result
    function transfer(address _to, itUint256 memory _it) public virtual whenNotPaused returns (gtBool) {
        return _contractTransfer(_msgSender(), _to, _validateOwnIt(_it));
    }

    /// @notice Transfers tokens using a clear value
    /// @param _to The address to transfer to
    /// @param _value The amount of tokens to transfer
    /// @return The handle to the transfer's result
    function transfer(address _to, uint256 _value) public virtual whenNotPaused returns (gtBool) {
        return _transferClear(_msgSender(), _to, _value);
    }

    /// @notice Transfers the amount of tokens given in the handle _value to address _to
    /// @param _to The address to transfer to
    /// @param _value The handle to the amount of tokens to transfer
    /// @return The handle to the transfer's result
    function contractTransfer(address _to, gtUint256 _value) public virtual whenNotPaused returns (gtBool) {
        _requireHandlePermitted(_value, _msgSender());
        return _contractTransfer(_msgSender(), _to, _value);
    }

    /// @notice Transfers the amount of tokens given inside the IT (an encrypted and signed value) from one address to another
    /// @param _from The address to transfer from
    /// @param _to The address to transfer to
    /// @param _it The encrypted and signed transfer amount
    /// @return The handle to the transfer's result
    function transferFrom(address _from, address _to, itUint256 memory _it) public virtual whenNotPaused returns (gtBool) {
        return _contractTransferFrom(_msgSender(), _from, _to, _validateOwnIt(_it));
    }

    /// @notice Transfers the amount of tokens given in the clear from one address to another
    /// @param _from The address to transfer from
    /// @param _to The address to transfer to
    /// @param _value The amount of tokens to transfer
    /// @return The handle to the transfer's result
    function transferFrom(address _from, address _to, uint256 _value) public virtual whenNotPaused returns (gtBool) {
        return _transferFromClear(_msgSender(), _from, _to, _value);
    }

    /// @notice Transfers the amount of tokens given in the handle from one address to another
    /// @param _from The address to transfer from
    /// @param _to The address to transfer to
    /// @param _value The encrypted transfer amount
    /// @return The handle to the transfer's result
    function contractTransferFrom(address _from, address _to, gtUint256 _value) public virtual whenNotPaused returns (gtBool) {
        _requireHandlePermitted(_value, _msgSender());
        return _contractTransferFrom(_msgSender(), _from, _to, _value);
    }

    /// @notice Approves a spender to transfer the amount of tokens given inside the IT (an encrypted and signed value)
    /// @param _spender The address that will be approved
    /// @param _it The encrypted and signed approval amount
    /// @return True if the approval was successful
    function approve(address _spender, itUint256 memory _it) public virtual whenNotPaused returns (bool) {
        return _contractApprove(_msgSender(), _spender, _validateOwnIt(_it));
    }

    /// @notice Approves a spender to transfer the amount of tokens given in the clear
    /// @param _spender The address that will be approved
    /// @param _value The amount of tokens to approve
    /// @return True if the approval was successful
    function approve(address _spender, uint256 _value) public virtual whenNotPaused returns (bool) {
        return _approveClear(_msgSender(), _spender, _value);
    }

    /// @notice Approves a spender to transfer the amount of tokens given in the handle
    /// @param _spender The address that will be approved
    /// @param _value The handle to the approval amount
    /// @return True if the approval was successful
    function contractApprove(address _spender, gtUint256 _value) public virtual whenNotPaused returns (bool) {
        _requireHandlePermitted(_value, _msgSender());
        return _contractApprove(_msgSender(), _spender, _value);
    }

    /// @notice Returns the handle to the allowance of a spender
    /// @dev The returned handle requires encryption and decryption under the user's secret key to get the actual value
    /// @param _owner The address of the token owner
    /// @param _spender The address of the spender
    /// @return The allowance handle
    function allowance(address _owner, address _spender) public view returns (gtUint256) {
        require(_owner == _msgSender() || _spender == _msgSender());
        return _getGTAllowance(_owner, _spender);
    }

    /// @notice Shield standard ERC20 tokens into private tokens
    /// @dev Private tokens mirror the underlying token decimals, so shielded amounts are one-to-one.
    function shield(uint256 amount) public virtual nonReentrant whenNotPaused returns (bool) {
        return _shield(_msgSender(), amount);
    }

    // Function to unshield private tokens back to standard ERC20 tokens
    function unshield(uint256 privateAmount) public virtual whenNotPaused returns (bool) {
        return _unshieldTo(_msgSender(), privateAmount, _msgSender());
    }

    // Function to unshield private tokens back to standard ERC20 tokens for master address
    function unshieldForMaster(uint256 privateAmount) public virtual whenNotPaused returns (bool) {
        return _unshieldTo(_msgSender(), privateAmount, _getPrivateERC20Contract256Storage().master);
    }

    /// @notice Mints an OPRF token for the caller using encrypted parameters.
    /// @param quantity The encrypted quantity/amount for the OPRF token
    function mintOPRFToken(itUint256 memory quantity) public virtual whenNotPaused {
        _mintOPRFToken(_msgSender(), quantity);
    }

    /// @notice Shields a clear amount of underlying and mints an OPRF note for that amount to the caller.
    function shieldAndMint(uint256 amount)
        public
        virtual
        nonReentrant
        whenNotPaused
        returns (gtUint128 x, gtUint128 y, gtUint256 q)
    {
        return _shieldAndMint(_msgSender(), amount, _msgSender());
    }

    /// @notice Shields a clear amount of underlying from the caller and mints the OPRF note to `recipient`.
    /// @dev The caller's private balance is unchanged. Underlying is escrowed here and this contract's private
    ///      balance increases by `amount`, which backs the note on a later burn.
    /// @param amount Clear underlying amount to pull, escrow, and mint. Must be greater than zero.
    /// @param recipient Account permitted to decrypt the new note.
    function shieldAndMint(uint256 amount, address recipient)
        public
        virtual
        nonReentrant
        whenNotPaused
        returns (gtUint128 x, gtUint128 y, gtUint256 q)
    {
        require(recipient != address(0), "Recipient cannot be zero address");
        return _shieldAndMint(_msgSender(), amount, recipient);
    }

    /// @notice Splits an OPRF token into remainder and payment portions using encrypted parameters
    /// @param x The encrypted x value from OPRF minting
    /// @param q The encrypted quantity from OPRF minting
    /// @param y_clear The clear (unencrypted) y value for splitting
    /// @param qSplit The encrypted amount to split off as payment
    function splitToken(
        itUint128 memory x,
        itUint256 memory q,
        uint128 y_clear,
        itUint256 memory qSplit
    ) public virtual whenNotPaused {
        PrivateOPRFNotes.splitToken(_msgSender(), _authorizer(), x, q, y_clear, qSplit);
    }

    /// @notice Splits an OPRF token for anonymous transfer to a recipient
    /// @dev Unless the IT owner authorized the call, `recipient` must be the IT owner.
    /// @param x The encrypted x coordinate of the OPRF token
    /// @param q The encrypted quantity/amount of the OPRF token
    /// @param y_clear The clear (unencrypted) y coordinate of the OPRF token
    /// @param qSplit The encrypted amount to split off as payment
    /// @param recipient The address of the recipient who will receive the split values
    function splitTokenForRecipient(
        itUint128 memory x,
        itUint256 memory q,
        uint128 y_clear,
        itUint256 memory qSplit,
        address recipient
    ) public virtual whenNotPaused {
        PrivateOPRFNotes.splitTokenForRecipient(_msgSender(), _authorizer(), x, q, y_clear, qSplit, recipient);
    }

    /// @notice Burns an OPRF token and transfers the burned amount to recipient
    /// @dev Unless the IT owner authorized the call, `recipient` must be the IT owner.
    /// @param x The encrypted x value from OPRF minting or split
    /// @param q The encrypted quantity from OPRF minting or split
    /// @param y_clear The clear (unencrypted) y value for burning
    /// @param recipient The address to receive the burned tokens
    function burnToken(
        itUint128 memory x,
        itUint256 memory q,
        uint128 y_clear,
        address recipient
    ) public virtual whenNotPaused {
        PrivateOPRFNotes.burnToken(_msgSender(), _authorizer(), x, q, y_clear, recipient);
    }

    /// @notice Merges multiple OPRF tokens by burning them all and creating a new token with the total amount
    /// @param tokens Array of OPRF token parameters to merge
    function mergeMany(
        OPRFToken[] memory tokens
    ) public virtual whenNotPaused returns (gtUint128 x, gtUint128 y, gtUint256 qMerged) {
        return PrivateOPRFNotes.mergeMany(_msgSender(), _authorizer(), tokens);
    }

    /// @notice Transfers OPRF tokens to a recipient by burning input tokens and minting new tokens
    /// @dev Unless the IT owner authorized the call, `recipient` must be the IT owner.
    /// @param tokens Array of OPRF token parameters to burn
    /// @param amount Encrypted amount to transfer to recipient
    /// @param recipient Address of the recipient who will receive the tokens
    function transferOPRF(
        OPRFToken[] memory tokens,
        itUint256 memory amount,
        address recipient
    ) public virtual whenNotPaused returns (
        gtUint128 xRecipient,
        gtUint128 yRecipient,
        gtUint256 qRecipient,
        gtUint128 xSender,
        gtUint128 ySender,
        gtUint256 qSender
    ) {
        return PrivateOPRFNotes.transferOPRF(_msgSender(), _authorizer(), tokens, amount, recipient);
    }

    /// @notice Redeems multiple OPRF tokens by burning them all, transferring the specified amount as private tokens to recipient, and minting a leftover OPRF token if there's a remainder
    /// @dev Unless the IT owner authorized the call, `recipient` must be the IT owner.
    /// @param tokens Array of OPRF token parameters to burn
    /// @param amount Encrypted amount to transfer to recipient as private tokens
    /// @param recipient Address of the recipient who will receive the private tokens
    function redeemMany(
        OPRFToken[] memory tokens,
        itUint256 memory amount,
        address recipient
    ) public virtual whenNotPaused returns (
        gtUint128 xRemainder,
        gtUint128 yRemainder,
        gtUint256 qRemainder
    ) {
        return PrivateOPRFNotes.redeemMany(_msgSender(), _authorizer(), tokens, amount, recipient);
    }

    /// @notice Redeems multiple OPRF tokens and directly unshields the redeemed amount to underlying tokens for recipient.
    /// @dev The redeemed amount never remains in recipient's private balance: it is credited and immediately debited before unshield callback.
    /// @dev Unless the IT owner authorized the call, `recipient` must be the IT owner.
    /// @param tokens Array of OPRF token parameters to burn
    /// @param amount Encrypted amount to redeem and unshield
    /// @param recipient Address receiving the underlying tokens after callback
    /// @param unwrap If true, unwrap wrapped-native underlying and send native token
    function redeemManyToUnderlying(
        OPRFToken[] memory tokens,
        itUint256 memory amount,
        address recipient,
        bool unwrap
    ) public virtual whenNotPaused returns (
        gtUint128 xRemainder,
        gtUint128 yRemainder,
        gtUint256 qRemainder
    ) {
        return _redeemManyToUnderlying(_msgSender(), _authorizer(), tokens, amount, recipient, unwrap);
    }

    // ---------------------------------------------------------------------------------------------
    // Internal implementations. `sender` is the account whose balance/allowance is used and who is
    // credited. For OPRF ops, `authorizer` is who chose the arguments: `tx.origin` on a direct call
    // (the owner EOA, also when executing through its Safe), or the signer on a forwarded call.
    // ---------------------------------------------------------------------------------------------

    function _transferClear(address sender, address _to, uint256 _value) private returns (gtBool) {
        if (sender == _to) {
            emit Transfer(sender, _to, _value);
            return MpcCore.setPublic(true);
        }

        (gtUint256 fromBalance, gtUint256 toBalance) = _getBalances(sender, _to);
        (gtUint256 newFromBalance, gtUint256 newToBalance, gtBool result) = MpcCore.transfer(fromBalance, toBalance, _value);
        _setNewBalances(sender, _to, newFromBalance, newToBalance);
        emit Transfer(sender, _to, _value);
        return result;
    }

    /// @dev `_value` must already be usable by this contract (validated IT or a handle `sender` was checked against).
    function _contractTransfer(address sender, address _to, gtUint256 _value) private returns (gtBool) {
        if (sender == _to) {
            gtBool hasSufficientBalance = MpcCore.ge(_balanceOf(sender), _value);
            _permitAndEmitPrivateTransfer(sender, _to, _value, MpcCore.not(hasSufficientBalance));
            return MpcCore.setPublic(true);
        }

        (gtUint256 fromBalance, gtUint256 toBalance) = _getBalances(sender, _to);
        (gtUint256 newFromBalance, gtUint256 newToBalance, gtBool result) = MpcCore.transfer(fromBalance, toBalance, _value);
        _setNewBalances(sender, _to, newFromBalance, newToBalance);
        _permitAndEmitPrivateTransfer(sender, _to, _value, MpcCore.not(result));
        return result;
    }

    function _transferFromClear(address spender, address _from, address _to, uint256 _value) private returns (gtBool) {
        gtUint256 allowance_ = _getGTAllowance(_from, spender);

        if (_from == _to) {
            // Still check allowance for self-transfers to maintain ERC20 compliance
            gtUint256 valueGt = MpcCore.setPublic256(_value);
            MpcCore.permitThis(valueGt);
            gtBool hasSufficientAllowance = MpcCore.ge(allowance_, valueGt);
            emit Transfer(_from, _to, _value);
            return hasSufficientAllowance;
        }

        (gtUint256 fromBalance, gtUint256 toBalance) = _getBalances(_from, _to);
        (gtUint256 newFromBalance, gtUint256 newToBalance, gtBool result, gtUint256 newAllowance) = MpcCore.transferWithAllowance(fromBalance, toBalance, _value, allowance_);
        _setApproveValue(_from, spender, newAllowance);
        _setNewBalances(_from, _to, newFromBalance, newToBalance);
        emit Transfer(_from, _to, _value);
        return result;
    }

    function _contractTransferFrom(address spender, address _from, address _to, gtUint256 _value) private returns (gtBool) {
        gtUint256 allowance_ = _getGTAllowance(_from, spender);

        if (_from == _to) {
            gtBool hasSufficientAllowance = MpcCore.ge(allowance_, _value);
            _permitAndEmitPrivateTransfer(_from, _to, _value, MpcCore.not(hasSufficientAllowance));
            return hasSufficientAllowance;
        }

        (gtUint256 fromBalance, gtUint256 toBalance) = _getBalances(_from, _to);
        (gtUint256 newFromBalance, gtUint256 newToBalance, gtBool result, gtUint256 newAllowance) = MpcCore.transferWithAllowance(fromBalance, toBalance, _value, allowance_);
        _setApproveValue(_from, spender, newAllowance);
        _setNewBalances(_from, _to, newFromBalance, newToBalance);
        _permitAndEmitPrivateTransfer(_from, _to, _value, MpcCore.not(result));
        return result;
    }

    function _approveClear(address owner_, address _spender, uint256 _value) private returns (bool) {
        _setApproveValue(owner_, _spender, MpcCore.setPublic256(_value));
        emit Approval(owner_, _spender, _value);
        return true;
    }

    function _contractApprove(address owner_, address _spender, gtUint256 _value) private returns (bool) {
        _setApproveValue(owner_, _spender, _value);
        emit Approval(owner_, _spender);
        return true;
    }

    function _shield(address sender, uint256 amount) private returns (bool) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        require(amount > 0, "Amount must be greater than 0");
        require($.underlying.transferFrom(sender, address(this), amount), "Transfer failed");
        gtUint256 newBalanceGt = MpcCore.add(_balanceOf(sender), MpcCore.setPublic256(amount));
        $.balances[sender] = newBalanceGt;
        $._totalSupply += amount;
        // Permit the contract and the user to use the new balance handle
        MpcCore.permitThis(newBalanceGt);
        MpcCore.permit(newBalanceGt, sender);
        emit Shield(sender, amount);
        return true;
    }

    function _unshieldTo(address sender, uint256 privateAmount, address recipient) private returns (bool) {
        require(privateAmount > 0, "Amount must be greater than 0");
        gtUint256 amountGt = MpcCore.setPublic256(privateAmount);

        // user balance = 10, want to unshield 3. checkedSubWithOverflowBit(10, 3) = 7, amount to unshield = bal before 10 sub new balance 7 = 3
        // user balance = 5, want to unshield 7. checkedSubWithOverflowBit(5, 7) = 5, amount to unshield = bal before 5 sub new balance 5 = 0
        gtUint256 amountToUnshieldGt = _debitBalanceForUnshield(sender, amountGt);

        _requestUnshieldFromHandle(amountToUnshieldGt, recipient, false);

        emit UnshieldRequested(recipient, privateAmount);
        return true;
    }

    /// @dev The note amount is the transfer result: the full quantity, or zero if the pull did not
    ///      credit the contract. That is the same mask `PrivateTransfer` already emits.
    function _mintOPRFToken(address minter, itUint256 memory quantity) private {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        gtUint256 qGT = _validateOwnIt(quantity);
        gtBool moved = _contractTransfer(minter, address(this), qGT);

        // mux(bit, a, b) returns b when bit is true. not(moved) is true when the pull failed.
        gtUint256 mintedAmount = MpcCore.mux(MpcCore.not(moved), qGT, $.zero);
        MpcCore.permitThis(mintedAmount);

        (gtUint128 x, gtUint128 y) = MpcCore.oprfMint($._oprfKey, mintedAmount);

        MpcCore.permit(x, minter);
        MpcCore.permit(y, minter);
        MpcCore.permit(mintedAmount, minter);

        emit OPRFMinted(minter, x, y, mintedAmount);
    }

    function _shieldAndMint(address sender, uint256 amount, address recipient)
        private
        returns (gtUint128 x, gtUint128 y, gtUint256 q)
    {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        require(amount > 0, "Amount must be greater than 0");
        require($.underlying.transferFrom(sender, address(this), amount), "Transfer failed");
        $._totalSupply += amount;

        gtUint256 amountGt = MpcCore.setPublic256(amount);
        MpcCore.permitThis(amountGt);

        gtUint256 newContractBalanceGt = MpcCore.add(_balanceOf(address(this)), amountGt);
        $.balances[address(this)] = newContractBalanceGt;
        MpcCore.permitThis(newContractBalanceGt);

        (x, y) = MpcCore.oprfMint($._oprfKey, amountGt);
        MpcCore.permit(x, recipient);
        MpcCore.permit(y, recipient);
        MpcCore.permit(amountGt, recipient);
        q = amountGt;

        emit Shield(sender, amount);
        emit OPRFMinted(recipient, x, y, q);
    }

    function _redeemManyToUnderlying(
        address sender,
        address authorizer,
        OPRFToken[] memory tokens,
        itUint256 memory amount,
        address recipient,
        bool unwrap
    ) private returns (gtUint128 x, gtUint128 y, gtUint256 q) {
        if (unwrap) {
            require(_getPrivateERC20Contract256Storage().underlyingIsWrappedNative, "Underlying unwrap not configured");
        }
        gtUint256 amountToUnshieldGt;
        (x, y, q, amountToUnshieldGt) =
            PrivateOPRFNotes.redeemManyToUnderlying(sender, authorizer, tokens, amount, recipient);
        _requestUnshieldFromHandle(amountToUnshieldGt, recipient, unwrap);
    }

    // ---------------------------------------------------------------------------------------------
    // Balance / allowance / unshield helpers
    // ---------------------------------------------------------------------------------------------

    /// @notice Returns the handles to the balances of two addresses
    function _getBalances(address _from, address _to) private view returns (gtUint256, gtUint256) {
        return (_balanceOf(_from), _balanceOf(_to));
    }

    /// @notice Sets the new balances handles for two addresses
    function _setNewBalances(address _from, address _to, gtUint256 newFromBalance, gtUint256 newToBalance) private {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        // Store the new balances handles in the mapping
        $.balances[_from] = newFromBalance;
        $.balances[_to] = newToBalance;
        // Permit the contract and the _from user to use the balance handle
        MpcCore.permitThis(newFromBalance);
        MpcCore.permit(newFromBalance, _from);
        // Permit the contract and the _to to use the balance handle
        MpcCore.permitThis(newToBalance);
        MpcCore.permit(newToBalance, _to);
    }

    /// @notice Emits PrivateTransfer and grants both parties permission to decrypt the credited amount.
    /// @dev The emitted amount is `amount`, or zero when `failed` is true. `MpcCore.mux(bit, a, b)` returns `b` when
    ///      `bit` is true, so callers pass the negated success bit (e.g. `not(result)` of the transfer).
    function _permitAndEmitPrivateTransfer(address from, address to, gtUint256 amount, gtBool failed) private {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        gtUint256 transferredAmount = MpcCore.mux(failed, amount, $.zero);
        MpcCore.permit(transferredAmount, to);
        MpcCore.permit(transferredAmount, from);
        emit PrivateTransfer(from, to, transferredAmount);
    }

    /// @notice Returns the handle to the allowance of a spender
    function _getGTAllowance(address _owner, address _spender) private view returns (gtUint256) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        if (gtUint256.unwrap($.allowances[_owner][_spender]) == 0) {
            return $.zero;
        } else {
            return $.allowances[_owner][_spender];
        }
    }

    /// @notice Sets the new handle to the allowance for a spender
    function _setApproveValue(address _owner, address _spender, gtUint256 _value) private {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        $.allowances[_owner][_spender] = _value;
        // Permit the contract and the _owner user to use the allowance handle
        MpcCore.permitThis(_value);
        MpcCore.permit(_value, _owner);
    }

    /// @notice Returns the underlying token decimals captured during initialization.
    function _getUnderlyingDecimals() private view returns (uint8) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        return $.underlyingDecimals;
    }

    function _debitBalanceForUnshield(
        address account,
        gtUint256 amount
    ) private returns (gtUint256 amountToUnshieldGt) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();

        gtUint256 balanceBefore = _balanceOf(account);
        (, gtUint256 balanceAfter) = MpcCore.checkedSubWithOverflowBit(balanceBefore, amount);
        (, amountToUnshieldGt) = MpcCore.checkedSubWithOverflowBit(balanceBefore, balanceAfter);

        MpcCore.permitThis(amountToUnshieldGt);
        MpcCore.permitThis(balanceAfter);
        MpcCore.permit(balanceAfter, account);
        $.balances[account] = balanceAfter;
    }

    /// @notice Requests unshielding for an encrypted private-token amount handle.
    /// @param amountToUnshieldGt The encrypted private-token amount to decrypt and unshield.
    /// @param recipient Recipient of the underlying token transfer in callback.
    /// @param unwrapNative If true, unwrap wrapped-native token and send native token.
    function _requestUnshieldFromHandle(gtUint256 amountToUnshieldGt, address recipient, bool unwrapNative) internal {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();

        uint256[] memory handles = new uint256[](1);
        handles[0] = gtUint256.unwrap(amountToUnshieldGt);

        $.unshieldRequests[decryptCounter] = UnshieldRequest({
            user: recipient,
            unwrapNative: unwrapNative
        });

        requestDecryption(handles, this.callbackUnshield.selector);
    }

    function callbackUnshield(uint256 decryptID, bytes[] calldata output, bytes[] calldata signatures) public nonReentrant verifyCallback(decryptID, output, signatures) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        UnshieldRequest storage request = $.unshieldRequests[decryptID];
        require(request.user != address(0), "Invalid request ID");

        // output[0] contains the private amount to unshield, denominated like the underlying token.
        uint256 privateAmountToUnshield = abi.decode(output[0], (uint256));
        if (privateAmountToUnshield > 0) {
            $._totalSupply -= privateAmountToUnshield;
            if (request.unwrapNative) {
                require($.underlyingIsWrappedNative, "Underlying unwrap not configured");
                IWrappedNative(address($.underlying)).withdraw(privateAmountToUnshield);
                (bool sent, ) = payable(request.user).call{value: privateAmountToUnshield}("");
                require(sent, "Native transfer failed");
            } else {
                require($.underlying.transfer(request.user, privateAmountToUnshield), "Transfer failed");
            }
            emit Unshield(request.user, privateAmountToUnshield);
        } else {
            emit UnshieldFailed(request.user, privateAmountToUnshield);
        }

        // Clean up the request
        delete $.unshieldRequests[decryptID];
    }
}
