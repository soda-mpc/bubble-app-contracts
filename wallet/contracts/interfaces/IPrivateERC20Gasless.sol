// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import "@sodalabs/bubble-core-contracts/contracts/bubble/MpcCore.sol";

/// @title IPrivateERC20Gasless
/// @notice External API and events of PrivateERC20Contract256Gasless. The token inherits this interface, so its
///         ABI carries every event.
/// @dev Functions the token inherits from OpenZeppelin (ownership, pausable state, UUPS upgrade) are not repeated
///      here; call them through the OpenZeppelin types. Amounts and results are MPC handles, so this is an
///      ERC20-like interface, not ERC20.
interface IPrivateERC20Gasless {
    /// @notice Emitted when tokens are transferred in the clear
    /// @param _from The address of the sender
    /// @param _to The address of the recipient
    /// @param _value The requested amount. The transfer may have moved nothing; see the returned `gtBool`.
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
    /// @notice An unshield to `to` was requested; `callbackUnshield` settles it with `Unshield`, `UnshieldParked`
    ///         or `UnshieldFailed`.
    /// @param amount The requested clear amount.
    /// @param decryptId The decryption request whose callback pays `to`.
    event UnshieldRequested(address indexed to, uint256 amount, uint256 indexed decryptId);
    event UnshieldFailed(address indexed to, uint256 amount);
    /// @notice Underlying stayed in this contract after the push to `account` failed. Pull it with `claimUnshielded`.
    event UnshieldParked(address indexed account, uint256 amount);
    event UnshieldClaimed(address indexed account, address indexed to, uint256 amount);
    event MasterUpdated(address indexed oldMaster, address indexed newMaster);
    /// @notice The token was retired; `amount` of unreserved underlying went to `owner` (may be zero).
    event EmergencyRecovery(address indexed owner, uint256 amount);
    event NativeRecovered(address indexed to, uint256 amount);

    // ---------------------------------------------------------------------------------------------
    // Initialization
    // ---------------------------------------------------------------------------------------------

    function initialize(
        string memory name_,
        string memory symbol_,
        address underlying_,
        address owner_,
        address master_
    ) external;

    function initializeWithWrappedNative(
        string memory name_,
        string memory symbol_,
        address underlying_,
        address owner_,
        address master_,
        bool underlyingIsWrappedNative_
    ) external;

    // ---------------------------------------------------------------------------------------------
    // Metadata and views
    // ---------------------------------------------------------------------------------------------

    function name() external view returns (string memory);
    function symbol() external view returns (string memory);
    function decimals() external view returns (uint8);
    function totalSupply() external view returns (uint256);
    function master() external view returns (address);
    function underlying() external view returns (address);
    function underlyingIsWrappedNative() external view returns (bool);
    function retired() external view returns (bool);
    function balanceOf() external view returns (gtUint256);
    function balanceOf(address account) external view returns (gtUint256);
    function allowance(address owner, address spender) external view returns (gtUint256);
    function claimableUnderlying(address account) external view returns (uint256);

    // ---------------------------------------------------------------------------------------------
    // Admin
    // ---------------------------------------------------------------------------------------------

    function setMaster(address newMaster) external;
    function pause() external;
    function unpause() external;
    function emergencyRecovery() external returns (uint256);
    function recoverNative(address to, uint256 amount) external returns (uint256 recoveredAmount);

    // ---------------------------------------------------------------------------------------------
    // Transfers and approvals
    // ---------------------------------------------------------------------------------------------

    function transfer(address to, itUint256 memory it) external returns (gtBool);
    function transfer(address to, uint256 value) external returns (gtBool);
    function contractTransfer(address to, gtUint256 value) external returns (gtBool);
    function transferFrom(address from, address to, itUint256 memory it) external returns (gtBool);
    function transferFrom(address from, address to, uint256 value) external returns (gtBool);
    function contractTransferFrom(address from, address to, gtUint256 value) external returns (gtBool);
    function approve(address spender, itUint256 memory it) external returns (bool);
    function approve(address spender, uint256 value) external returns (bool);
    function contractApprove(address spender, gtUint256 value) external returns (bool);

    // ---------------------------------------------------------------------------------------------
    // Shield / unshield
    // ---------------------------------------------------------------------------------------------

    function shield(uint256 amount) external returns (bool);
    function unshield(uint256 privateAmount) external returns (bool);
    function unshieldForMaster(uint256 privateAmount) external returns (bool);
    function callbackUnshield(uint256 decryptID, bytes[] calldata output, bytes[] calldata signatures) external;
    function claimUnshielded(address to) external;
}
