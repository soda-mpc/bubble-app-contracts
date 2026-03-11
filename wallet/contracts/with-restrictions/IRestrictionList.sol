// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IRestrictionList
/// @notice Standard interface for restriction list functionality
/// @dev This interface allows contracts to check if addresses are restricted
/// and provides standard methods for restriction list management
interface IRestrictionList {
    /// @notice Emitted when an address is added to the restriction list
    /// @param account The address that was restricted
    /// @param admin The address that performed the action
    event AddedToRestrictionList(address indexed account, address indexed admin);
    
    /// @notice Emitted when an address is removed from the restriction list
    /// @param account The address that was removed from restriction list
    /// @param admin The address that performed the action
    event RemovedFromRestrictionList(address indexed account, address indexed admin);

    /// @notice Get the name of this restriction list
    /// @return The human-readable name of the restriction list
    function name() external view returns (string memory);

    /// @notice Check if an address is restricted
    /// @param account The address to check
    /// @return True if the address is restricted, false otherwise
    function isRestricted(address account) external view returns (bool);
    
    /// @notice Add an address to the restriction list
    /// @dev Should be restricted to authorized accounts only
    /// @param account The address to restrict
    function addToRestrictionList(address account) external;
    
    /// @notice Remove an address from the restriction list
    /// @dev Should be restricted to authorized accounts only
    /// @param account The address to remove from restriction list
    function removeFromRestrictionList(address account) external;
    
    /// @notice Add multiple addresses to the restriction list in a single transaction
    /// @dev Should be restricted to authorized accounts only. Emits individual AddedToRestrictionList events
    /// @param accounts Array of addresses to restrict
    function addMultipleToRestrictionList(address[] calldata accounts) external;
    
    /// @notice Remove multiple addresses from the restriction list in a single transaction
    /// @dev Should be restricted to authorized accounts only. Emits individual RemovedFromRestrictionList events
    /// @param accounts Array of addresses to remove from restriction list
    function removeMultipleFromRestrictionList(address[] calldata accounts) external;
    
    /// @notice Get the total number of restricted addresses
    /// @return The count of restricted addresses
    function restrictionListCount() external view returns (uint256);
} 