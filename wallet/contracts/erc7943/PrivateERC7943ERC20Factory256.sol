// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";

/// @title PrivateERC7943ERC20Factory256
/// @notice Factory for creating ERC-7943-aware private ERC20 wrapper proxies.
contract PrivateERC7943ERC20Factory256 {
    error EmptyName();
    error EmptySymbol();
    error ZeroUnderlyingAddress();
    error ZeroImplementationAddress();
    error ZeroMaster();

    event TokenCreated(
        address indexed token,
        string name,
        string symbol,
        address indexed underlying,
        address creator,
        address indexed master,
        bool underlyingIsWrappedNative,
        bool defaultSendAllowed,
        bool defaultReceiveAllowed
    );

    address public immutable implementation;
    uint256 public totalTokensCreated;
    mapping(address => bool) public isTokenFromFactory;

    constructor(address implementation_) {
        if (implementation_ == address(0)) revert ZeroImplementationAddress();
        implementation = implementation_;
    }

    function createToken(string memory name, string memory symbol, address underlying)
        external
        returns (address token)
    {
        return _createToken(name, symbol, underlying, false, msg.sender, false, false);
    }

    function createToken(
        string memory name,
        string memory symbol,
        address underlying,
        bool underlyingIsWrappedNative
    ) external returns (address token) {
        return _createToken(name, symbol, underlying, underlyingIsWrappedNative, msg.sender, false, false);
    }

    function createToken(
        string memory name,
        string memory symbol,
        address underlying,
        address master
    ) external returns (address token) {
        return _createToken(name, symbol, underlying, false, master, false, false);
    }

    function createToken(
        string memory name,
        string memory symbol,
        address underlying,
        bool underlyingIsWrappedNative,
        address master
    ) external returns (address token) {
        return _createToken(name, symbol, underlying, underlyingIsWrappedNative, master, false, false);
    }

    function createToken(
        string memory name,
        string memory symbol,
        address underlying,
        bool underlyingIsWrappedNative,
        address master,
        bool defaultSendAllowed,
        bool defaultReceiveAllowed
    ) external returns (address token) {
        return _createToken(
            name,
            symbol,
            underlying,
            underlyingIsWrappedNative,
            master,
            defaultSendAllowed,
            defaultReceiveAllowed
        );
    }

    function _createToken(
        string memory name,
        string memory symbol,
        address underlying,
        bool underlyingIsWrappedNative,
        address master,
        bool defaultSendAllowed,
        bool defaultReceiveAllowed
    ) internal returns (address token) {
        if (bytes(name).length == 0) revert EmptyName();
        if (bytes(symbol).length == 0) revert EmptySymbol();
        if (underlying == address(0)) revert ZeroUnderlyingAddress();
        if (master == address(0)) revert ZeroMaster();

        IERC20(underlying).totalSupply();

        bytes memory initData = abi.encodeWithSignature(
            "initialize(string,string,address,address,address,bool,bool,bool)",
            name,
            symbol,
            underlying,
            msg.sender,
            master,
            underlyingIsWrappedNative,
            defaultSendAllowed,
            defaultReceiveAllowed
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
            msg.sender,
            master,
            underlyingIsWrappedNative,
            defaultSendAllowed,
            defaultReceiveAllowed
        );
    }

    function getTotalTokensCreated() external view returns (uint256) {
        return totalTokensCreated;
    }

    function isCreatedByFactory(address tokenAddress) external view returns (bool) {
        return isTokenFromFactory[tokenAddress];
    }
}
