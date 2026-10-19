// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import "@sodalabs/bubble-core-contracts/contracts/bubble/MpcCore.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @notice Storage for unshield requests
struct UnshieldRequest {
    address user;
    bool unwrapNative;
    /// @notice `unshieldEpoch` when the request was created. Emergency recovery invalidates older requests.
    uint256 epoch;
}

/// @notice Storage of PrivateERC20Contract256Gasless, shared with its PrivateLedger library.
/// @dev The token inherits this contract so the upgrades plugin sees the annotated namespace and validates it.
///      Libraries use the `PrivateERC20GaslessStorage.Layout` type through `gaslessStorage()`. The layout is
///      append-only: never reorder, retype or remove a field.
abstract contract PrivateERC20GaslessStorage {
    /// @custom:storage-location erc7201:bubble.storage.PrivateERC20Gasless
    struct Layout {
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
        /// @notice ERC-2771 forwarder whose calls carry the signer as the last 20 bytes of calldata. Zero disables it.
        address trustedForwarder;
        /// @notice Set by emergency recovery. A retired token stays paused.
        bool retired;
    }
}

// keccak256(abi.encode(uint256(keccak256("bubble.storage.PrivateERC20Gasless")) - 1)) & ~bytes32(uint256(0xff))
bytes32 constant PRIVATE_ERC20_GASLESS_STORAGE_LOCATION = 0x723dce8969bfc779025e7294feda768a136910d15014f276e725c5b3cde3b400;

function gaslessStorage() pure returns (PrivateERC20GaslessStorage.Layout storage $) {
    assembly {
        $.slot := PRIVATE_ERC20_GASLESS_STORAGE_LOCATION
    }
}
