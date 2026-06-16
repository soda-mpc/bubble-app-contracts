// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title PrivateERC3643ERC20Factory256
/// @notice Factory for creating ERC-3643-aware private ERC20 wrapper proxies.
contract PrivateERC3643ERC20Factory256 {
    error EmptyName();
    error EmptySymbol();
    error ZeroUnderlyingAddress();
    error ZeroImplementationAddress();
    error ZeroIdentityRegistry();
    error ZeroCompliance();
    error ZeroMaster();

    event TokenCreated(
        address indexed token,
        string name,
        string symbol,
        address indexed underlying,
        address indexed identityRegistry,
        address compliance,
        address onchainID,
        address creator,
        address master,
        bool underlyingIsWrappedNative
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
        address underlying,
        address identityRegistry,
        address compliance,
        address onchainID
    ) external returns (address token) {
        return _createToken(name, symbol, underlying, false, msg.sender, identityRegistry, compliance, onchainID);
    }

    function createToken(
        string memory name,
        string memory symbol,
        address underlying,
        bool underlyingIsWrappedNative,
        address identityRegistry,
        address compliance,
        address onchainID
    ) external returns (address token) {
        return _createToken(
            name,
            symbol,
            underlying,
            underlyingIsWrappedNative,
            msg.sender,
            identityRegistry,
            compliance,
            onchainID
        );
    }

    function createToken(
        string memory name,
        string memory symbol,
        address underlying,
        address master,
        address identityRegistry,
        address compliance,
        address onchainID
    ) external returns (address token) {
        return _createToken(name, symbol, underlying, false, master, identityRegistry, compliance, onchainID);
    }

    function createToken(
        string memory name,
        string memory symbol,
        address underlying,
        bool underlyingIsWrappedNative,
        address master,
        address identityRegistry,
        address compliance,
        address onchainID
    ) external returns (address token) {
        return _createToken(
            name,
            symbol,
            underlying,
            underlyingIsWrappedNative,
            master,
            identityRegistry,
            compliance,
            onchainID
        );
    }

    function _createToken(
        string memory name,
        string memory symbol,
        address underlying,
        bool underlyingIsWrappedNative,
        address master,
        address identityRegistry,
        address compliance,
        address onchainID
    ) internal returns (address token) {
        if (bytes(name).length == 0) revert EmptyName();
        if (bytes(symbol).length == 0) revert EmptySymbol();
        if (underlying == address(0)) revert ZeroUnderlyingAddress();
        if (identityRegistry == address(0)) revert ZeroIdentityRegistry();
        if (compliance == address(0)) revert ZeroCompliance();
        if (master == address(0)) revert ZeroMaster();

        IERC20(underlying).totalSupply();

        bytes memory initData = abi.encodeWithSignature(
            "initialize(string,string,address,address,address,bool,address,address,address)",
            name,
            symbol,
            underlying,
            msg.sender,
            master,
            underlyingIsWrappedNative,
            identityRegistry,
            compliance,
            onchainID
        );

        ERC1967Proxy proxy = new ERC1967Proxy(implementation, initData);
        token = address(proxy);

        isTokenFromFactory[token] = true;
        totalTokensCreated++;

        emit TokenCreated(
            token,
            name,
            symbol,
            underlying,
            identityRegistry,
            compliance,
            onchainID,
            msg.sender,
            master,
            underlyingIsWrappedNative
        );
    }

    function getTotalTokensCreated() external view returns (uint256) {
        return totalTokensCreated;
    }

    function isCreatedByFactory(address tokenAddress) external view returns (bool) {
        return isTokenFromFactory[tokenAddress];
    }
}
