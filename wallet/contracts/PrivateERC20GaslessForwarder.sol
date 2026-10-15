// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts/utils/cryptography/EIP712.sol";
import "@openzeppelin/contracts/utils/cryptography/SignatureChecker.sol";

interface IPrivateERC20GaslessToken {
    function consumeInsertGrant(uint256 insertNonce, bytes calldata insertSignature) external;
}

/// @title PrivateERC20GaslessForwarder
/// @notice ERC-2771 forwarder for one PrivateERC20Contract256Gasless token. A facilitator submits a user's EIP-712
///         authorization; the forwarder verifies it and calls the token with `data` plus the signer appended, so the
///         token runs the call as the signer.
/// @dev The token must list this contract as its trusted forwarder. The token decides what a forwarded call may do:
///      admin functions ignore the forwarder, and OPRF destination rules treat the signer as the authorizer.
///      This contract holds no token balances or MPC permissions.
contract PrivateERC20GaslessForwarder is EIP712 {
    bytes32 public constant EXECUTE_WITH_AUTHORIZATION_TYPEHASH = keccak256(
        "ExecuteWithAuthorization(address from,bytes data,uint256 validAfter,uint256 validBefore,bytes32 nonce)"
    );

    /// @notice The token this forwarder relays to.
    address public immutable token;

    mapping(address => mapping(bytes32 => bool)) public authorizationUsed;

    event AuthorizationExecuted(address indexed from, bytes32 indexed nonce);
    event AuthorizationCanceled(address indexed from, bytes32 indexed nonce);

    /// @dev EIP-712 domain: name = token name, version "1", verifyingContract = this forwarder.
    ///      The name is fixed here, so the token proxy must already be initialized.
    constructor(address token_) EIP712(IERC20Metadata(token_).name(), "1") {
        require(token_ != address(0), "Token cannot be zero address");
        require(bytes(IERC20Metadata(token_).name()).length != 0, "Token name empty");
        token = token_;
    }

    /// @notice Runs `data` (calldata for a token entrypoint) on the token as `from`.
    /// @dev Reverts, and leaves the nonce unused, if the token call reverts.
    ///      `insertSignature` is an optional GCACL transient insert grant from `from` for the token. It is needed
    ///      when `data` carries ciphertexts and `from` has not granted the token insert access.
    function executeWithAuthorization(
        address from,
        bytes calldata data,
        uint256 validAfter,
        uint256 validBefore,
        bytes32 nonce,
        bytes calldata signature,
        uint256 insertNonce,
        bytes calldata insertSignature
    ) external returns (bytes memory) {
        require(from != address(0), "from cannot be zero");
        require(data.length >= 4, "empty data");
        require(block.timestamp > validAfter, "Auth not yet valid");
        require(block.timestamp < validBefore, "Auth expired");
        require(!authorizationUsed[from][nonce], "Auth used");

        bytes32 structHash = keccak256(
            abi.encode(EXECUTE_WITH_AUTHORIZATION_TYPEHASH, from, keccak256(data), validAfter, validBefore, nonce)
        );
        require(
            SignatureChecker.isValidSignatureNow(from, _hashTypedDataV4(structHash), signature),
            "Invalid signature"
        );
        // Neither contract signs today. Reject them anyway so a later EIP-1271 implementation cannot
        // authorize a call as the token or as this forwarder.
        require(from != token && from != address(this), "from cannot be token or forwarder");
        authorizationUsed[from][nonce] = true;

        if (insertSignature.length != 0) {
            _call(from, abi.encodeCall(IPrivateERC20GaslessToken.consumeInsertGrant, (insertNonce, insertSignature)));
        }
        bytes memory ret = _call(from, data);

        emit AuthorizationExecuted(from, nonce);
        return ret;
    }

    /// @notice Invalidates an unused authorization of the caller (EIP-3009 style), e.g. one sent to a facilitator
    ///         that should no longer run.
    function cancelAuthorization(bytes32 nonce) external {
        require(!authorizationUsed[msg.sender][nonce], "Auth used");
        authorizationUsed[msg.sender][nonce] = true;
        emit AuthorizationCanceled(msg.sender, nonce);
    }

    /// @notice EIP-712 domain separator for clients building signatures.
    function domainSeparator() external view returns (bytes32) {
        return _domainSeparatorV4();
    }

    /// @dev ERC-2771 call: `from` is appended to the calldata and bubbled reverts keep the token's error.
    function _call(address from, bytes memory data) private returns (bytes memory ret) {
        bool ok;
        (ok, ret) = token.call(abi.encodePacked(data, from));
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
