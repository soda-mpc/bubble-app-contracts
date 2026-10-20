// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import "@sodalabs/bubble-core-contracts/contracts/bubble/MpcCore.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/token/ERC20/utils/SafeERC20.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@sodalabs/bubble-core-contracts/contracts/bubble/DecryptionCaller.sol";
import {IPrivateERC20Gasless, OPRFToken} from "./interfaces/IPrivateERC20Gasless.sol";
import {IPrivateERC20GaslessForwarder} from "./interfaces/IPrivateERC20GaslessForwarder.sol";
import {IWrappedNative} from "./interfaces/IWrappedNative.sol";
import {PrivateERC20GaslessStorage, UnshieldRequest, gaslessStorage} from "./libraries/PrivateERC20GaslessStorage.sol";
import {PrivateLedger} from "./libraries/PrivateLedger.sol";
import {PrivateOPRFNotes} from "./libraries/PrivateOPRFNotes.sol";

/// @title PrivateERC20Contract256Gasless
/// @notice Private token backed 1:1 by an underlying ERC20, with ERC20-like operations over MPC-encrypted values.
/// @dev Not an ERC20: balances, allowances and transfer results are MPC handles (`gtUint256` / `gtBool`), so
///      integrations decrypt them through the Bubble proxy. Clear-amount overloads exist for convenience.
///      Deployed behind a UUPS proxy.
///
///      Layout:
///      - This contract: caller identity (ERC-2771), admin, entrypoints, and the underlying lifecycle
///        (shield, unshield requests and callbacks, parked claims, emergency recovery).
///      - PrivateLedger (internal): encrypted balance and allowance bookkeeping.
///      - PrivateOPRFNotes (linked): OPRF note issuance and spending. Only the IT owner can route a note's value
///        away from the IT owner.
///
///      Gasless calls: a trusted PrivateERC20GaslessForwarder verifies the user's EIP-712 authorization and calls the
///      normal entrypoints with the signer appended to calldata; `_msgSender()` returns it. Admin functions ignore
///      the forwarder.
contract PrivateERC20Contract256Gasless is
    IPrivateERC20Gasless,
    PrivateERC20GaslessStorage,
    DecryptionCaller,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable
{
    using SafeERC20 for IERC20;

    // The external API, events and OPRFToken live in interfaces/IPrivateERC20Gasless.sol. The storage Layout and
    // UnshieldRequest live in libraries/PrivateERC20GaslessStorage.sol, shared with PrivateLedger and PrivateOPRFNotes.

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    // ---------------------------------------------------------------------------------------------
    // ERC-2771 context
    // ---------------------------------------------------------------------------------------------

    /// @notice The forwarder whose calls carry the signer as the last 20 bytes of calldata.
    function trustedForwarder() public view returns (address) {
        return gaslessStorage().trustedForwarder;
    }

    function isTrustedForwarder(address forwarder) public view returns (bool) {
        return forwarder != address(0) && forwarder == trustedForwarder();
    }

    /// @notice Sets the gasless forwarder. Zero disables gasless calls.
    /// @dev The forwarder must be a contract bound to this token. An EOA would be trusted as
    ///      `_msgSender` and could append any signer to its calldata.
    function setTrustedForwarder(address forwarder) external onlyOwner {
        require(forwarder != address(this), "Forwarder cannot be token");
        if (forwarder != address(0)) {
            require(forwarder.code.length > 0, "Forwarder must be a contract");
            require(IPrivateERC20GaslessForwarder(forwarder).token() == address(this), "Forwarder token mismatch");
        }
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        emit TrustedForwarderUpdated($.trustedForwarder, forwarder);
        $.trustedForwarder = forwarder;
    }

    function _isForwarded() private view returns (bool) {
        return isTrustedForwarder(msg.sender) && msg.data.length >= 20;
    }

    /// @dev Only `_msgSender` is overridden: nothing here or in the bases reads `_msgData` or `_contextSuffixLength`.
    function _msgSender() internal view override returns (address) {
        if (_isForwarded()) {
            return address(bytes20(msg.data[msg.data.length - 20:]));
        }
        return msg.sender;
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
    /// @dev The grant stays live until the transaction ends, also for direct calls into this token after the
    ///      forwarded one. That is safe only because every ciphertext is held to one of two rules:
    ///      - balance and allowance ops validate through `_validateOwnIt`, which ties the IT to `_msgSender()`;
    ///      - note ops (`PrivateOPRFNotes`) accept any IT owner, but every IT in a call must share that owner,
    ///        and only a caller that is the owner may send the value or new notes anywhere but the owner.
    ///      Any new entrypoint that validates a ciphertext must keep one of the two.
    function consumeInsertGrant(uint256 insertNonce, bytes calldata insertSignature) external {
        require(_isForwarded(), "Only forwarder");
        MpcCore.transientInsertPermission(_msgSender(), insertNonce, insertSignature);
    }

    /// @dev Value ciphertexts must belong to the caller: the signer on a forwarded call, or the direct caller /
    ///      `tx.origin` (an owner EOA executing through its Safe). With the `tx.origin` arm, a contract the user
    ///      calls in that transaction can pass the user's public IT into `approve` or `transfer` and receive
    ///      decrypt permission. A stranger cannot. Facilitator relays do not
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

    /// @notice Initializes the token behind its proxy.
    /// @param name_ The name of the token
    /// @param symbol_ The symbol of the token
    /// @param underlying_ The address of the underlying ERC20 token
    /// @param owner_ The address that will own the token
    /// @param master_ The master address for unshield operations
    /// @param underlyingIsWrappedNative_ Whether the underlying unwraps to native token (WETH style)
    function initializeWithWrappedNative(
        string memory name_,
        string memory symbol_,
        address underlying_,
        address owner_,
        address master_,
        bool underlyingIsWrappedNative_
    ) public initializer {
        require(underlying_ != address(0), "Underlying cannot be zero address");
        require(owner_ != address(0), "Owner cannot be zero address");
        require(master_ != address(0), "Master cannot be zero address");
        
        __Ownable_init(owner_);
        __ReentrancyGuard_init();
        __Pausable_init();
        
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
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

    /// @notice Gas forwarded to the recipient of a native unshield payout. Enough for an EOA or a smart wallet's
    ///         `receive`, not for a recipient that does work on receipt (it gets the wrapped token instead).
    uint256 public constant NATIVE_PAYOUT_GAS = 50_000;

    receive() external payable {
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        require($.underlyingIsWrappedNative && msg.sender == address($.underlying), "Unexpected native sender");
    }
    
    /**
     * @dev Should revert when `msg.sender` is not authorized to upgrade the contract.
     */
    function _authorizeUpgrade(address _newImplementation) internal virtual override onlyOwner {}
    /// @notice Returns the name of the token
    /// @return The token name
    function name() public view returns (string memory) {
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        return $._name;
    }
    /// @notice Returns the symbol of the token
    /// @return The token symbol
    function symbol() public view returns (string memory) {
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        return $._symbol;
    }
    /// @notice Returns the number of decimals used to get its user representation
    /// @return The number of decimals
    function decimals() public view returns (uint8) {
        return gaslessStorage().underlyingDecimals;
    }
    /// @notice Returns the total supply of tokens
    /// @return The total supply
    function totalSupply() public view returns (uint256) {
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        return $._totalSupply;
    }
    /// @notice Returns the master address (receives unshielded tokens)
    /// @return The master address
    function master() public view returns (address) {
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        return $.master;
    }

    /// @notice Returns the address of the underlying ERC20 token
    /// @return The underlying token address
    function underlying() public view returns (address) {
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        return address($.underlying);
    }

    /// @notice Returns whether underlying token is configured as wrapped-native (WETH/WPOL style).
    function underlyingIsWrappedNative() public view returns (bool) {
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        return $.underlyingIsWrappedNative;
    }

    /// @notice Updates the master address (receives unshielded tokens)
    /// @param newMaster The new master address
    /// @dev Only the owner can call this function
    /// @dev The new master address cannot be the zero address
    /// @dev In-flight `unshieldForMaster` requests keep the master they were created with: the recipient is fixed
    ///      when the request is made. A rotation (for example after a compromise) does not redirect them, and a payout
    ///      parked for the old master stays claimable only by it.
    function setMaster(address newMaster) external onlyOwner {
        require(newMaster != address(0), "Master cannot be zero address");
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        address oldMaster = $.master;
        $.master = newMaster;
        emit MasterUpdated(oldMaster, newMaster);
    }

    /// @notice Pauses user-facing token operations.
    /// @dev Not a full freeze of outflows: `callbackUnshield` still settles requests made before the pause, and
    ///      `claimUnshielded` still pays parked payouts. Reverting the one-shot callback would strand the debited
    ///      balance. Only `emergencyRecovery` stops these payouts (it drops in-flight requests).
    function pause() external onlyOwner {
        _pause();
    }

    /// @notice Resumes user-facing token operations. A retired token stays paused.
    function unpause() external onlyOwner {
        require(!gaslessStorage().retired, "Token retired");
        _unpause();
    }

    /// @notice True after `emergencyRecovery`. A retired token never resumes; deploy a new one instead.
    function retired() external view returns (bool) {
        return gaslessStorage().retired;
    }
    
    /// @notice Retires the token and sends the unreserved underlying to the owner.
    /// @dev Encrypted balances, allowances and notes stay in storage but lose their backing, so the token is
    ///      paused for good: `unpause` reverts. Otherwise an old balance could unshield against a later deposit.
    ///      Underlying parked for `claimUnshielded` stays in the contract and can still be claimed. In-flight
    ///      unshield callbacks from before this call are dropped. Calling it again sweeps any later stray deposit.
    /// @return The amount of tokens recovered
    function emergencyRecovery() external onlyOwner nonReentrant returns (uint256) {
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        if (!paused()) {
            _pause();
        }

        address ownerAddress = owner();
        uint256 balance = $.underlying.balanceOf(address(this));
        uint256 reserved = $.claimableUnderlyingTotal;
        require(balance >= reserved, "Recovery would take claims");
        uint256 recoverable = balance - reserved;

        if (recoverable > 0) {
            $.underlying.safeTransfer(ownerAddress, recoverable);
        }

        $.retired = true;
        $._totalSupply = 0;
        $.unshieldEpoch += 1;
        emit EmergencyRecovery(ownerAddress, recoverable);

        return recoverable;
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
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        return $.balances[_msgSender()];
    }

    /// @notice Returns the handle to the balance of the given address
    /// @dev The balance is returned as a handle that requires encryption and decryption under the user's secret key to get the actual value.
    /// Returns zero handle if balance is uninitialized, which can be used by clients to determine if decryption is needed.
    /// @param add The address to get the balance from
    /// @return The balance handle (zero if uninitialized)
    function balanceOf(address add) public view returns (gtUint256) {
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        return $.balances[add];
    }

    // ---------------------------------------------------------------------------------------------
    // User entrypoints attribute the caller with `_msgSender()`: the signer on a forwarded call.
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
    /// @dev `Transfer` carries the requested `_value`. Whether it moved is only in the returned handle.
    function transfer(address _to, uint256 _value) public virtual whenNotPaused returns (gtBool) {
        address sender = _msgSender();
        gtBool result = PrivateLedger.move(sender, _to, _value);
        emit Transfer(sender, _to, _value);
        return result;
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
    /// @dev `Transfer` carries the requested `_value`. Whether it moved is only in the returned handle.
    function transferFrom(address _from, address _to, uint256 _value) public virtual whenNotPaused returns (gtBool) {
        gtBool result = PrivateLedger.moveWithAllowance(_msgSender(), _from, _to, _value);
        emit Transfer(_from, _to, _value);
        return result;
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
        address owner_ = _msgSender();
        PrivateLedger.setAllowance(owner_, _spender, _validateOwnIt(_it));
        emit Approval(owner_, _spender);
        return true;
    }

    /// @notice Approves a spender to transfer the amount of tokens given in the clear
    /// @param _spender The address that will be approved
    /// @param _value The amount of tokens to approve
    /// @return True if the approval was successful
    function approve(address _spender, uint256 _value) public virtual whenNotPaused returns (bool) {
        address owner_ = _msgSender();
        PrivateLedger.setAllowance(owner_, _spender, MpcCore.setPublic256(_value));
        emit Approval(owner_, _spender, _value);
        return true;
    }

    /// @notice Approves a spender to transfer the amount of tokens given in the handle
    /// @param _spender The address that will be approved
    /// @param _value The handle to the approval amount
    /// @return True if the approval was successful
    function contractApprove(address _spender, gtUint256 _value) public virtual whenNotPaused returns (bool) {
        address owner_ = _msgSender();
        _requireHandlePermitted(_value, owner_);
        PrivateLedger.setAllowance(owner_, _spender, _value);
        emit Approval(owner_, _spender);
        return true;
    }

    /// @notice Returns the handle to the allowance of a spender
    /// @dev The returned handle requires encryption and decryption under the user's secret key to get the actual value
    /// @param _owner The address of the token owner
    /// @param _spender The address of the spender
    /// @return The allowance handle
    /// @dev Not access-controlled: the handle is public state. Decrypting it needs a GCACL permit.
    function allowance(address _owner, address _spender) public view returns (gtUint256) {
        return PrivateLedger.allowanceOf(_owner, _spender);
    }

    /// @notice Shield standard ERC20 tokens into private tokens
    /// @dev Private tokens mirror the underlying token decimals, so shielded amounts are one-to-one.
    function shield(uint256 amount) public virtual nonReentrant whenNotPaused returns (bool) {
        address sender = _msgSender();
        _pullUnderlying(sender, amount);
        PrivateLedger.credit(sender, MpcCore.setPublic256(amount));
        emit Shield(sender, amount);
        return true;
    }

    // Function to unshield private tokens back to standard ERC20 tokens
    function unshield(uint256 privateAmount) public virtual whenNotPaused returns (bool) {
        return _unshieldTo(_msgSender(), privateAmount, _msgSender());
    }

    // Function to unshield private tokens back to standard ERC20 tokens for master address
    function unshieldForMaster(uint256 privateAmount) public virtual whenNotPaused returns (bool) {
        return _unshieldTo(_msgSender(), privateAmount, gaslessStorage().master);
    }

    /// @notice Mints an OPRF token for the caller using encrypted parameters.
    /// @param quantity The encrypted quantity/amount for the OPRF token
    /// @dev The note amount is the transfer result: the full quantity, or zero if the pull did not
    ///      credit the contract. That is the same mask `PrivateTransfer` already emits.
    function mintOPRFToken(itUint256 memory quantity) public virtual whenNotPaused {
        address minter = _msgSender();
        gtUint256 qGT = _validateOwnIt(quantity);
        gtUint256 mintedAmount = PrivateLedger.movedAmount(PrivateLedger.move(minter, address(this), qGT), qGT);
        // Permitted to this contract as the `PrivateTransfer` recipient.
        _permitAndEmitPrivateTransfer(minter, address(this), mintedAmount);

        PrivateOPRFNotes.issueNote(minter, mintedAmount);
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
        require(recipient != address(this), "Recipient cannot be token");
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
        PrivateOPRFNotes.splitToken(x, q, y_clear, qSplit);
    }

    /// @notice Splits an OPRF token for anonymous transfer to a recipient
    /// @dev Unless the caller (`_msgSender()`) is the IT owner, `recipient` must be the IT owner.
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
        PrivateOPRFNotes.splitTokenForRecipient(_msgSender(), x, q, y_clear, qSplit, recipient);
    }

    /// @notice Burns an OPRF token and transfers the burned amount to recipient
    /// @dev Unless the caller (`_msgSender()`) is the IT owner, `recipient` must be the IT owner.
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
        PrivateOPRFNotes.burnToken(_msgSender(), x, q, y_clear, recipient);
    }

    /// @notice Merges multiple OPRF tokens by burning them all and creating a new token with the total amount
    /// @param tokens Array of OPRF token parameters to merge
    function mergeMany(
        OPRFToken[] memory tokens
    ) public virtual whenNotPaused returns (gtUint128 x, gtUint128 y, gtUint256 qMerged) {
        return PrivateOPRFNotes.mergeMany(tokens);
    }

    /// @notice Transfers OPRF tokens to a recipient by burning input tokens and minting new tokens
    /// @dev Unless the caller (`_msgSender()`) is the IT owner, `recipient` must be the IT owner.
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
        return PrivateOPRFNotes.transferOPRF(_msgSender(), tokens, amount, recipient);
    }

    /// @notice Redeems multiple OPRF tokens by burning them all, transferring the specified amount as private tokens to recipient, and minting a leftover OPRF token if there's a remainder
    /// @dev Unless the caller (`_msgSender()`) is the IT owner, `recipient` must be the IT owner.
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
        return PrivateOPRFNotes.redeemMany(_msgSender(), tokens, amount, recipient);
    }

    /// @notice Redeems multiple OPRF tokens and directly unshields the redeemed amount to underlying tokens for recipient.
    /// @dev The redeemed amount is debited from the pool and unshielded; `recipient`'s private balance is never touched.
    /// @dev Unless the caller (`_msgSender()`) is the IT owner, `recipient` must be the IT owner.
    /// @param tokens Array of OPRF token parameters to burn
    /// @param amount Encrypted amount to redeem and unshield
    /// @param recipient Address receiving the underlying tokens after callback
    /// @param unwrap If true, unwrap wrapped-native underlying and send native token. The payout falls back to the
    ///        wrapped token when that does not go through: always with a WETH9-style `withdraw` (its 2300-gas
    ///        stipend cannot reach this proxy), and when `recipient` refuses native token or needs more than
    ///        `NATIVE_PAYOUT_GAS`.
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
        if (unwrap) {
            require(gaslessStorage().underlyingIsWrappedNative, "Underlying unwrap not configured");
        }
        gtUint256 amountToUnshieldGt;
        (xRemainder, yRemainder, qRemainder, amountToUnshieldGt) =
            PrivateOPRFNotes.redeemManyToUnderlying(_msgSender(), tokens, amount, recipient);
        uint256 decryptId = _requestUnshieldFromHandle(amountToUnshieldGt, recipient, unwrap);
        // The redeemed amount is encrypted, so the event carries 0; the callback's Unshield has the paid amount.
        emit UnshieldRequested(recipient, 0, decryptId);
    }

    // ---------------------------------------------------------------------------------------------
    // Internal implementations. `sender` is the account whose balance/allowance is used and who is
    // credited.
    // ---------------------------------------------------------------------------------------------

    /// @dev `_value` must already be usable by this contract (validated IT or a handle `sender` was checked against).
    function _contractTransfer(address sender, address _to, gtUint256 _value) private returns (gtBool) {
        gtBool result = PrivateLedger.move(sender, _to, _value);
        _permitAndEmitPrivateTransfer(sender, _to, PrivateLedger.movedAmount(result, _value));
        return result;
    }

    function _contractTransferFrom(address spender, address _from, address _to, gtUint256 _value) private returns (gtBool) {
        gtBool result = PrivateLedger.moveWithAllowance(spender, _from, _to, _value);
        _permitAndEmitPrivateTransfer(_from, _to, PrivateLedger.movedAmount(result, _value));
        return result;
    }

    /// @dev Pulls `amount` of underlying from `from` into this contract. The caller credits the private side.
    ///      Only standard-balance underlyings are supported: a fee-on-transfer token is rejected here, and a token
    ///      whose balances change without transfers (rebasing) breaks the 1:1 backing and must not be used.
    function _pullUnderlying(address from, uint256 amount) private {
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        require(amount > 0, "Amount must be greater than 0");
        uint256 balanceBefore = $.underlying.balanceOf(address(this));
        $.underlying.safeTransferFrom(from, address(this), amount);
        require($.underlying.balanceOf(address(this)) - balanceBefore == amount, "Fee-on-transfer not supported");
        $._totalSupply += amount;
    }

    function _unshieldTo(address sender, uint256 privateAmount, address recipient) private returns (bool) {
        require(privateAmount > 0, "Amount must be greater than 0");
        gtUint256 amountGt = MpcCore.setPublic256(privateAmount);

        gtUint256 amountToUnshieldGt = PrivateLedger.debitIfSufficient(sender, amountGt);

        uint256 decryptId = _requestUnshieldFromHandle(amountToUnshieldGt, recipient, false);

        emit UnshieldRequested(recipient, privateAmount, decryptId);
        return true;
    }

    function _shieldAndMint(address sender, uint256 amount, address recipient)
        private
        returns (gtUint128 x, gtUint128 y, gtUint256 q)
    {
        _pullUnderlying(sender, amount);

        gtUint256 amountGt = MpcCore.setPublic256(amount);
        MpcCore.permitThis(amountGt);

        // The pool's private balance backs the note until it is burned.
        PrivateLedger.credit(address(this), amountGt);
        emit Shield(sender, amount);

        q = amountGt;
        (x, y) = PrivateOPRFNotes.issueNote(recipient, q);
    }

    // ---------------------------------------------------------------------------------------------
    // Transfer event / unshield helpers
    // ---------------------------------------------------------------------------------------------

    /// @notice Emits PrivateTransfer and grants both parties permission to decrypt the credited amount.
    /// @param credited The amount that actually moved (`PrivateLedger.movedAmount`).
    function _permitAndEmitPrivateTransfer(address from, address to, gtUint256 credited) private {
        MpcCore.permit(credited, to);
        MpcCore.permit(credited, from);
        emit PrivateTransfer(from, to, credited);
    }

    /// @notice Requests unshielding for an encrypted private-token amount handle.
    /// @param amountToUnshieldGt The encrypted private-token amount to decrypt and unshield.
    /// @param recipient Recipient of the underlying token transfer in callback.
    /// @param unwrapNative If true, unwrap wrapped-native token and send native token.
    /// @return decryptId The decryption request ID; `callbackUnshield` receives it.
    function _requestUnshieldFromHandle(gtUint256 amountToUnshieldGt, address recipient, bool unwrapNative)
        private
        returns (uint256 decryptId)
    {
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();

        uint256[] memory handles = new uint256[](1);
        handles[0] = gtUint256.unwrap(amountToUnshieldGt);

        // The callback arrives in a later transaction, so recording the request after creating it is safe.
        decryptId = requestDecryption(handles, this.callbackUnshield.selector);
        $.unshieldRequests[decryptId] = UnshieldRequest({
            user: recipient,
            unwrapNative: unwrapNative,
            epoch: $.unshieldEpoch
        });
    }

    function callbackUnshield(uint256 decryptID, bytes[] calldata output, bytes[] calldata signatures) public nonReentrant verifyCallback(decryptID, output, signatures) {
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        UnshieldRequest storage request = $.unshieldRequests[decryptID];
        require(request.user != address(0), "Invalid request ID");

        // output[0] contains the private amount to unshield, denominated like the underlying token.
        uint256 privateAmountToUnshield = abi.decode(output[0], (uint256));
        address user = request.user;
        bool unwrapNative = request.unwrapNative;
        uint256 epoch = request.epoch;
        delete $.unshieldRequests[decryptID];

        // A stale epoch means recovery already swept the backing for this request and zeroed supply.
        if (epoch != $.unshieldEpoch || privateAmountToUnshield == 0) {
            emit UnshieldFailed(user, privateAmountToUnshield);
            return;
        }

        // Paid or parked, the amount leaves the private supply. Settle that before any external call.
        $._totalSupply -= privateAmountToUnshield;

        // `unwrapNative` was only stored when the underlying is wrapped-native (checked at request time). If the
        // native payout does not go through, pay the wrapped token instead; park only if that fails too.
        bool paid = unwrapNative && _tryPayNative(user, privateAmountToUnshield);
        if (!paid && !$.underlying.trySafeTransfer(user, privateAmountToUnshield)) {
            _parkFailedUnshield(user, privateAmountToUnshield);
            return;
        }
        emit Unshield(user, privateAmountToUnshield);
    }

    /// @dev Pays `amount` of the wrapped-native underlying to `to` as native token, or returns false with nothing
    ///      moved: the unwrap and the send run in one self-call, so any failure reverts both. That covers a
    ///      WETH9-style `withdraw` (its 2300-gas stipend cannot reach this proxy), a refusing `to`, and a `to` that
    ///      needs more than `NATIVE_PAYOUT_GAS`. The cap leaves the caller gas to pay the wrapped token or park.
    function _tryPayNative(address to, uint256 amount) private returns (bool) {
        try this.unwrapAndSend(to, amount) {
            return true;
        } catch {
            return false;
        }
    }

    /// @notice Internal step of the native unshield payout. Only this contract may call it.
    function unwrapAndSend(address to, uint256 amount) external {
        require(msg.sender == address(this), "Only self");
        IWrappedNative(address(gaslessStorage().underlying)).withdraw(amount);
        (bool sent, ) = payable(to).call{value: amount, gas: NATIVE_PAYOUT_GAS}("");
        require(sent, "Native send failed");
    }

    /// @notice Clear underlying parked for `account` after a failed unshield push.
    function claimableUnderlying(address account) external view returns (uint256) {
        return gaslessStorage().claimableUnderlying[account];
    }

    /// @notice Pulls underlying parked by a failed unshield push. `to` receives the ERC20.
    function claimUnshielded(address to) external nonReentrant {
        require(to != address(0), "Recipient cannot be zero address");
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        address account = _msgSender();
        uint256 amount = $.claimableUnderlying[account];
        require(amount > 0, "Nothing to claim");
        $.claimableUnderlying[account] = 0;
        $.claimableUnderlyingTotal -= amount;
        $.underlying.safeTransfer(to, amount);
        emit UnshieldClaimed(account, to, amount);
    }

    /// @dev The private balance was already debited. Keep the underlying in this contract and let the user pull it,
    ///      instead of reverting the callback and leaving the request stuck.
    function _parkFailedUnshield(address user, uint256 amount) private {
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        $.claimableUnderlying[user] += amount;
        $.claimableUnderlyingTotal += amount;
        emit UnshieldParked(user, amount);
    }
}
