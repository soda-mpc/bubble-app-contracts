// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@sodalabs/bubble-core-contracts/contracts/bubble/MpcCore.sol";
import "./IPrivateIdentityRegistry.sol";
import "./IPrivateModularCompliance.sol";

interface IPrivateERC3643Wrapper {
    event UpdatedTokenInformation(
        string indexed newName,
        string indexed newSymbol,
        uint8 newDecimals,
        string newVersion,
        address indexed newOnchainID
    );
    event IdentityRegistryAdded(address indexed identityRegistry);
    event ComplianceAdded(address indexed compliance);
    event AgentAdded(address indexed agent);
    event AgentRemoved(address indexed agent);
    event AddressFrozen(address indexed userAddress, bool indexed isFrozen, address indexed owner);
    event TokensFrozen(address indexed userAddress, gtUint256 amount);
    event TokensUnfrozen(address indexed userAddress, gtUint256 amount);

    function setName(string calldata name_) external;
    function setSymbol(string calldata symbol_) external;
    function setOnchainID(address onchainID_) external;
    function setIdentityRegistry(address identityRegistry_) external;
    function setCompliance(address compliance_) external;
    function addAgent(address agent) external;
    function removeAgent(address agent) external;
    function isAgent(address agent) external view returns (bool);
    function setAddressFrozen(address userAddress, bool freeze) external;
    function freezePartialTokens(address userAddress, itUint256 calldata it) external;
    function unfreezePartialTokens(address userAddress, itUint256 calldata it) external;
    function identityRegistry() external view returns (IPrivateIdentityRegistry);
    function compliance() external view returns (IPrivateModularCompliance);
    function onchainID() external view returns (address);
    function version() external pure returns (string memory);
    function isFrozen(address userAddress) external view returns (bool);
    function getFrozenTokens(address userAddress) external view returns (gtUint256);
}
