// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "./PrivateERC20WithRestrictionList256.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol";

/// @title PrivateERC20WithRestrictionListFactory256
/// @notice Factory contract for creating PrivateERC20WithRestrictionList256 tokens with MPC privacy features and restriction list integration
/// @dev This factory deploys UUPS proxies pointing to a shared implementation contract.
///      The implementation must be deployed separately and passed to the constructor.
contract PrivateERC20WithRestrictionListFactory256 {
    /// @notice Thrown when an empty name is provided
    error EmptyName();
    
    /// @notice Thrown when an empty symbol is provided
    error EmptySymbol();
    
    /// @notice Thrown when the underlying token address is zero
    error ZeroUnderlyingAddress();
    
    /// @notice Thrown when a restriction list registry address is zero
    error ZeroRestrictionListRegistry();
    
    /// @notice Thrown when the implementation address is zero
    error ZeroImplementationAddress();

    /// @notice Emitted when a new PrivateERC20WithRestrictionList256 token is created
    /// @param token The address of the newly created token (proxy address)
    /// @param name The name of the token
    /// @param symbol The symbol of the token
    /// @param underlying The address of the underlying ERC20 token
    /// @param restrictionListRegistries Array of restriction list registry addresses
    /// @param creator The address of the token creator
    event TokenCreated(
        address indexed token,
        string name,
        string symbol,
        address indexed underlying,
        address[] restrictionListRegistries,
        address indexed creator
    );

    /// @notice The implementation contract address for PrivateERC20WithRestrictionList256
    address public immutable implementation;

    /// @notice Total number of tokens created by this factory
    uint256 public totalTokensCreated;
    
    /// @notice Mapping to check if a token was created by this factory
    mapping(address => bool) public isTokenFromFactory;

    /// @notice Deploys the factory with the implementation contract
    /// @param implementation_ The address of the PrivateERC20WithRestrictionList256 implementation contract
    constructor(address implementation_) {
        if (implementation_ == address(0)) revert ZeroImplementationAddress();
        implementation = implementation_;
    }

    /// @notice Creates a new PrivateERC20WithRestrictionList256 token using UUPS proxy pattern
    /// @param name The name of the new token
    /// @param symbol The symbol of the new token  
    /// @param underlying The address of the underlying ERC20 token to wrap
    /// @param restrictionListRegistries Array of restriction list registry addresses to integrate with
    /// @return token The address of the newly created PrivateERC20WithRestrictionList256 token (proxy address)
    function createToken(
        string memory name,
        string memory symbol,
        address underlying,
        address[] memory restrictionListRegistries
    ) external returns (address token) {
        if (bytes(name).length == 0) revert EmptyName();
        if (bytes(symbol).length == 0) revert EmptySymbol();
        if (underlying == address(0)) revert ZeroUnderlyingAddress();
        
        // Validate restriction list registries
        for (uint256 i = 0; i < restrictionListRegistries.length; i++) {
            if (restrictionListRegistries[i] == address(0)) revert ZeroRestrictionListRegistry();
        }
        
        // Verify that the underlying address is a valid ERC20 contract
        IERC20 underlyingToken = IERC20(underlying);
        underlyingToken.totalSupply(); // Will revert if not a valid ERC20
        
        // Encode the initialize function call
        bytes memory initData = abi.encodeWithSignature(
            "initialize(string,string,address,address[],address,address)",
            name, 
            symbol, 
            underlying, 
            restrictionListRegistries,
            msg.sender,  // owner
            msg.sender   // master
        );
        
        // Deploy ERC1967Proxy pointing to the shared implementation
        ERC1967Proxy proxy = new ERC1967Proxy(implementation, initData);
        token = address(proxy);

        // Mark token as created by this factory
        isTokenFromFactory[token] = true;
        totalTokensCreated++;

        emit TokenCreated(token, name, symbol, underlying, restrictionListRegistries, msg.sender);
    }

    /// @notice Get the total number of tokens created by this factory
    /// @return The total number of tokens created
    function getTotalTokensCreated() external view returns (uint256) {
        return totalTokensCreated;
    }

    /// @notice Check if a token was created by this factory
    /// @param tokenAddress The address of the token to check
    /// @return True if the token was created by this factory
    function isCreatedByFactory(address tokenAddress) external view returns (bool) {
        return isTokenFromFactory[tokenAddress];
    }
}
