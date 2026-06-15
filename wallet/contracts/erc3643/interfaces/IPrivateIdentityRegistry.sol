// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./IPrivateIdentity.sol";

interface IPrivateIdentityRegistry {
    function isVerified(address userAddress) external view returns (bool);
    function registerIdentity(address userAddress, IPrivateIdentity identity, uint16 country) external;
    function deleteIdentity(address userAddress) external;
    function investorCountry(address userAddress) external view returns (uint16);
}
