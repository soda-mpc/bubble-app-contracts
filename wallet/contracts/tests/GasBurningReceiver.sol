// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

/// @notice Test payee whose `receive` burns all the gas it is given, so a native payout to it always fails.
contract GasBurningReceiver {
    receive() external payable {
        while (true) {}
    }
}
