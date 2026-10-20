// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Test contract a user calls directly that forwards arbitrary calldata to a target, as a phishing dApp or
///         a multicall would. Reverts bubble up unchanged.
contract CallRelayMock {
    function relay(address target, bytes calldata data) external {
        (bool ok, bytes memory ret) = target.call(data);
        if (!ok) {
            assembly {
                revert(add(ret, 32), mload(ret))
            }
        }
    }
}
