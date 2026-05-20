// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import "@sodalabs/bubble-core-contracts/contracts/bubble/MpcCore.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "@sodalabs/bubble-core-contracts/contracts/bubble/DecryptionCaller.sol";

interface IWrappedNative is IERC20 {
    function withdraw(uint256 wad) external;
}
/// @title PrivateERC20Contract
/// @notice Implementation of ERC20 token standard with enhanced privacy features using MPC
/// @dev This contract implements the ERC20 standard while ensuring confidentiality of token transactions through encryption.
///      This contract is deployed using an UUPS proxy.
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
contract PrivateERC20Contract256 is DecryptionCaller, UUPSUpgradeable, Ownable2StepUpgradeable, ReentrancyGuardUpgradeable {
    /// @notice Emitted when tokens are transferred
    /// @param _from The address of the sender
    /// @param _to The address of the recipient
    /// @param _value The amount of tokens transferred (only for clear transfers)
    event Transfer(address indexed _from, address indexed _to, uint256 _value);
    /// @notice Emitted when tokens are transferred (for encrypted transfers)
    /// @param _from The address of the sender
    /// @param _to The address of the recipient
    event Transfer(address indexed _from, address indexed _to);
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
    
    
    // Private Token Withdrawal Events
    event PrivateTokensWithdrawn(address indexed user, address indexed recipient, gtUint256 amount);
    
    /// @custom:storage-location erc7201:bubble.storage.PrivateERC20Contract256
    struct PrivateERC20Contract256Storage {
        /// @notice The name of the token
        string _name;
        /// @notice The symbol of the token
        string _symbol;
        /// @notice The total supply of tokens
        uint256 _totalSupply;
        /// @notice Constant zero value used to initialize balances
        /// @dev This is stored in storage to save gas on repeated zero checks
        gtUint256 zero;
        /// @notice Mapping of encrypted token balances for each address
        /// @dev The balance is stored as a handle that requires encryption and decryption under the user's secret key to get the actual value
        mapping(address => gtUint256) balances;
        /// @notice Mapping of encrypted allowances for each address pair
        /// @dev The allowance is stored as a handle that requires decryption to get the actual value
        mapping(address => mapping(address => gtUint256)) allowances;
        /// @notice The master address for unshield operations
        address master;
        /// @notice The standard ERC20 token that can be wrapped
        IERC20 underlying;
        /// @notice OPRF key management - initialized in initializer
        gtUint128 _oprfKey;
        /// @notice Storage for unshield requests
        mapping(uint256 => UnshieldRequest) unshieldRequests;
        /// @notice Decimals used by the underlying token for shield/unshield conversion
        uint8 underlyingDecimals;
        /// @notice Whether underlying decimals were initialized in storage
        bool underlyingDecimalsInitialized;
        /// @notice Whether underlying token supports unwrap to native token (WETH/WPOL style)
        bool underlyingIsWrappedNative;
    }
    
    /// @notice Storage for unshield requests
    struct UnshieldRequest {
        address user;
        bool unwrapNative;
    }

    /// The storage location of the PrivateERC20Contract256Storage struct.
    /// Calculated using the formula: keccak256(abi.encode(uint256(keccak256("bubble.storage.PrivateERC20Contract256")) - 1)) & ~bytes32(uint256(0xff))
    /// @dev This value is calculated using the ERC-7201 standard formula.
    ///      The last byte is 0x00 as required by ERC-7201.
    ///      Calculated using: bubble/core/scripts/calculate_storage_locations.py
    bytes32 private constant PrivateERC20Contract256StorageLocation = 0x9deef7192d493ef71cbd7c46c5b8e4088a630550d613be0294e8c5db63409100;
    
    // Struct for OPRF token parameters
    struct OPRFToken {
        itUint128 x;
        itUint256 q;
        uint128 y_clear;
    }
    
    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
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
        assembly {
            $.slot := PrivateERC20Contract256StorageLocation
        }
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
    
    /// @notice Emergency recovery function to transfer all underlying tokens to the owner
    /// @dev Only the owner can call this function
    /// @dev This function transfers all underlying ERC20 tokens held by the contract to the owner
    ///      and resets totalSupply to zero.
    /// @dev Use this function only in emergency situations
    /// @return The amount of tokens recovered
    function emergencyRecovery() external onlyOwner nonReentrant returns (uint256) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
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
        return $.balances[msg.sender];
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
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        gtUint256 balance = $.balances[add];
        if (gtUint256.unwrap(balance) == 0){ // 0 means that no balance has been set, set it to 0
            balance = $.zero;
        }
        return balance;
    }
    /// @notice Transfers tokens using an encrypted and signed value
    /// @param _to The address to transfer to
    /// @param _it The encrypted and signed transfer amount
    /// @return The handle to the transfer's result
    function transfer(address _to, itUint256 calldata _it) public virtual returns (gtBool) {
        gtUint256 value = MpcCore.validateCiphertext(_it);
        MpcCore.permitTransient(value, msg.sender); // Give transient permission the the sender, so the contractTransfer check will pass
        return contractTransfer(_to, value);
    }

    /// @notice Transfers tokens using a clear value
    /// @param _to The address to transfer to
    /// @param _value The amount of tokens to transfer
    /// @return The handle to the transfer's result
    function transfer(address _to, uint256 _value) public virtual returns (gtBool) {
        // Check for self-transfer
       if (msg.sender == _to) {
           emit Transfer(msg.sender, _to, _value);
           return MpcCore.setPublic(true);
       }
        
        (gtUint256 fromBalance, gtUint256 toBalance) = _getBalances(msg.sender, _to);
        (gtUint256 newFromBalance, gtUint256 newToBalance, gtBool result) = MpcCore.transfer(fromBalance, toBalance, _value);
        _setNewBalances(msg.sender, _to, newFromBalance, newToBalance);
        emit Transfer(msg.sender, _to, _value);
        return result;
    }
    /// @notice Transfers the amount of tokens given in the handle _value to address _to
    /// @param _to The address to transfer to
    /// @param _value The handle to the amount of tokens to transfer
    /// @return The handle to the transfer's result
    function contractTransfer(address _to, gtUint256 _value) public virtual returns (gtBool) {
        // Check if the sender is permitted to use the _value handle
        require(MpcCore.isSenderPermitted(_value));
        
        // Check for self-transfer
        if (msg.sender == _to) {
            emit Transfer(msg.sender, _to);
            return MpcCore.setPublic(true);
        }
        
        (gtUint256 fromBalance, gtUint256 toBalance) = _getBalances(msg.sender, _to);
        (gtUint256 newFromBalance, gtUint256 newToBalance, gtBool result) = MpcCore.transfer(fromBalance, toBalance, _value);
        _setNewBalances(msg.sender, _to, newFromBalance, newToBalance);
        emit Transfer(msg.sender, _to);
        return result;
    }
    /// @notice Transfers the amount of tokens given inside the IT (an encrypted and signed value) from one address to another
    /// @param _from The address to transfer from
    /// @param _to The address to transfer to
    /// @param _it The encrypted and signed transfer amount
    /// @return The handle to the transfer's result
    function transferFrom(address _from, address _to, itUint256 calldata _it) public virtual returns (gtBool) {
        gtUint256 value = MpcCore.validateCiphertext(_it);
        MpcCore.permitTransient(value, msg.sender); // Give transient permission the the sender, so the contractTransferFrom check will pass
        return contractTransferFrom(_from, _to, value);
    }
    /// @notice Transfers the amount of tokens given in the clear from one address to another
    /// @param _from The address to transfer from
    /// @param _to The address to transfer to
    /// @param _value The amount of tokens to transfer
    /// @return The handle to the transfer's result
    function transferFrom(address _from, address _to, uint256 _value) public virtual returns (gtBool) {
        gtUint256 allowance = _getGTAllowance(_from, msg.sender);

        // Check for self-transfer
        if (_from == _to) {
            // Still check allowance for self-transfers to maintain ERC20 compliance
            gtUint256 valueGt = MpcCore.setPublic256(_value);
            MpcCore.permitThis(valueGt);
            // Check if allowance is sufficient (we just validate, don't subtract since it's a self-transfer)
            gtBool hasSufficientAllowance = MpcCore.ge(allowance, valueGt);
            emit Transfer(_from, _to, _value);
            return hasSufficientAllowance;
        }
        
        (gtUint256 fromBalance, gtUint256 toBalance) = _getBalances(_from, _to);
        (gtUint256 newFromBalance, gtUint256 newToBalance, gtBool result, gtUint256 newAllowance) = MpcCore.transferWithAllowance(fromBalance, toBalance, _value, allowance);
        _setApproveValue(_from, msg.sender, newAllowance);
        _setNewBalances(_from, _to, newFromBalance, newToBalance);
        emit Transfer(_from, _to, _value);
        return result;
    }
    /// @notice Transfers the amount of tokens given in the handle from one address to another
    /// @param _from The address to transfer from
    /// @param _to The address to transfer to
    /// @param _value The encrypted transfer amount
    /// @return The handle to the transfer's result
    function contractTransferFrom(address _from, address _to, gtUint256 _value) public virtual returns (gtBool) {
        // Check if the sender is permitted to use the _value handle
        require(MpcCore.isSenderPermitted(_value));
        gtUint256 allowance = _getGTAllowance(_from, msg.sender);
        // Check for self-transfer
        if (_from == _to) {
            // Check if allowance is sufficient (we just validate, don't subtract since it's a self-transfer)
            gtBool hasSufficientAllowance = MpcCore.ge(allowance, _value);
            emit Transfer(_from, _to);
            return hasSufficientAllowance;
        }
        
        (gtUint256 fromBalance, gtUint256 toBalance) = _getBalances(_from, _to);
        (gtUint256 newFromBalance, gtUint256 newToBalance, gtBool result, gtUint256 newAllowance) = MpcCore.transferWithAllowance(fromBalance, toBalance, _value, allowance);
        _setApproveValue(_from, msg.sender, newAllowance);
        _setNewBalances(_from, _to, newFromBalance, newToBalance);
        emit Transfer(_from, _to);
        return result;
    }
    /// @notice Approves a spender to transfer the amount of tokens given inside the IT (an encrypted and signed value)
    /// @param _spender The address that will be approved
    /// @param _it The encrypted and signed approval amount
    /// @return True if the approval was successful
    function approve(address _spender, itUint256 calldata _it) public virtual returns (bool) {
        return contractApprove(_spender, MpcCore.validateCiphertext(_it));
    }
    /// @notice Approves a spender to transfer the amount of tokens given in the clear
    /// @param _spender The address that will be approved
    /// @param _value The amount of tokens to approve
    /// @return True if the approval was successful
    function approve(address _spender, uint256 _value) public virtual returns (bool) {
        address owner = msg.sender;
        gtUint256 gt = MpcCore.setPublic256(_value);
        _setApproveValue(owner, _spender, gt);
        emit Approval(owner, _spender, _value);
        return true;
    }
    /// @notice Approves a spender to transfer the amount of tokens given in the handle
    /// @param _spender The address that will be approved
    /// @param _value The handle to the approval amount
    /// @return True if the approval was successful
    function contractApprove(address _spender, gtUint256 _value) public virtual returns (bool) {
        // Check if the sender is permitted to use the _value handle
        require(MpcCore.isSenderPermitted(_value));
        address owner = msg.sender;
        _setApproveValue(owner, _spender, _value);
        emit Approval(owner, _spender);
        return true;
    }
    /// @notice Returns the handle to the allowance of a spender
    /// @dev The returned handle requires encryption and decryption under the user's secret key to get the actual value
    /// @param _owner The address of the token owner
    /// @param _spender The address of the spender
    /// @return The allowance handle
    function allowance(address _owner, address _spender) public view returns (gtUint256) {
        require(_owner == msg.sender || _spender == msg.sender);
        return _getGTAllowance(_owner, _spender);
    }
    /// @notice Returns the handles to the balances of two addresses
    /// @param _from The address to get the balance from
    /// @param _to The address to get the balance to
    /// @return The balance handles for both addresses
    function _getBalances(address _from, address _to) private view returns (gtUint256, gtUint256) {
        return (_balanceOf(_from), _balanceOf(_to));
    }
    /// @notice Sets the new balances handles for two addresses
    /// @param _from The address to set the balance for
    /// @param _to The address to set the balance for
    /// @param newFromBalance The new balance handle for _from
    /// @param newToBalance The new balance handle for _to
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

    /// @notice Moves tokens from a user to the contract using MPC transfer primitives
    /// @param fromAmount Handle to transfer from the caller; caller must control the handle
    function _transferToContract(gtUint256 fromAmount) private {
        // Ensure the external caller can authorize use of the encrypted amount
        MpcCore.permitTransient(fromAmount, msg.sender);
        contractTransfer(address(this), fromAmount);
    }

    /// @notice Moves tokens from the contract to a recipient using MPC transfer primitives
    /// @param recipient The address receiving the transferred handle
    /// @param amount The handle to transfer; the contract must already be permitted on it
    function _transferFromContract(address recipient, gtUint256 amount) private {
        (gtUint256 fromBalance, gtUint256 toBalance) = _getBalances(address(this), recipient);
        (gtUint256 newFromBalance, gtUint256 newToBalance, ) = MpcCore.transfer(fromBalance, toBalance, amount);
        _setNewBalances(address(this), recipient, newFromBalance, newToBalance);
        emit Transfer(address(this), recipient);
    }
    /// @notice Returns the handle to the allowance of a spender
    /// @param _owner The address of the token owner
    /// @param _spender The address of the spender
    /// @return The allowance handle
    function _getGTAllowance(address _owner, address _spender) private view returns (gtUint256) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        if (gtUint256.unwrap($.allowances[_owner][_spender]) == 0) {
            return $.zero;
        } else {
            return $.allowances[_owner][_spender];
        }
    }
    /// @notice Sets the new handle to the allowance for a spender
    /// @param _owner The address of the token owner
    /// @param _spender The address of the spender
    /// @param _value The new allowance handle
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

    /// @notice Shield standard ERC20 tokens into private tokens
    /// @dev Private tokens mirror the underlying token decimals, so shielded amounts are one-to-one.
    function shield(uint256 amount) public virtual nonReentrant returns (bool) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        require(amount > 0, "Amount must be greater than 0");
        require($.underlying.transferFrom(msg.sender, address(this), amount), "Transfer failed");
        gtUint256 balanceGt = _balanceOf(msg.sender);
        gtUint256 newBalanceGt = MpcCore.add(balanceGt, MpcCore.setPublic256(amount));
        $.balances[msg.sender] = newBalanceGt;
        $._totalSupply += amount;
        // Permit the contract and the user to use the new balance handle
        MpcCore.permitThis(newBalanceGt);
        MpcCore.permit(newBalanceGt, msg.sender);
        emit Shield(msg.sender, amount);
        return true;
    }
    // Function to unshield private tokens back to standard ERC20 tokens
    function unshield(uint256 privateAmount) public virtual returns (bool) {
        return _unshieldTo(privateAmount, msg.sender);
    }

    // Function to unshield private tokens back to standard ERC20 tokens for master address
    function unshieldForMaster(uint256 privateAmount) public virtual returns (bool) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        return _unshieldTo(privateAmount, $.master);
    }

    // Internal function to handle unshield logic
    function _unshieldTo(uint256 privateAmount, address recipient) internal returns (bool) {
       require(privateAmount > 0, "Amount must be greater than 0");
       gtUint256 amountGt = MpcCore.setPublic256(privateAmount);

       // user balance = 10, want to unshield 3. checkedSubWithOverflowBit(10, 3) = 7, amount to unshield = bal before 10 sub new balance 7 = 3
       // user balance = 5, want to unshield 7. checkedSubWithOverflowBit(5, 7) = 5, amount to unshield = bal before 5 sub new balance 5 = 0
       gtUint256 amountToUnshieldGt = _debitBalanceForUnshield(msg.sender, amountGt);

       _requestUnshieldFromHandle(amountToUnshieldGt, recipient);
       
       emit UnshieldRequested(recipient, privateAmount);
       return true;
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
    function _requestUnshieldFromHandle(gtUint256 amountToUnshieldGt, address recipient) internal {
        _requestUnshieldFromHandle(amountToUnshieldGt, recipient, false);
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
    
    /// @notice Mints an OPRF token for the caller using encrypted parameters
    /// @param quantity The encrypted quantity/amount for the OPRF token
    function mintOPRFToken(itUint256 calldata quantity) public virtual {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        gtUint256 qGT = MpcCore.validateCiphertext(quantity);
        
        gtUint256 contractBalanceBefore = _balanceOf(address(this));
        
        // Transfer tokens from user to contract
        _transferToContract(qGT);
        
        // Calculate actual transferred amount
        gtUint256 contractBalanceAfter = _balanceOf(address(this));
        (gtBool overflowBit, gtUint256 actualTransferredCandidate) =
            MpcCore.checkedSubWithOverflowBit(contractBalanceAfter, contractBalanceBefore);
        gtUint256 actualTransferred = MpcCore.mux(overflowBit, actualTransferredCandidate, $.zero);
        MpcCore.permitThis(actualTransferred);
        
        // Mint OPRF token using the contract's internal key
        (gtUint128 x, gtUint128 y) = MpcCore.oprfMint($._oprfKey, actualTransferred);
        
        MpcCore.permit(x, msg.sender);
        MpcCore.permit(y, msg.sender);
        MpcCore.permit(actualTransferred, msg.sender);
        
        
        emit OPRFMinted(msg.sender, x, y, actualTransferred);
    }
    
    /// @notice Internal function that performs the core split logic: burn, calculate remainder, and mint new tokens
    /// @param xGT The validated x value from OPRF minting
    /// @param qGT The validated quantity from OPRF minting
    /// @param qSplitGT The validated amount to split off as payment
    /// @param y_clear The clear (unencrypted) y value for splitting
    /// @return xrRemainder The x value of the remainder token
    /// @return yRemainder The y value of the remainder token
    /// @return qRemainder The quantity of the remainder token
    /// @return xrPay The x value of the payment token
    /// @return qPay The quantity of the payment token
    /// @return yPay The y value of the payment token
    function _splitTokenInternal(
        gtUint128 xGT,
        gtUint256 qGT,
        gtUint256 qSplitGT,
        uint128 y_clear
    ) internal returns (
        gtUint128 xrRemainder,
        gtUint128 yRemainder,
        gtUint256 qRemainder,
        gtUint128 xrPay,
        gtUint256 qPay,
        gtUint128 yPay
    ) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        
        // Burn the original token to validate it and get the burned amount
        gtUint256 qBurned = MpcCore.oprfBurn($._oprfKey, xGT, qGT, y_clear);
        MpcCore.permitThis(qBurned);
        
        // Use checked subtraction to avoid underflow when requested split exceeds burned amount.
        // If overflow occurs, keep full amount as remainder and set payment to zero.
        (gtBool overflowBit, gtUint256 qRemainderCandidate) = MpcCore.checkedSubWithOverflowBit(qBurned, qSplitGT);
        qRemainder = MpcCore.mux(overflowBit, qRemainderCandidate, qBurned);
        qPay = MpcCore.mux(overflowBit, qSplitGT, $.zero);
        MpcCore.permitThis(qRemainder);
        MpcCore.permitThis(qPay);
        
        // Mint two new tokens: remainder and payment
        (xrRemainder, yRemainder) = MpcCore.oprfMint($._oprfKey, qRemainder);
        (xrPay, yPay) = MpcCore.oprfMint($._oprfKey, qPay);
        
        // Emit invalidation event for the original token (using validated GT values)
        emit OPRFTokenInvalidated(msg.sender, xGT, qGT, y_clear, 1); // 1=split
    }

    /// @notice Splits an OPRF token into remainder and payment portions using encrypted parameters
    /// @param x The encrypted x value from OPRF minting
    /// @param q The encrypted quantity from OPRF minting
    /// @param y_clear The clear (unencrypted) y value for splitting
    /// @param qSplit The encrypted amount to split off as payment
    function splitToken(
        itUint128 calldata x,
        itUint256 calldata q,
        uint128 y_clear,
        itUint256 calldata qSplit
    ) public virtual {
        // Validate and decrypt the encrypted parameters
        gtUint128 xGT = MpcCore.validateCiphertext(x);
        gtUint256 qGT = MpcCore.validateCiphertext(q);
        gtUint256 qSplitGT = MpcCore.validateCiphertext(qSplit);
        
        // Perform the split operation
        (gtUint128 xrRemainder, gtUint128 yRemainder, gtUint256 qRemainder, gtUint128 xrPay, gtUint256 qPay, gtUint128 yPay) = 
            _splitTokenInternal(xGT, qGT, qSplitGT, y_clear);
        
        // Permit the user to decrypt the results
        MpcCore.permit(xrRemainder, msg.sender);
        MpcCore.permit(qRemainder, msg.sender);
        MpcCore.permit(yRemainder, msg.sender);
        MpcCore.permit(xrPay, msg.sender);
        MpcCore.permit(qPay, msg.sender);
        MpcCore.permit(yPay, msg.sender);
        
        // Emit events
        emit OPRFSplit(msg.sender, xrRemainder, qRemainder, yRemainder, xrPay, qPay, yPay);
        // Emit OPRFMinted events for both the remainder and payment tokens
        // This allows the subgraph to track them like regular minted tokens
        emit OPRFMinted(msg.sender, xrRemainder, yRemainder, qRemainder);
        emit OPRFMinted(msg.sender, xrPay, yPay, qPay);
    }

    /// @notice Splits an OPRF token for anonymous transfer to a recipient
    /// @param x The encrypted x coordinate of the OPRF token
    /// @param q The encrypted quantity/amount of the OPRF token
    /// @param y_clear The clear (unencrypted) y coordinate of the OPRF token
    /// @param qSplit The encrypted amount to split off as payment
    /// @param recipient The address of the recipient who will receive the split values
    function splitTokenForRecipient(
        itUint128 calldata x,
        itUint256 calldata q,
        uint128 y_clear,
        itUint256 calldata qSplit,
        address recipient
    ) public virtual {
        // Validate and decrypt the encrypted parameters
        gtUint128 xGT = MpcCore.validateCiphertext(x);
        gtUint256 qGT = MpcCore.validateCiphertext(q);
        gtUint256 qSplitGT = MpcCore.validateCiphertext(qSplit);
        
        // Perform the split operation
        (gtUint128 xrRemainder, gtUint128 yRemainder, gtUint256 qRemainder, gtUint128 xrPay, gtUint256 qPay, gtUint128 yPay) = 
            _splitTokenInternal(xGT, qGT, qSplitGT, y_clear);
        
        // Permit the original user to decrypt the remainder values
        MpcCore.permit(xrRemainder, msg.sender);
        MpcCore.permit(qRemainder, msg.sender);
        MpcCore.permit(yRemainder, msg.sender);
        
        // Permit the recipient to decrypt the payment values
        MpcCore.permit(xrPay, recipient);
        MpcCore.permit(qPay, recipient);
        MpcCore.permit(yPay, recipient);
        
        // Emit OPRFMinted events for both the remainder and payment tokens
        // This allows the subgraph to track them like regular minted tokens
        emit OPRFMinted(msg.sender, xrRemainder, yRemainder, qRemainder);
        emit OPRFMinted(recipient, xrPay, yPay, qPay);
        
        // Also emit the split event for backward compatibility and additional tracking
        emit OPRFSplitForRecipient(msg.sender, recipient, xrRemainder, qRemainder, yRemainder, xrPay, qPay, yPay);
    }
    
    /// @notice Burns an OPRF token and transfers the burned amount to recipient
    /// @param x The encrypted x value from OPRF minting or split
    /// @param q The encrypted quantity from OPRF minting or split
    /// @param y_clear The clear (unencrypted) y value for burning
    /// @param recipient The address to receive the burned tokens
    function burnToken(
        itUint128 calldata x,
        itUint256 calldata q,
        uint128 y_clear,
        address recipient
    ) public virtual {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        // Validate and decrypt the encrypted parameters
        gtUint128 xGT = MpcCore.validateCiphertext(x);
        gtUint256 qGT = MpcCore.validateCiphertext(q);
        
        
        // Call oprfBurn to validate and get the burned amount using the contract's internal key
        // If the OPRF token is invalid, burnedAmount will be 0
        gtUint256 burnedAmount = MpcCore.oprfBurn($._oprfKey, xGT, qGT, y_clear);
        
        // Give the contract permission to use the burned amount
        MpcCore.permitThis(burnedAmount);
        
        // Transfer the burned amount from contract to recipient
        _transferFromContract(recipient, burnedAmount);
        
        // Permit the user to decrypt the burned amount
        MpcCore.permit(burnedAmount, msg.sender);
        
        
        // Emit invalidation event for the burned token (using encrypted values)
        emit OPRFTokenInvalidated(msg.sender, xGT, qGT, y_clear, 3); // 3=burned
        emit OPRFBurned(msg.sender, recipient, burnedAmount);
    }

    /// @notice Internal function that burns multiple OPRF tokens and accumulates the total burned amount
    /// @param tokens Array of OPRF token parameters to burn
    /// @return totalBurned The total amount burned from all tokens
    function _burnTokensAndAccumulate(
        OPRFToken[] calldata tokens
    ) internal returns (gtUint256 totalBurned) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        
        // Initialize total burned amount with zero (MPC operations grant transient permission automatically)
        totalBurned = $.zero;
        
        // Burn each token and accumulate the burned amounts
        for (uint256 i = 0; i < tokens.length; i++) {
            // Validate ciphertexts (grants transient permission to contract)
            gtUint128 xGT = MpcCore.validateCiphertext(tokens[i].x);
            gtUint256 qGT = MpcCore.validateCiphertext(tokens[i].q);
            
            // oprfBurn grants transient permission for burnedAmount
            gtUint256 burnedAmount = MpcCore.oprfBurn($._oprfKey, xGT, qGT, tokens[i].y_clear);
            
            // add grants transient permission for totalBurned
            totalBurned = MpcCore.add(totalBurned, burnedAmount);
            
            // Emit invalidation event for each burned token
            emit OPRFTokenInvalidated(msg.sender, xGT, qGT, tokens[i].y_clear, 3); // 3=burned
            emit OPRFBurned(msg.sender, address(this), burnedAmount);
        }
    }

    /// @notice Merges multiple OPRF tokens by burning them all and creating a new token with the total amount
    /// @param tokens Array of OPRF token parameters to merge
    /// @return x The encrypted x value of the newly minted token
    /// @return y The encrypted y value of the newly minted token
    /// @return qMerged The encrypted quantity of the newly minted token (total of all burned tokens)
    function mergeMany(
        OPRFToken[] calldata tokens
    ) public virtual returns (gtUint128 x, gtUint128 y, gtUint256 qMerged) {
        require(tokens.length > 0, "At least one token required");
        
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        
        // Burn all tokens and get the total burned amount
        gtUint256 totalBurned = _burnTokensAndAccumulate(tokens);
        
        // Mint a new OPRF token with the total burned amount using the contract's internal key
        (x, y) = MpcCore.oprfMint($._oprfKey, totalBurned);
        
        // Permit the user to decrypt the new token values
        MpcCore.permit(x, msg.sender);
        MpcCore.permit(y, msg.sender);
        MpcCore.permit(totalBurned, msg.sender);
        
        qMerged = totalBurned;
        
        // Emit events for the merged token
        emit OPRFMinted(msg.sender, x, y, qMerged);
        emit OPRFMerged(msg.sender, x, qMerged, y);
    }

    /// @notice Transfers OPRF tokens to a recipient by burning input tokens and minting new tokens
    /// @param tokens Array of OPRF token parameters to burn
    /// @param amount Encrypted amount to transfer to recipient
    /// @param recipient Address of the recipient who will receive the tokens
    /// @return xRecipient The encrypted x value of the recipient's minted token
    /// @return yRecipient The encrypted y value of the recipient's minted token
    /// @return qRecipient The encrypted quantity of the recipient's minted token
    /// @return xSender The encrypted x value of the sender's remainder token
    /// @return ySender The encrypted y value of the sender's remainder token
    /// @return qSender The encrypted quantity of the sender's remainder token
    function transferOPRF(
        OPRFToken[] calldata tokens,
        itUint256 calldata amount,
        address recipient
    ) public virtual returns (
        gtUint128 xRecipient,
        gtUint128 yRecipient,
        gtUint256 qRecipient,
        gtUint128 xSender,
        gtUint128 ySender,
        gtUint256 qSender
    ) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();
        _validateOPRFSpendInputs(tokens.length, recipient);

        (, gtUint256 recipientAmount, gtUint256 senderAmount) = _calculateOPRFSpendAmounts(tokens, amount);
        
        // Mint OPRF tokens (oprfMint grants transient permission)
        (xRecipient, yRecipient) = MpcCore.oprfMint($._oprfKey, recipientAmount);
        (xSender, ySender) = MpcCore.oprfMint($._oprfKey, senderAmount);
        
        // Only permit values that need to be decrypted AFTER the transaction
        MpcCore.permit(xRecipient, recipient);
        MpcCore.permit(yRecipient, recipient);
        MpcCore.permit(recipientAmount, recipient);
        MpcCore.permit(recipientAmount, msg.sender);
        
        MpcCore.permit(xSender, msg.sender);
        MpcCore.permit(ySender, msg.sender);
        MpcCore.permit(senderAmount, msg.sender);
        
        qRecipient = recipientAmount;
        qSender = senderAmount;
        
        // Emit events
        emit OPRFTransferred(msg.sender, recipient, recipientAmount);
        emit OPRFMinted(recipient, xRecipient, yRecipient, qRecipient);
        emit OPRFMinted(msg.sender, xSender, ySender, qSender);
    }

    function _validateOPRFSpendInputs(uint256 tokenCount, address recipient) private pure {
        require(tokenCount > 0, "At least one token required");
        require(recipient != address(0), "Recipient cannot be zero address");
    }

    function _calculateOPRFSpendAmounts(
        OPRFToken[] calldata tokens,
        itUint256 calldata amount
    ) private returns (
        gtUint256 totalBurned,
        gtUint256 spendAmount,
        gtUint256 remainderAmount
    ) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();

        totalBurned = _burnTokensAndAccumulate(tokens);
        gtUint256 amountToTransfer = MpcCore.validateCiphertext(amount);
        (gtBool overflowBit, gtUint256 remainder) = MpcCore.checkedSubWithOverflowBit(totalBurned, amountToTransfer);

        spendAmount = MpcCore.mux(overflowBit, amountToTransfer, $.zero);
        remainderAmount = MpcCore.mux(overflowBit, remainder, totalBurned);
    }

    function _mintRedeemRemainder(
        address recipient,
        gtUint256 totalBurned,
        gtUint256 recipientAmount,
        gtUint256 senderRemainder
    ) private returns (
        gtUint128 xRemainder,
        gtUint128 yRemainder,
        gtUint256 qRemainder
    ) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();

        (xRemainder, yRemainder) = MpcCore.oprfMint($._oprfKey, senderRemainder);

        MpcCore.permit(xRemainder, msg.sender);
        MpcCore.permit(yRemainder, msg.sender);
        MpcCore.permit(senderRemainder, msg.sender);
        MpcCore.permit(recipientAmount, msg.sender);
        MpcCore.permit(totalBurned, msg.sender);

        qRemainder = senderRemainder;

        emit OPRFBurned(msg.sender, recipient, totalBurned);
        emit OPRFMinted(msg.sender, xRemainder, yRemainder, qRemainder);
    }

    function _unshieldRedeemedRecipientAmount(
        address recipient,
        gtUint256 recipientAmount,
        bool unwrap
    ) private {
        gtUint256 amountToUnshieldGt = _debitBalanceForUnshield(recipient, recipientAmount);
        _requestUnshieldFromHandle(amountToUnshieldGt, recipient, unwrap);
    }

    /// @notice Redeems multiple OPRF tokens by burning them all, transferring the specified amount as private tokens to recipient, and minting a leftover OPRF token if there's a remainder
    /// @param tokens Array of OPRF token parameters to burn
    /// @param amount Encrypted amount to transfer to recipient as private tokens
    /// @param recipient Address of the recipient who will receive the private tokens
    /// @return xRemainder The encrypted x value of the sender's remainder token (if any)
    /// @return yRemainder The encrypted y value of the sender's remainder token (if any)
    /// @return qRemainder The encrypted quantity of the sender's remainder token (if any)
    function redeemMany(
        OPRFToken[] calldata tokens,
        itUint256 calldata amount,
        address recipient
    ) public virtual returns (
        gtUint128 xRemainder,
        gtUint128 yRemainder,
        gtUint256 qRemainder
    ) {
        _validateOPRFSpendInputs(tokens.length, recipient);

        (gtUint256 totalBurned, gtUint256 recipientAmount, gtUint256 senderRemainder) =
            _calculateOPRFSpendAmounts(tokens, amount);

        _transferFromContract(recipient, recipientAmount);

        return _mintRedeemRemainder(recipient, totalBurned, recipientAmount, senderRemainder);
    }

    /// @notice Redeems multiple OPRF tokens and directly unshields the redeemed amount to underlying tokens for recipient.
    /// @dev The redeemed amount never remains in recipient's private balance: it is credited and immediately debited before unshield callback.
    /// @param tokens Array of OPRF token parameters to burn
    /// @param amount Encrypted amount to redeem and unshield
    /// @param recipient Address receiving the underlying tokens after callback
    /// @param unwrap If true, unwrap wrapped-native underlying and send native token
    /// @return xRemainder The encrypted x value of the sender's remainder token (if any)
    /// @return yRemainder The encrypted y value of the sender's remainder token (if any)
    /// @return qRemainder The encrypted quantity of the sender's remainder token (if any)
    function redeemManyToUnderlying(
        OPRFToken[] calldata tokens,
        itUint256 calldata amount,
        address recipient,
        bool unwrap
    ) public virtual returns (
        gtUint128 xRemainder,
        gtUint128 yRemainder,
        gtUint256 qRemainder
    ) {
        PrivateERC20Contract256Storage storage $ = _getPrivateERC20Contract256Storage();

        _validateOPRFSpendInputs(tokens.length, recipient);
        if (unwrap) {
            require($.underlyingIsWrappedNative, "Underlying unwrap not configured");
        }

        (gtUint256 totalBurned, gtUint256 recipientAmount, gtUint256 senderRemainder) =
            _calculateOPRFSpendAmounts(tokens, amount);

        _transferFromContract(recipient, recipientAmount);
        _unshieldRedeemedRecipientAmount(recipient, recipientAmount, unwrap);

        return _mintRedeemRemainder(recipient, totalBurned, recipientAmount, senderRemainder);
    }

}
