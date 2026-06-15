// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../erc3643/interfaces/IPrivateIdentity.sol";
import "../erc3643/interfaces/IPrivateIdentityRegistry.sol";

contract MockPrivateIdentityRegistry is IPrivateIdentityRegistry {
    mapping(address => bool) private _verified;
    mapping(address => IPrivateIdentity) private _identities;
    mapping(address => uint16) private _countries;

    event VerificationSet(address indexed user, bool verified);

    function setVerified(address user, bool verified) external {
        _verified[user] = verified;
        emit VerificationSet(user, verified);
    }

    function isVerified(address userAddress) external view override returns (bool) {
        return _verified[userAddress];
    }

    function registerIdentity(address userAddress, IPrivateIdentity identity, uint16 country) external override {
        _verified[userAddress] = true;
        _identities[userAddress] = identity;
        _countries[userAddress] = country;
    }

    function deleteIdentity(address userAddress) external override {
        _verified[userAddress] = false;
        delete _identities[userAddress];
        delete _countries[userAddress];
    }

    function investorCountry(address userAddress) external view override returns (uint16) {
        return _countries[userAddress];
    }
}
