// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title PrivateERC3643SecurityTokenFactory256
/// @notice Factory for creating private ERC-3643 security token proxies.
contract PrivateERC3643SecurityTokenFactory256 {
    error EmptyName();
    error EmptySymbol();
    error ZeroImplementationAddress();
    error ZeroIdentityRegistry();
    error ZeroCompliance();

    event TokenCreated(
        address indexed token,
        string name,
        string symbol,
        uint8 decimals,
        address indexed identityRegistry,
        address compliance,
        address onchainID,
        address indexed creator
    );

    address public immutable implementation;
    uint256 public totalTokensCreated;
    mapping(address => bool) public isTokenFromFactory;

    constructor(address implementation_) {
        if (implementation_ == address(0)) revert ZeroImplementationAddress();
        implementation = implementation_;
    }

    function createToken(
        string memory name,
        string memory symbol,
        uint8 decimals,
        address identityRegistry,
        address compliance,
        address onchainID
    ) external returns (address token) {
        if (bytes(name).length == 0) revert EmptyName();
        if (bytes(symbol).length == 0) revert EmptySymbol();
        if (identityRegistry == address(0)) revert ZeroIdentityRegistry();
        if (compliance == address(0)) revert ZeroCompliance();

        bytes memory initData = abi.encodeWithSignature(
            "initialize(string,string,uint8,address,address,address,address)",
            name,
            symbol,
            decimals,
            msg.sender,
            identityRegistry,
            compliance,
            onchainID
        );

        ERC1967Proxy proxy = new ERC1967Proxy(implementation, initData);
        token = address(proxy);

        isTokenFromFactory[token] = true;
        totalTokensCreated++;

        emit TokenCreated(token, name, symbol, decimals, identityRegistry, compliance, onchainID, msg.sender);
    }

    function getTotalTokensCreated() external view returns (uint256) {
        return totalTokensCreated;
    }

    function isCreatedByFactory(address tokenAddress) external view returns (bool) {
        return isTokenFromFactory[tokenAddress];
    }
}
