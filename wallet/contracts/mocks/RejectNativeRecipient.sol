// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

contract RejectNativeRecipient {
    receive() external payable {
        revert("Native rejected");
    }
}
