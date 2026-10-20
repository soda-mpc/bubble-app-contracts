// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Test target for PrivateERC20GaslessForwarder: reads the ERC-2771 signer like the gasless token does and
///         records who it saw, so tests can check that a forwarded call runs as the signer.
contract ERC2771TargetMock {
    string public name;
    address public trustedForwarder;

    address public lastSender;
    uint256 public lastValue;
    address public lastGrantUser;
    uint256 public lastGrantNonce;
    /// @notice Number of calls seen, so tests can check the grant is consumed before the operation.
    uint256 public callCount;
    uint256 public grantCallIndex;
    uint256 public recordCallIndex;

    constructor(string memory name_) {
        name = name_;
    }

    function setTrustedForwarder(address forwarder) external {
        trustedForwarder = forwarder;
    }

    function isTrustedForwarder(address forwarder) public view returns (bool) {
        return forwarder != address(0) && forwarder == trustedForwarder;
    }

    function record(uint256 value) external {
        lastSender = _msgSender();
        lastValue = value;
        recordCallIndex = ++callCount;
    }

    function consumeInsertGrant(uint256 insertNonce, bytes calldata) external {
        lastGrantUser = _msgSender();
        lastGrantNonce = insertNonce;
        grantCallIndex = ++callCount;
    }

    function fail() external pure {
        revert("target failed");
    }

    function _msgSender() private view returns (address) {
        if (isTrustedForwarder(msg.sender) && msg.data.length >= 20) {
            return address(bytes20(msg.data[msg.data.length - 20:]));
        }
        return msg.sender;
    }
}
