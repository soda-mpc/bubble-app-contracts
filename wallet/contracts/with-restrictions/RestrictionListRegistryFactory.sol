// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./RestrictionListRegistry.sol";

/// @title RestrictionListRegistryFactory
/// @notice Factory contract for creating RestrictionListRegistry instances
/// @dev This factory allows users to deploy new instances of RestrictionListRegistry with custom parameters
contract RestrictionListRegistryFactory {
    /// @notice Thrown when the initial owner address is zero
    error ZeroOwnerAddress();
    
    /// @notice Thrown when an empty list name is provided
    error EmptyListName();

    /// @notice Emitted when a new RestrictionListRegistry is created
    /// @param registry The address of the newly created registry
    /// @param initialOwner The owner of the new registry
    /// @param listName The name of the restriction list
    /// @param creator The address of the factory caller who created the registry
    event RegistryCreated(
        address indexed registry,
        address indexed initialOwner,
        string listName,
        address indexed creator
    );

    /// @notice Total number of registries created by this factory
    uint256 public totalRegistriesCreated;
    
    /// @notice Mapping to check if a registry was created by this factory
    mapping(address => bool) public isRegistryFromFactory;

    /// @notice Creates a new RestrictionListRegistry
    /// @param initialOwner The address that will own the new registry
    /// @param listName The human-readable name for the restriction list
    /// @return registry The address of the newly created RestrictionListRegistry
    function createRegistry(
        address initialOwner,
        string memory listName
    ) external returns (address registry) {
        if (initialOwner == address(0)) revert ZeroOwnerAddress();
        if (bytes(listName).length == 0) revert EmptyListName();

        // Deploy the new RestrictionListRegistry
        RestrictionListRegistry newRegistry = new RestrictionListRegistry(
            initialOwner,
            listName
        );
        registry = address(newRegistry);

        // Mark registry as created by this factory
        isRegistryFromFactory[registry] = true;
        totalRegistriesCreated++;

        emit RegistryCreated(registry, initialOwner, listName, msg.sender);
    }

    /// @notice Get the total number of registries created by this factory
    /// @return The total number of registries created
    function getTotalRegistriesCreated() external view returns (uint256) {
        return totalRegistriesCreated;
    }

    /// @notice Check if a registry was created by this factory
    /// @param registryAddress The address of the registry to check
    /// @return True if the registry was created by this factory
    function isCreatedByFactory(address registryAddress) external view returns (bool) {
        return isRegistryFromFactory[registryAddress];
    }
} 