// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "./IRestrictionList.sol";

/// @title RestrictionListIntegration
/// @notice A helper contract that provides restriction list integration functionality
/// @dev Contracts can inherit from this to easily integrate with multiple restriction list registries
abstract contract RestrictionListIntegration {
    /// @notice Custom errors for gas-efficient reverts
    error AccountIsRestricted(address account, address registry);
    error NoRestrictionRegistrySet();
    error RegistryAlreadyExists(address registry);
    error RegistryNotFound(address registry);
    error TooManyRegistries(uint256 current, uint256 maximum);
    error InvalidRegistry();
    
    /// @notice Array of active restriction list registries
    address[] private _restrictionListRegistries;
    
    /// @notice Mapping to track if a registry is active (for O(1) lookup)
    mapping(address => bool) private _isActiveRegistry;
    
    /// @notice Maximum number of registries that can be active simultaneously
    uint256 public constant MAX_REGISTRIES = 10;
    
    /// @notice Emitted when a restriction list registry is added
    /// @param registry The address of the added registry
    /// @param admin The address that performed the action
    event RestrictionListRegistryAdded(address indexed registry, address indexed admin);
    
    /// @notice Emitted when a restriction list registry is removed
    /// @param registry The address of the removed registry
    /// @param admin The address that performed the action
    event RestrictionListRegistryRemoved(address indexed registry, address indexed admin);

    /// @notice Emitted when a restricted address attempts a restricted operation
    /// @param account The restricted address
    /// @param registry The registry that restricted the address
    /// @param operation A description of the attempted operation
    event RestrictedAddressBlocked(address indexed account, address indexed registry, string operation);

    /// @notice Constructor to set initial restriction list registries (for non-upgradeable contracts)
    /// @param _initialRegistries Array of restriction list registry addresses
    constructor(address[] memory _initialRegistries) {
        _initializeRestrictionListRegistries(_initialRegistries);
    }

    /// @notice Internal function to initialize restriction list registries (for upgradeable contracts)
    /// @param _initialRegistries Array of restriction list registry addresses
    function _initializeRestrictionListRegistries(address[] memory _initialRegistries) internal {
        if (_initialRegistries.length > MAX_REGISTRIES) {
            revert TooManyRegistries(_initialRegistries.length, MAX_REGISTRIES);
        }
        
        for (uint256 i = 0; i < _initialRegistries.length; i++) {
            address registry = _initialRegistries[i];
            if (registry != address(0) && !_isActiveRegistry[registry]) {
                _restrictionListRegistries.push(registry);
                _isActiveRegistry[registry] = true;
            }
        }
    }

    /// @notice Modifier to check if an address is not restricted by any active registry
    /// @param account The address to check
    modifier notRestricted(address account) {
        _requireNotRestricted(account);
        _;
    }

    /// @notice Modifier to check if multiple addresses are not restricted by any active registry
    /// @param accounts Array of addresses to check
    modifier notRestrictedMultiple(address[] memory accounts) {
        for (uint256 i = 0; i < accounts.length; i++) {
            _requireNotRestricted(accounts[i]);
        }
        _;
    }

    /// @notice Modifier to check if both sender and receiver are not restricted by any active registry
    /// @param from The sender address
    /// @param to The receiver address
    modifier notRestrictedTransfer(address from, address to) {
        _requireNotRestricted(from);
        _requireNotRestricted(to);
        _;
    }

    /// @notice Check if an address is restricted by any active registry
    /// @param account The address to check
    /// @return True if restricted by any registry, false otherwise
    function isRestricted(address account) public view virtual returns (bool) {
        return _getRestrictingRegistry(account) != address(0);
    }

    /// @notice Get the first registry that restricts an address
    /// @param account The address to check
    /// @return The address of the restricting registry, or address(0) if not restricted
    function getRestrictingRegistry(address account) public view returns (address) {
        return _getRestrictingRegistry(account);
    }

    /// @notice Internal function to get the first registry that restricts an address
    /// @param account The address to check
    /// @return The address of the restricting registry, or address(0) if not restricted
    function _getRestrictingRegistry(address account) internal view returns (address) {
        for (uint256 i = 0; i < _restrictionListRegistries.length; i++) {
            address registry = _restrictionListRegistries[i];
            try IRestrictionList(registry).isRestricted(account) returns (bool restricted) {
                if (restricted) {
                    return registry;
                }
            } catch {
                // If a registry call fails, skip it and continue checking others
                continue;
            }
        }
        return address(0);
    }

    /// @notice Internal function to check if an address is not restricted by any active registry
    /// @param account The address to check
    function _requireNotRestricted(address account) internal view {
        address restrictingRegistry = _getRestrictingRegistry(account);
        if (restrictingRegistry != address(0)) {
            revert AccountIsRestricted(account, restrictingRegistry);
        }
    }

    /// @notice Internal function to check if an address is not restricted with custom error message
    /// @param account The address to check
    /// @param operation Description of the operation being attempted
    function _requireNotRestrictedWithMessage(address account, string memory operation) internal {
        address restrictingRegistry = _getRestrictingRegistry(account);
        if (restrictingRegistry != address(0)) {
            emit RestrictedAddressBlocked(account, restrictingRegistry, operation);
            revert AccountIsRestricted(account, restrictingRegistry);
        }
    }

    /// @notice Add a new restriction list registry
    /// @param registry The address of the registry to add
    function _addRestrictionListRegistry(address registry) internal {
        if (registry == address(0)) revert InvalidRegistry();
        if (_isActiveRegistry[registry]) revert RegistryAlreadyExists(registry);
        if (_restrictionListRegistries.length >= MAX_REGISTRIES) {
            revert TooManyRegistries(_restrictionListRegistries.length, MAX_REGISTRIES);
        }

        _restrictionListRegistries.push(registry);
        _isActiveRegistry[registry] = true;
        
        emit RestrictionListRegistryAdded(registry, msg.sender);
    }

    /// @notice Remove a restriction list registry
    /// @param registry The address of the registry to remove
    function _removeRestrictionListRegistry(address registry) internal {
        if (!_isActiveRegistry[registry]) revert RegistryNotFound(registry);

        _isActiveRegistry[registry] = false;
        
        // Find and remove from array
        for (uint256 i = 0; i < _restrictionListRegistries.length; i++) {
            if (_restrictionListRegistries[i] == registry) {
                // Move last element to current position and pop
                _restrictionListRegistries[i] = _restrictionListRegistries[_restrictionListRegistries.length - 1];
                _restrictionListRegistries.pop();
                break;
            }
        }
        
        emit RestrictionListRegistryRemoved(registry, msg.sender);
    }

    /// @notice Check if multiple addresses are restricted by any active registry
    /// @param accounts Array of addresses to check
    /// @return results Array of boolean results indicating restriction status
    function areRestricted(address[] memory accounts) public view returns (bool[] memory results) {
        results = new bool[](accounts.length);
        for (uint256 i = 0; i < accounts.length; i++) {
            results[i] = isRestricted(accounts[i]);
        }
    }

    /// @notice Get all active restriction list registries
    /// @return Array of active registry addresses
    function getActiveRestrictionListRegistries() public view returns (address[] memory) {
        return _restrictionListRegistries;
    }

    /// @notice Get the number of active restriction list registries
    /// @return The number of active registries
    function getActiveRegistryCount() public view returns (uint256) {
        return _restrictionListRegistries.length;
    }

    /// @notice Check if a specific registry is active
    /// @param registry The registry address to check
    /// @return True if the registry is active, false otherwise
    function isRegistryActive(address registry) public view returns (bool) {
        return _isActiveRegistry[registry];
    }

    /// @notice Get detailed restriction information for an address
    /// @param account The address to check
    /// @return restrictingRegistries Array of registry addresses that restrict this account
    function getDetailedRestrictionInfo(address account) public view returns (address[] memory restrictingRegistries) {
        address[] memory tempArray = new address[](_restrictionListRegistries.length);
        uint256 count = 0;
        
        for (uint256 i = 0; i < _restrictionListRegistries.length; i++) {
            address registry = _restrictionListRegistries[i];
            try IRestrictionList(registry).isRestricted(account) returns (bool restricted) {
                if (restricted) {
                    tempArray[count] = registry;
                    count++;
                }
            } catch {
                // Skip failed registry calls
                continue;
            }
        }
        
        // Create properly sized array
        restrictingRegistries = new address[](count);
        for (uint256 i = 0; i < count; i++) {
            restrictingRegistries[i] = tempArray[i];
        }
    }

    /// @notice Get the names of all active restriction list registries
    /// @return registryNames Array of registry names
    function getActiveRegistryNames() public view returns (string[] memory registryNames) {
        string[] memory tempNames = new string[](_restrictionListRegistries.length);
        uint256 count = 0;
        
        for (uint256 i = 0; i < _restrictionListRegistries.length; i++) {
            address registry = _restrictionListRegistries[i];
            if (_isActiveRegistry[registry]) {
                try IRestrictionList(registry).name() returns (string memory name) {
                    tempNames[count] = name;
                    count++;
                } catch {
                    // If name() fails, use address as fallback
                    tempNames[count] = _addressToString(registry);
                    count++;
                }
            }
        }
        
        registryNames = new string[](count);
        for (uint256 i = 0; i < count; i++) {
            registryNames[i] = tempNames[i];
        }
    }

    /// @notice Get detailed restriction information with registry names for an address
    /// @param account The address to check
    /// @return restrictingRegistries Array of registry addresses that restrict this account
    /// @return registryNames Array of registry names that restrict this account
    function getDetailedRestrictionInfoWithNames(address account) 
        public view 
        returns (address[] memory restrictingRegistries, string[] memory registryNames) 
    {
        address[] memory tempAddresses = new address[](_restrictionListRegistries.length);
        string[] memory tempNames = new string[](_restrictionListRegistries.length);
        uint256 count = 0;
        
        for (uint256 i = 0; i < _restrictionListRegistries.length; i++) {
            address registry = _restrictionListRegistries[i];
            try IRestrictionList(registry).isRestricted(account) returns (bool restricted) {
                if (restricted) {
                    tempAddresses[count] = registry;
                    try IRestrictionList(registry).name() returns (string memory name) {
                        tempNames[count] = name;
                    } catch {
                        // If name() fails, use address as fallback
                        tempNames[count] = _addressToString(registry);
                    }
                    count++;
                }
            } catch {
                // Skip failed registry calls
                continue;
            }
        }
        
        // Create properly sized arrays
        restrictingRegistries = new address[](count);
        registryNames = new string[](count);
        for (uint256 i = 0; i < count; i++) {
            restrictingRegistries[i] = tempAddresses[i];
            registryNames[i] = tempNames[i];
        }
    }

    /// @notice Helper function to convert address to string
    /// @param addr The address to convert
    /// @return The string representation of the address
    function _addressToString(address addr) internal pure returns (string memory) {
        bytes32 value = bytes32(uint256(uint160(addr)));
        bytes memory alphabet = "0123456789abcdef";
        bytes memory str = new bytes(42);
        str[0] = '0';
        str[1] = 'x';
        for (uint256 i = 0; i < 20; i++) {
            str[2 + i * 2] = alphabet[uint8(value[i + 12] >> 4)];
            str[3 + i * 2] = alphabet[uint8(value[i + 12] & 0x0f)];
        }
        return string(str);
    }
} 