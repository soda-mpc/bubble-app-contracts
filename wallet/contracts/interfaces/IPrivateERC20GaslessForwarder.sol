// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice ERC-2771 forwarder bound to one PrivateERC20Contract256Gasless token.
interface IPrivateERC20GaslessForwarder {
    event AuthorizationExecuted(address indexed from, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed from, bytes32 indexed nonce);

    function EXECUTE_WITH_AUTHORIZATION_TYPEHASH() external view returns (bytes32);
    function CANCEL_AUTHORIZATION_TYPEHASH() external view returns (bytes32);

    /// @notice The token this forwarder relays to.
    function token() external view returns (address);
    function authorizationUsed(address authorizer, bytes32 nonce) external view returns (bool);
    function domainSeparator() external view returns (bytes32);

    function executeWithAuthorization(
        address from,
        bytes calldata data,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature,
        uint256 insertNonce,
        bytes calldata insertSignature
    ) external returns (bytes memory);

    function cancelAuthorization(bytes32 nonce) external;
    function cancelAuthorizationWithSig(address authorizer, bytes32 nonce, bytes calldata signature) external;
}
