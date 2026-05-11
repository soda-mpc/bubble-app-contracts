// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Minimal registry mock that always reverts on restriction checks.
contract RevertingRestrictionList {
    function name() external pure returns (string memory) {
        return "Reverting Restriction List";
    }

    function isRestricted(address) external pure returns (bool) {
        revert("forced failure");
    }
}
