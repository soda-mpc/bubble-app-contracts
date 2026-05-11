// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IRestrictionList.sol";
import "@openzeppelin/contracts/access/Ownable.sol";
import "@openzeppelin/contracts/utils/structs/EnumerableSet.sol";

/// @title RestrictionListRegistry
/// @notice A concrete implementation of the IRestrictionList interface
/// @dev This contract allows the owner to maintain a restriction list of addresses
/// Other contracts can query this registry to check if addresses are restricted
contract RestrictionListRegistry is IRestrictionList, Ownable {
    using EnumerableSet for EnumerableSet.AddressSet;
    
    /// @notice Custom errors for gas-efficient reverts
    error CannotRestrictZeroAddress();
    error CannotRestrictOwner(address owner);
    error AccountAlreadyRestricted(address account);
    error AccountNotRestricted(address account);
    error EmptyAccountsArray();
    error TooManyAccounts(uint256 provided, uint256 maximum);
    error IndexOutOfBounds(uint256 index, uint256 length);
    
    /// @notice The human-readable name of this restriction list
    string public listName;
    
    /// @notice Set of restricted addresses for efficient enumeration
    EnumerableSet.AddressSet private _restrictedAddresses;
    
    /// @notice Maximum number of accounts that can be processed in batch operations
    uint256 public constant MAX_BATCH_SIZE = 100;
    
    /// @notice Emitted when ownership transfer is attempted with a restricted address
    event OwnershipTransferBlocked(address indexed newOwner);

    /// @notice Constructor sets the initial owner and list name
    /// @param initialOwner The address that will own this contract
    /// @param _listName The human-readable name for this restriction list
    constructor(address initialOwner, string memory _listName) Ownable(initialOwner) {
        // OpenZeppelin's Ownable constructor already validates that initialOwner != address(0)
        listName = _listName;
    }

    /// @notice Modifier to prevent restricted addresses from becoming owner
    modifier notRestricted(address account) {
        if (_restrictedAddresses.contains(account)) revert AccountAlreadyRestricted(account);
        _;
    }

    /// @notice Get the name of this restriction list
    /// @return The human-readable name of the restriction list
    function name() external view override returns (string memory) {
        return listName;
    }

    /// @notice Check if an address is restricted
    /// @param account The address to check
    /// @return True if the address is restricted, false otherwise
    function isRestricted(address account) external view override returns (bool) {
        return _restrictedAddresses.contains(account);
    }

    /// @notice Add an address to the restriction list
    /// @dev Only the owner can call this function
    /// @param account The address to restrict
    function addToRestrictionList(address account) external override onlyOwner {
        _addToRestrictionList(account);
    }

    /// @notice Remove an address from the restriction list
    /// @dev Only the owner can call this function
    /// @param account The address to remove from restriction list
    function removeFromRestrictionList(address account) external override onlyOwner {
        _removeFromRestrictionList(account);
    }

    /// @notice Add multiple addresses to the restriction list in a single transaction
    /// @dev Only the owner can call this function. Emits individual AddedToRestrictionList events for each address
    /// @param accounts Array of addresses to restrict
    function addMultipleToRestrictionList(address[] calldata accounts) external override onlyOwner {
        if (accounts.length == 0) revert EmptyAccountsArray();
        if (accounts.length > MAX_BATCH_SIZE) revert TooManyAccounts(accounts.length, MAX_BATCH_SIZE);

        for (uint256 i = 0; i < accounts.length; i++) {
            _addToRestrictionList(accounts[i]);
        }
    }

    /// @notice Remove multiple addresses from the restriction list in a single transaction
    /// @dev Only the owner can call this function. Emits individual RemovedFromRestrictionList events for each address
    /// @param accounts Array of addresses to remove from restriction list
    function removeMultipleFromRestrictionList(address[] calldata accounts) external override onlyOwner {
        if (accounts.length == 0) revert EmptyAccountsArray();
        if (accounts.length > MAX_BATCH_SIZE) revert TooManyAccounts(accounts.length, MAX_BATCH_SIZE);

        for (uint256 i = 0; i < accounts.length; i++) {
            _removeFromRestrictionList(accounts[i]);
        }
    }

    function _addToRestrictionList(address account) internal {
        if (account == address(0)) revert CannotRestrictZeroAddress();
        if (account == owner()) revert CannotRestrictOwner(account);
        if (_restrictedAddresses.contains(account)) revert AccountAlreadyRestricted(account);

        _restrictedAddresses.add(account);
        emit AddedToRestrictionList(account, msg.sender);
    }

    function _removeFromRestrictionList(address account) internal {
        if (!_restrictedAddresses.contains(account)) revert AccountNotRestricted(account);

        _restrictedAddresses.remove(account);
        emit RemovedFromRestrictionList(account, msg.sender);
    }

    /// @notice Get the total number of restricted addresses
    /// @return The count of restricted addresses
    function restrictionListCount() external view override returns (uint256) {
        return _restrictedAddresses.length();
    }

    /// @notice Get a restricted address by index
    /// @dev Useful for off-chain enumeration of restricted addresses
    /// @param index The index to query
    /// @return The restricted address at the given index
    function restrictedAddressAt(uint256 index) external view returns (address) {
        if (index >= _restrictedAddresses.length()) {
            revert IndexOutOfBounds(index, _restrictedAddresses.length());
        }
        return _restrictedAddresses.at(index);
    }

    /// @notice Get all restricted addresses
    /// @dev Warning: This can be gas-intensive for large restriction lists. Use with caution.
    /// @return Array of all restricted addresses
    function getAllRestrictedAddresses() external view returns (address[] memory) {
        return _restrictedAddresses.values();
    }

    /// @notice Override transferOwnership to prevent restricted addresses from becoming owner
    /// @param newOwner The address to transfer ownership to
    function transferOwnership(address newOwner) public override onlyOwner notRestricted(newOwner) {
        super.transferOwnership(newOwner);
    }

    /// @notice Emergency function to clear all restricted addresses
    /// @dev Only the owner can call this function. Use with extreme caution.
    function clearRestrictionList() external onlyOwner {
        address[] memory allRestricted = _restrictedAddresses.values();
        
        for (uint256 i = 0; i < allRestricted.length; i++) {
            _restrictedAddresses.remove(allRestricted[i]);
            // Emit individual event for each removal
            emit RemovedFromRestrictionList(allRestricted[i], msg.sender);
        }
    }
} 