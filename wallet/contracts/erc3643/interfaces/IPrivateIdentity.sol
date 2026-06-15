// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

interface IPrivateIdentity {
    function keyHasPurpose(bytes32 key, uint256 purpose) external view returns (bool);
}
