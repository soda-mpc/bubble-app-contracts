// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./PrivateERC20GaslessForwarder.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

interface IGaslessTokenFactoryInit {
    function initializeWithWrappedNative(
        string memory name_,
        string memory symbol_,
        address underlying_,
        address owner_,
        address master_,
        bool underlyingIsWrappedNative_
    ) external;

    function setTrustedForwarder(address forwarder) external;

    function transferOwnership(address newOwner) external;
}

/// @title PrivateERC20GaslessFactory
/// @notice Deploys PrivateERC20Contract256Gasless proxies and a PrivateERC20GaslessForwarder for each one.
/// @dev The factory is the token owner only for the creation transaction, so it can set the forwarder.
///      It then transfers ownership to the creator. The creator must call `acceptOwnership()` on the token
///      (Ownable2Step). The creator is the master address from the start.
contract PrivateERC20GaslessFactory {
    /// @notice Emitted when a new gasless private token and its forwarder are created.
    event TokenCreated(
        address indexed token,
        address indexed forwarder,
        address indexed creator,
        string name,
        string symbol,
        address underlying,
        bool underlyingIsWrappedNative
    );

    /// @notice Shared PrivateERC20Contract256Gasless implementation. Must be linked to PrivateOPRFNotes.
    address public immutable implementation;

    /// @notice Total number of tokens created by this factory.
    uint256 public totalTokensCreated;

    /// @notice True when `token` was created by this factory.
    mapping(address => bool) public isTokenFromFactory;

    /// @notice Forwarder deployed for a token created by this factory.
    mapping(address => address) public tokenForwarder;

    /// @param implementation_ PrivateERC20Contract256Gasless implementation.
    constructor(address implementation_) {
        require(implementation_ != address(0), "Implementation cannot be zero address");
        implementation = implementation_;
    }

    /// @notice Creates a gasless private token for `underlying`.
    function createToken(
        string memory name,
        string memory symbol,
        address underlying
    ) external returns (address token, address forwarder) {
        return _createToken(name, symbol, underlying, false);
    }

    /// @notice Creates a gasless private token and sets whether underlying unwraps to native.
    function createToken(
        string memory name,
        string memory symbol,
        address underlying,
        bool underlyingIsWrappedNative
    ) external returns (address token, address forwarder) {
        return _createToken(name, symbol, underlying, underlyingIsWrappedNative);
    }

    function _createToken(
        string memory name,
        string memory symbol,
        address underlying,
        bool underlyingIsWrappedNative
    ) internal returns (address token, address forwarder) {
        require(bytes(name).length > 0, "Name cannot be empty");
        require(bytes(symbol).length > 0, "Symbol cannot be empty");
        require(underlying != address(0), "Underlying cannot be zero address");

        IERC20 underlyingToken = IERC20(underlying);
        require(underlyingToken.totalSupply() >= 0, "Invalid ERC20 contract");

        // Factory is the initial owner so it can set the forwarder. Creator is master, and pending owner.
        bytes memory initData = abi.encodeWithSelector(
            IGaslessTokenFactoryInit.initializeWithWrappedNative.selector,
            name,
            symbol,
            underlying,
            address(this),
            msg.sender,
            underlyingIsWrappedNative
        );

        ERC1967Proxy proxy = new ERC1967Proxy(implementation, initData);
        token = address(proxy);

        PrivateERC20GaslessForwarder fwd = new PrivateERC20GaslessForwarder(token);
        forwarder = address(fwd);

        IGaslessTokenFactoryInit created = IGaslessTokenFactoryInit(token);
        created.setTrustedForwarder(forwarder);
        created.transferOwnership(msg.sender);

        isTokenFromFactory[token] = true;
        tokenForwarder[token] = forwarder;
        totalTokensCreated++;

        emit TokenCreated(token, forwarder, msg.sender, name, symbol, underlying, underlyingIsWrappedNative);
    }
}
