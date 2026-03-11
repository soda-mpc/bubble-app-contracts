// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../PrivateERC20Contract256.sol";
import "./RestrictionListIntegration.sol";

/// @title PrivateERC20WithRestrictionList256
/// @notice Enhanced PrivateERC20Contract256 with multiple restriction list functionality and pause capability
/// @dev This contract demonstrates how to integrate multiple restriction list registries with 256-bit contract
/// Restricted addresses cannot send, receive, approve, or perform other token operations
/// The contract can be paused by the owner to halt all operations
contract PrivateERC20WithRestrictionList256 is PrivateERC20Contract256, RestrictionListIntegration {
    /// @notice Custom errors for gas-efficient reverts
    error NewOwnerIsZeroAddress();
    error AlreadyPaused();
    error NotPaused();
    error ContractIsPaused();
    error NoRegistriesActive();
    
    /// @notice Emitted when restriction list enforcement is enabled or disabled
    /// @param enabled Whether restriction list enforcement is enabled
    event RestrictionListEnforcementChanged(bool enabled);

    /// @notice Emitted when the contract is paused or unpaused
    /// @param account The address that triggered the pause/unpause
    /// @param paused Whether the contract is now paused
    event Paused(address indexed account, bool paused);

    /// @notice Whether restriction list enforcement is currently enabled
    bool public restrictionListEnforcementEnabled;

    /// @notice Whether the contract is currently paused
    bool public paused;

    /// @notice Disables initializers in the implementation contract
    constructor() RestrictionListIntegration(new address[](0)) {
        _disableInitializers();
    }

    /// @notice Initializes the token with multiple restriction list integration
    /// @param name_ The name of the token
    /// @param symbol_ The symbol of the token
    /// @param underlying_ The address of the underlying ERC20 token
    /// @param restrictionListRegistries_ Array of restriction list registry addresses
    /// @param owner_ The address that will own the token
    /// @param master_ The master address for the token
    function initialize(
        string memory name_,
        string memory symbol_,
        address underlying_,
        address[] memory restrictionListRegistries_,
        address owner_,
        address master_
    ) public initializer {
        // Initialize parent contract
        PrivateERC20Contract256.initialize(name_, symbol_, underlying_, owner_, master_);
        // Initialize restriction list registries
        _initializeRestrictionListRegistries(restrictionListRegistries_);
        restrictionListEnforcementEnabled = (restrictionListRegistries_.length > 0);
    }

    /// @notice Override transfer to include restriction list checks
    /// @param _to The address to transfer to
    /// @param _it The encrypted and signed transfer amount
    /// @return The handle to the transfer's result
    function transfer(address _to, itUint256 calldata _it) 
        public 
        override 
        whenNotPaused
        returns (gtBool) 
    {
        // Inline restriction check for sender
        address restrictingRegistrySender = getRestrictingRegistry(msg.sender);
        if (restrictingRegistrySender != address(0)) {
            revert AccountIsRestricted(msg.sender, restrictingRegistrySender);
        }
        // Inline restriction check for receiver
        address restrictingRegistryReceiver = getRestrictingRegistry(_to);
        if (restrictingRegistryReceiver != address(0)) {
            revert AccountIsRestricted(_to, restrictingRegistryReceiver);
        }
        return super.transfer(_to, _it);
    }

    /// @notice Override transfer to include restriction list checks
    /// @param _to The address to transfer to
    /// @param _value The amount of tokens to transfer
    /// @return The handle to the transfer's result
    function transfer(address _to, uint256 _value) 
        public 
        override 
        whenNotPaused
        returns (gtBool) 
    {
        // Inline restriction check for sender
        address restrictingRegistrySender = getRestrictingRegistry(msg.sender);
        if (restrictingRegistrySender != address(0)) {
            revert AccountIsRestricted(msg.sender, restrictingRegistrySender);
        }
        // Inline restriction check for receiver
        address restrictingRegistryReceiver = getRestrictingRegistry(_to);
        if (restrictingRegistryReceiver != address(0)) {
            revert AccountIsRestricted(_to, restrictingRegistryReceiver);
        }
        return super.transfer(_to, _value);
    }

    /// @notice Override contractTransfer to include restriction list checks
    /// @param _to The address to transfer to
    /// @param _value The handle to the amount of tokens to transfer
    /// @return The handle to the transfer's result
    function contractTransfer(address _to, gtUint256 _value) 
        public 
        override 
        whenNotPaused
        returns (gtBool) 
    {
        // Inline restriction check for sender
        address restrictingRegistrySender = getRestrictingRegistry(msg.sender);
        if (restrictingRegistrySender != address(0)) {
            revert AccountIsRestricted(msg.sender, restrictingRegistrySender);
        }
        // Inline restriction check for receiver
        address restrictingRegistryReceiver = getRestrictingRegistry(_to);
        if (restrictingRegistryReceiver != address(0)) {
            revert AccountIsRestricted(_to, restrictingRegistryReceiver);
        }
        return super.contractTransfer(_to, _value);
    }

    /// @notice Override transferFrom to include restriction list checks
    /// @param _from The address to transfer from
    /// @param _to The address to transfer to
    /// @param _it The encrypted and signed transfer amount
    /// @return The handle to the transfer's result
    function transferFrom(address _from, address _to, itUint256 calldata _it) 
        public 
        override 
        whenNotPaused
        returns (gtBool) 
    {
        // Inline restriction check for sender (msg.sender)
        address restrictingRegistrySender = getRestrictingRegistry(msg.sender);
        if (restrictingRegistrySender != address(0)) {
            revert AccountIsRestricted(msg.sender, restrictingRegistrySender);
        }
        // Inline restriction check for from address
        address restrictingRegistryFrom = getRestrictingRegistry(_from);
        if (restrictingRegistryFrom != address(0)) {
            revert AccountIsRestricted(_from, restrictingRegistryFrom);
        }
        // Inline restriction check for to address
        address restrictingRegistryTo = getRestrictingRegistry(_to);
        if (restrictingRegistryTo != address(0)) {
            revert AccountIsRestricted(_to, restrictingRegistryTo);
        }
        return super.transferFrom(_from, _to, _it);
    }

    /// @notice Override transferFrom to include restriction list checks
    /// @param _from The address to transfer from
    /// @param _to The address to transfer to
    /// @param _value The amount of tokens to transfer
    /// @return The handle to the transfer's result
    function transferFrom(address _from, address _to, uint256 _value) 
        public 
        override 
        whenNotPaused
        returns (gtBool) 
    {
        // Inline restriction check for sender (msg.sender)
        address restrictingRegistrySender = getRestrictingRegistry(msg.sender);
        if (restrictingRegistrySender != address(0)) {
            revert AccountIsRestricted(msg.sender, restrictingRegistrySender);
        }
        // Inline restriction check for from address
        address restrictingRegistryFrom = getRestrictingRegistry(_from);
        if (restrictingRegistryFrom != address(0)) {
            revert AccountIsRestricted(_from, restrictingRegistryFrom);
        }
        // Inline restriction check for to address
        address restrictingRegistryTo = getRestrictingRegistry(_to);
        if (restrictingRegistryTo != address(0)) {
            revert AccountIsRestricted(_to, restrictingRegistryTo);
        }
        return super.transferFrom(_from, _to, _value);
    }

    /// @notice Override contractTransferFrom to include restriction list checks
    /// @param _from The address to transfer from
    /// @param _to The address to transfer to
    /// @param _value The encrypted transfer amount
    /// @return The handle to the transfer's result
    function contractTransferFrom(address _from, address _to, gtUint256 _value) 
        public 
        override 
        whenNotPaused
        returns (gtBool) 
    {
        // Inline restriction check for sender (msg.sender)
        address restrictingRegistrySender = getRestrictingRegistry(msg.sender);
        if (restrictingRegistrySender != address(0)) {
            revert AccountIsRestricted(msg.sender, restrictingRegistrySender);
        }
        // Inline restriction check for from address
        address restrictingRegistryFrom = getRestrictingRegistry(_from);
        if (restrictingRegistryFrom != address(0)) {
            revert AccountIsRestricted(_from, restrictingRegistryFrom);
        }
        // Inline restriction check for to address
        address restrictingRegistryTo = getRestrictingRegistry(_to);
        if (restrictingRegistryTo != address(0)) {
            revert AccountIsRestricted(_to, restrictingRegistryTo);
        }
        return super.contractTransferFrom(_from, _to, _value);
    }

    /// @notice Override approve to include restriction list checks
    /// @param _spender The address that will be approved
    /// @param _it The encrypted and signed approval amount
    /// @return True if the approval was successful
    function approve(address _spender, itUint256 calldata _it) 
        public 
        override 
        whenNotPaused
        returns (bool) 
    {
        // Inline restriction check for sender (msg.sender)
        address restrictingRegistrySender = getRestrictingRegistry(msg.sender);
        if (restrictingRegistrySender != address(0)) {
            revert AccountIsRestricted(msg.sender, restrictingRegistrySender);
        }
        // Inline restriction check for spender
        address restrictingRegistrySpender = getRestrictingRegistry(_spender);
        if (restrictingRegistrySpender != address(0)) {
            revert AccountIsRestricted(_spender, restrictingRegistrySpender);
        }
        return super.approve(_spender, _it);
    }

    /// @notice Override approve to include restriction list checks
    /// @param _spender The address that will be approved
    /// @param _value The amount of tokens to approve
    /// @return True if the approval was successful
    function approve(address _spender, uint256 _value) 
        public 
        override 
        whenNotPaused
        returns (bool) 
    {
        // Inline restriction check for sender (msg.sender)
        address restrictingRegistrySender = getRestrictingRegistry(msg.sender);
        if (restrictingRegistrySender != address(0)) {
            revert AccountIsRestricted(msg.sender, restrictingRegistrySender);
        }
        // Inline restriction check for spender
        address restrictingRegistrySpender = getRestrictingRegistry(_spender);
        if (restrictingRegistrySpender != address(0)) {
            revert AccountIsRestricted(_spender, restrictingRegistrySpender);
        }
        return super.approve(_spender, _value);
    }

    /// @notice Override contractApprove to include restriction list checks
    /// @param _spender The address that will be approved
    /// @param _value The handle to the approval amount
    /// @return True if the approval was successful
    function contractApprove(address _spender, gtUint256 _value) 
        public 
        override 
        whenNotPaused
        returns (bool) 
    {
        // Inline restriction check for sender (msg.sender)
        address restrictingRegistrySender = getRestrictingRegistry(msg.sender);
        if (restrictingRegistrySender != address(0)) {
            revert AccountIsRestricted(msg.sender, restrictingRegistrySender);
        }
        // Inline restriction check for spender
        address restrictingRegistrySpender = getRestrictingRegistry(_spender);
        if (restrictingRegistrySpender != address(0)) {
            revert AccountIsRestricted(_spender, restrictingRegistrySpender);
        }
        return super.contractApprove(_spender, _value);
    }

    /// @notice Override shield to include restriction list checks
    /// @param amount The amount to shield
    /// @return True if the shield was successful
    function shield(uint256 amount) 
        public 
        override 
        whenNotPaused
        returns (bool) 
    {
        // Inline restriction check instead of modifier
        address restrictingRegistry = getRestrictingRegistry(msg.sender);
        if (restrictingRegistry != address(0)) {
            revert AccountIsRestricted(msg.sender, restrictingRegistry);
        }
        return super.shield(amount);
    }

    /// @notice Override unshield to include restriction list checks
    /// @param privateAmount The amount to unshield
    /// @return True if the unshield was successful
    function unshield(uint256 privateAmount) 
        public 
        override 
        whenNotPaused
        returns (bool) 
    {
        // Inline restriction check instead of modifier
        address restrictingRegistry = getRestrictingRegistry(msg.sender);
        if (restrictingRegistry != address(0)) {
            revert AccountIsRestricted(msg.sender, restrictingRegistry);
        }
        return super.unshield(privateAmount);
    }

    /// @notice Override mintOPRFToken to include restriction list checks
    /// @param quantity The encrypted quantity/amount for the OPRF token
    function mintOPRFToken(itUint256 calldata quantity) 
        public 
        override 
        whenNotPaused
    {
        // Inline restriction check instead of modifier
        address restrictingRegistry = getRestrictingRegistry(msg.sender);
        if (restrictingRegistry != address(0)) {
            revert AccountIsRestricted(msg.sender, restrictingRegistry);
        }
        super.mintOPRFToken(quantity);
    }

    /// @notice Add a new restriction list registry (only owner)
    /// @param registry The address of the new restriction list registry
    function addRestrictionListRegistry(address registry) external onlyOwner {
        _addRestrictionListRegistry(registry);
        
        // Enable enforcement if this is the first registry
        if (getActiveRegistryCount() == 1 && !restrictionListEnforcementEnabled) {
            restrictionListEnforcementEnabled = true;
            emit RestrictionListEnforcementChanged(true);
        }
    }

    /// @notice Remove a restriction list registry (only owner)
    /// @param registry The address of the restriction list registry to remove
    function removeRestrictionListRegistry(address registry) external onlyOwner {
        _removeRestrictionListRegistry(registry);
        
        // Disable enforcement if no registries remain
        if (getActiveRegistryCount() == 0 && restrictionListEnforcementEnabled) {
            restrictionListEnforcementEnabled = false;
            emit RestrictionListEnforcementChanged(false);
        }
    }

    /// @notice Enable or disable restriction list enforcement (only owner)
    /// @param _enabled Whether to enable restriction list enforcement
    function setRestrictionListEnforcement(bool _enabled) external onlyOwner {
        if (getActiveRegistryCount() == 0 && _enabled) revert NoRegistriesActive();
        restrictionListEnforcementEnabled = _enabled;
        emit RestrictionListEnforcementChanged(_enabled);
    }

    /// @notice Override the isRestricted check to respect enforcement setting
    /// @param account The address to check
    /// @return True if restricted and enforcement is enabled, false otherwise
    function isRestricted(address account) public view override returns (bool) {
        if (!restrictionListEnforcementEnabled) {
            return false;
        }
        return super.isRestricted(account);
    }

    /// @notice Check if restriction list enforcement is active and registries are configured
    /// @return True if restriction list is active
    function isRestrictionListActive() external view returns (bool) {
        return restrictionListEnforcementEnabled && getActiveRegistryCount() > 0;
    }

    /// @notice Emergency function to disable restriction list enforcement (only owner)
    /// @dev This can be used if restriction list registries become compromised
    function emergencyDisableRestrictionList() external onlyOwner {
        restrictionListEnforcementEnabled = false;
        emit RestrictionListEnforcementChanged(false);
    }

    /// @notice Get comprehensive restriction information for an address
    /// @param account The address to check
    /// @return isRestrictedByAny Whether the address is restricted by any active registry
    /// @return restrictingRegistry The first registry that restricts the address (if any)
    /// @return allRestrictingRegistries All registries that restrict the address
    function getComprehensiveRestrictionInfo(address account) 
        external 
        view 
        returns (
            bool isRestrictedByAny, 
            address restrictingRegistry, 
            address[] memory allRestrictingRegistries
        ) 
    {
        isRestrictedByAny = isRestricted(account);
        restrictingRegistry = getRestrictingRegistry(account);
        allRestrictingRegistries = getDetailedRestrictionInfo(account);
    }

    /// @notice Transfer ownership to a new address
    /// @param newOwner The address to transfer ownership to
    /// @dev Only the current owner can call this function
    /// @dev The new owner cannot be a restricted address
    function transferOwnership(address newOwner) public virtual override onlyOwner {
        if (newOwner == address(0)) revert NewOwnerIsZeroAddress();
        
        // Check if the new owner is restricted
        address restrictingRegistry = getRestrictingRegistry(newOwner);
        if (restrictingRegistry != address(0)) {
            revert AccountIsRestricted(newOwner, restrictingRegistry);
        }
        
        super.transferOwnership(newOwner);
    }

    /// @notice Pause the contract (only owner)
    /// @dev Pauses all token operations
    function pause() external onlyOwner {
        if (paused) revert AlreadyPaused();
        
        paused = true;
        emit Paused(msg.sender, true);
    }

    /// @notice Unpause the contract (only owner)
    /// @dev Resumes all token operations
    function unpause() external onlyOwner {
        if (!paused) revert NotPaused();
        
        paused = false;
        emit Paused(msg.sender, false);
    }

    /// @notice Modifier to check if the contract is not paused
    modifier whenNotPaused() {
        if (paused) revert ContractIsPaused();
        _;
    }
}
