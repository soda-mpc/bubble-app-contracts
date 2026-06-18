// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@sodalabs/bubble-core-contracts/contracts/bubble/MpcCore.sol";
import "./IPrivateIdentityRegistry.sol";
import "./IPrivateSecurityTokenCompliance.sol";

interface IPrivateERC3643SecurityToken {
    event Transfer(address indexed from, address indexed to);
    event Approval(address indexed owner, address indexed spender, uint256 value);
    event Approval(address indexed owner, address indexed spender);
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
    event AddressFrozen(address indexed userAddress, bool indexed isFrozen, address indexed agent);
    event TokensFrozen(address indexed userAddress, gtUint256 amount);
    event TokensUnfrozen(address indexed userAddress, gtUint256 amount);
    event PrivateMint(address indexed to, gtUint256 amount);
    event PrivateBurn(address indexed from, gtUint256 requestedAmount, gtUint256 realBurned);
    event PrivateTotalSupplyUpdated(gtUint256 totalSupply);
    event ForcedTransfer(address indexed from, address indexed to, gtUint256 actualAmount);

    function setName(string calldata name_) external;
    function setSymbol(string calldata symbol_) external;
    function setOnchainID(address onchainID_) external;
    function setIdentityRegistry(address identityRegistry_) external;
    function setCompliance(address compliance_) external;
    function addAgent(address agent) external;
    function removeAgent(address agent) external;
    function isAgent(address agent) external view returns (bool);
    function mint(address to, itUint256 calldata it) external returns (bool);
    function burn(address from, itUint256 calldata it) external returns (bool);
    function setAddressFrozen(address userAddress, bool freeze) external;
    function freezePartialTokens(address userAddress, itUint256 calldata it) external;
    function unfreezePartialTokens(address userAddress, itUint256 calldata it) external;
    function forcedTransfer(address from, address to, itUint256 calldata it) external returns (bool);
    function identityRegistry() external view returns (IPrivateIdentityRegistry);
    function compliance() external view returns (IPrivateSecurityTokenCompliance);
    function onchainID() external view returns (address);
    function version() external pure returns (string memory);
    function isFrozen(address userAddress) external view returns (bool);
    function getFrozenTokens(address userAddress) external view returns (gtUint256);
}
