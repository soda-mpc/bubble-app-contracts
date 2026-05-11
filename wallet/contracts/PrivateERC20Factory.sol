// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./PrivateERC20Contract256.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title PrivateERC20Factory
/// @notice Factory contract for creating PrivateERC20 tokens with MPC privacy features
/// @dev This factory allows users to deploy new instances of PrivateERC20Contract256 with custom parameters.
///      The factory deploys upgradeable contracts using UUPS proxy pattern.
contract PrivateERC20Factory {
    /// @notice Emitted when a new PrivateERC20 token is created
    /// @param token The address of the newly created token (proxy address)
    /// @param name The name of the token
    /// @param symbol The symbol of the token
    /// @param underlying The address of the underlying ERC20 token
    /// @param creator The address of the token creator
    event TokenCreated(
        address indexed token,
        string name,
        string symbol,
        address indexed underlying,
        address indexed creator
    );

    /// @notice The implementation contract address for PrivateERC20Contract256
    address public immutable implementation;

    /// @notice Total number of tokens created by this factory
    uint256 public totalTokensCreated;
    
    /// @notice Mapping to check if a token was created by this factory
    mapping(address => bool) public isTokenFromFactory;

    /// @notice Deploys the factory with the implementation contract
    /// @param implementation_ The address of the PrivateERC20Contract256 implementation contract
    constructor(address implementation_) {
        require(implementation_ != address(0), "Implementation cannot be zero address");
        implementation = implementation_;
    }

    /// @notice Creates a new PrivateERC20 token using UUPS proxy pattern
    /// @param name The name of the new token
    /// @param symbol The symbol of the new token  
    /// @param underlying The address of the underlying ERC20 token to wrap
    /// @return token The address of the newly created PrivateERC20Contract256 token (proxy address)
    function createToken(
        string memory name,
        string memory symbol,
        address underlying
    ) external returns (address token) {
        require(bytes(name).length > 0, "Name cannot be empty");
        require(bytes(symbol).length > 0, "Symbol cannot be empty");
        require(underlying != address(0), "Underlying cannot be zero address");
        
        // Verify that the underlying address is a valid ERC20 contract
        // This will revert if the underlying address is not a valid ERC20
        IERC20 underlyingToken = IERC20(underlying);
        require(underlyingToken.totalSupply() >= 0, "Invalid ERC20 contract");

        // Encode the initialize function call
        bytes memory initData = abi.encodeWithSelector(
            PrivateERC20Contract256.initialize.selector,
            name,
            symbol,
            underlying,
            msg.sender,
            msg.sender
        );

        // Deploy the proxy pointing to the implementation
        ERC1967Proxy proxy = new ERC1967Proxy(implementation, initData);
        token = address(proxy);

        // Mark token as created by this factory
        isTokenFromFactory[token] = true;
        totalTokensCreated++;

        emit TokenCreated(token, name, symbol, underlying, msg.sender);
    }
} 