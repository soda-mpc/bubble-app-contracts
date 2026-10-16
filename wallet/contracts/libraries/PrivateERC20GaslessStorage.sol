// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import "@sodalabs/bubble-core-contracts/contracts/bubble/MpcCore.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

interface IWrappedNative is IERC20 {
    function withdraw(uint256 wad) external;
    function deposit() external payable;
}

interface IGaslessForwarder {
    function token() external view returns (address);
}

/// @notice Shared storage and types for PrivateERC20Contract256Gasless and its linked PrivateOPRFNotes library.
/// @dev The ERC-7201 slot matches `bubble.storage.PrivateERC20Contract256`. Parked-claim fields and
///      `unshieldEpoch` extend that layout at the end.

/// @notice Storage for unshield requests
struct UnshieldRequest {
    address user;
    bool unwrapNative;
    /// @notice `unshieldEpoch` when the request was created. Emergency recovery invalidates older requests.
    uint256 epoch;
}

/// @dev ERC-7201 slot `bubble.storage.PrivateERC20Contract256`. The annotation stays off this file-level
/// struct so the upgrades plugin can compile it; `privateERC20Storage` pins the slot below.
struct PrivateERC20Contract256Storage {
    /// @notice The name of the token
    string _name;
    /// @notice The symbol of the token
    string _symbol;
    /// @notice The total supply of tokens
    uint256 _totalSupply;
    /// @notice Constant zero value used to initialize balances
    gtUint256 zero;
    /// @notice Mapping of encrypted token balances for each address
    mapping(address => gtUint256) balances;
    /// @notice Mapping of encrypted allowances for each address pair
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
    /// @notice Whether underlying token supports unwrap to native token (WETH/WPOL style)
    bool underlyingIsWrappedNative;
    /// @notice Clear underlying owed after an unshield push failed. Pull via `claimUnshielded`.
    mapping(address => uint256) claimableUnderlying;
    /// @notice Sum of `claimableUnderlying`. Emergency recovery leaves at least this much underlying in the contract.
    uint256 claimableUnderlyingTotal;
    /// @notice Incremented by emergency recovery. Callbacks for an older epoch are dropped.
    uint256 unshieldEpoch;
}

/// @notice OPRF note parameters as supplied by the note owner
struct OPRFToken {
    itUint128 x;
    itUint256 q;
    uint128 y_clear;
}

// keccak256(abi.encode(uint256(keccak256("bubble.storage.PrivateERC20Contract256")) - 1)) & ~bytes32(uint256(0xff))
bytes32 constant PRIVATE_ERC20_CONTRACT256_STORAGE_LOCATION = 0x9deef7192d493ef71cbd7c46c5b8e4088a630550d613be0294e8c5db63409100;

function privateERC20Storage() pure returns (PrivateERC20Contract256Storage storage $) {
    assembly {
        $.slot := PRIVATE_ERC20_CONTRACT256_STORAGE_LOCATION
    }
}

/// @notice Balance handle of `account`, or the stored zero handle if it was never set.
function privateBalanceOf(address account) view returns (gtUint256 balance) {
    PrivateERC20Contract256Storage storage $ = privateERC20Storage();
    balance = $.balances[account];
    if (gtUint256.unwrap(balance) == 0) {
        balance = $.zero;
    }
}
