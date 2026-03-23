// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import "../PrivateERC20Contract256.sol";
import "./RestrictionListIntegration.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";

/// @title PrivateERC20WithRestrictionList256
/// @notice Enhanced PrivateERC20Contract256 with multiple restriction list functionality and pause capability
/// @dev This contract demonstrates how to integrate multiple restriction list registries with 256-bit contract
/// Restricted addresses cannot send, receive, approve, or perform other token operations
/// The contract can be paused by the owner to halt all operations
contract PrivateERC20WithRestrictionList256 is PrivateERC20Contract256, RestrictionListIntegration, PausableUpgradeable {
    /// @notice Custom errors for gas-efficient reverts
    error NewOwnerIsZeroAddress();
    error NoRegistriesActive();
    
    /// @notice Emitted when restriction list enforcement is enabled or disabled
    /// @param enabled Whether restriction list enforcement is enabled
    event RestrictionListEnforcementChanged(bool enabled);

    /// @custom:storage-location erc7201:bubble.storage.PrivateERC20WithRestrictionList256
    struct PrivateERC20WithRestrictionList256Storage {
        /// @notice Whether restriction list enforcement is currently enabled
        bool restrictionListEnforcementEnabled;
    }

    /// @dev ERC-7201 storage slot for PrivateERC20WithRestrictionList256 state.
    bytes32 private constant PrivateERC20WithRestrictionList256StorageLocation =
        0x4adf8f4372892f157cd9a9ea6e7ea2f4cf8eff5ff2f7315e38f7464067d4a500;

    function _getPrivateERC20WithRestrictionList256Storage()
        internal
        pure
        returns (PrivateERC20WithRestrictionList256Storage storage $)
    {
        assembly {
            $.slot := PrivateERC20WithRestrictionList256StorageLocation
        }
    }

    /// @notice Whether restriction list enforcement is currently enabled
    function restrictionListEnforcementEnabled() public view returns (bool) {
        PrivateERC20WithRestrictionList256Storage storage $ = _getPrivateERC20WithRestrictionList256Storage();
        return $.restrictionListEnforcementEnabled;
    }

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
        __Pausable_init();
        // Initialize restriction list registries
        _initializeRestrictionListRegistries(restrictionListRegistries_);
        PrivateERC20WithRestrictionList256Storage storage $ = _getPrivateERC20WithRestrictionList256Storage();
        $.restrictionListEnforcementEnabled = (restrictionListRegistries_.length > 0);
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
        _requireNotRestrictedPair(msg.sender, _to);
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
        _requireNotRestrictedPair(msg.sender, _to);
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
        _requireNotRestrictedPair(msg.sender, _to);
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
        _requireNotRestrictedTriple(msg.sender, _from, _to);
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
        _requireNotRestrictedTriple(msg.sender, _from, _to);
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
        _requireNotRestrictedTriple(msg.sender, _from, _to);
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
        _requireNotRestrictedPair(msg.sender, _spender);
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
        _requireNotRestrictedPair(msg.sender, _spender);
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
        _requireNotRestrictedPair(msg.sender, _spender);
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
        _requireNotRestrictedAccount(msg.sender);
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
        _requireNotRestrictedAccount(msg.sender);
        return super.unshield(privateAmount);
    }

    /// @notice Override unshieldForMaster to include restriction list checks
    /// @param privateAmount The amount to unshield
    /// @return True if the unshield was successful
    function unshieldForMaster(uint256 privateAmount)
        public
        override
        whenNotPaused
        returns (bool)
    {
        _requireNotRestrictedAccount(msg.sender);
        return super.unshieldForMaster(privateAmount);
    }

    /// @notice Override mintOPRFToken to include restriction list checks
    /// @param quantity The encrypted quantity/amount for the OPRF token
    function mintOPRFToken(itUint256 calldata quantity) 
        public 
        override 
        whenNotPaused
    {
        _requireNotRestrictedAccount(msg.sender);
        super.mintOPRFToken(quantity);
    }

    /// @notice Override splitToken to include restriction list checks
    function splitToken(
        itUint128 calldata x,
        itUint256 calldata q,
        uint128 y_clear,
        itUint256 calldata qSplit
    ) public override whenNotPaused {
        _requireNotRestrictedAccount(msg.sender);
        super.splitToken(x, q, y_clear, qSplit);
    }

    /// @notice Override splitTokenForRecipient to include restriction list checks
    function splitTokenForRecipient(
        itUint128 calldata x,
        itUint256 calldata q,
        uint128 y_clear,
        itUint256 calldata qSplit,
        address recipient
    ) public override whenNotPaused {
        _requireNotRestrictedPair(msg.sender, recipient);
        super.splitTokenForRecipient(x, q, y_clear, qSplit, recipient);
    }

    /// @notice Override burnToken to include restriction list checks
    function burnToken(
        itUint128 calldata x,
        itUint256 calldata q,
        uint128 y_clear,
        address recipient
    ) public override whenNotPaused {
        _requireNotRestrictedPair(msg.sender, recipient);
        super.burnToken(x, q, y_clear, recipient);
    }

    /// @notice Override mergeMany to include restriction list checks
    function mergeMany(OPRFToken[] calldata tokens)
        public
        override
        whenNotPaused
        returns (gtUint128 x, gtUint128 y, gtUint256 qMerged)
    {
        _requireNotRestrictedAccount(msg.sender);
        return super.mergeMany(tokens);
    }

    /// @notice Override transferOPRF to include restriction list checks
    function transferOPRF(
        OPRFToken[] calldata tokens,
        itUint256 calldata amount,
        address recipient
    )
        public
        override
        whenNotPaused
        returns (
            gtUint128 xRecipient,
            gtUint128 yRecipient,
            gtUint256 qRecipient,
            gtUint128 xSender,
            gtUint128 ySender,
            gtUint256 qSender
        )
    {
        _requireNotRestrictedPair(msg.sender, recipient);
        return super.transferOPRF(tokens, amount, recipient);
    }

    /// @notice Override redeemMany to include restriction list checks
    function redeemMany(
        OPRFToken[] calldata tokens,
        itUint256 calldata amount,
        address recipient
    )
        public
        override
        whenNotPaused
        returns (gtUint128 xRemainder, gtUint128 yRemainder, gtUint256 qRemainder)
    {
        _requireNotRestrictedPair(msg.sender, recipient);
        return super.redeemMany(tokens, amount, recipient);
    }

    /// @dev Reverts if account is restricted by any active registry.
    function _requireNotRestrictedAccount(address account) internal view {
        PrivateERC20WithRestrictionList256Storage storage $ = _getPrivateERC20WithRestrictionList256Storage();
        if (!$.restrictionListEnforcementEnabled) {
            return;
        }

        address restrictingRegistry = getRestrictingRegistry(account);
        if (restrictingRegistry != address(0)) {
            revert AccountIsRestricted(account, restrictingRegistry);
        }
    }

    /// @dev Reverts if either account is restricted by any active registry.
    function _requireNotRestrictedPair(address account1, address account2) internal view {
        _requireNotRestrictedAccount(account1);
        _requireNotRestrictedAccount(account2);
    }

    /// @dev Reverts if any account is restricted by any active registry.
    function _requireNotRestrictedTriple(address account1, address account2, address account3) internal view {
        _requireNotRestrictedAccount(account1);
        _requireNotRestrictedAccount(account2);
        _requireNotRestrictedAccount(account3);
    }

    /// @notice Add a new restriction list registry (only owner)
    /// @param registry The address of the new restriction list registry
    function addRestrictionListRegistry(address registry) external onlyOwner {
        _addRestrictionListRegistry(registry);
        
        // Enable enforcement if this is the first registry
        PrivateERC20WithRestrictionList256Storage storage $ = _getPrivateERC20WithRestrictionList256Storage();
        if (getActiveRegistryCount() == 1 && !$.restrictionListEnforcementEnabled) {
            $.restrictionListEnforcementEnabled = true;
            emit RestrictionListEnforcementChanged(true);
        }
    }

    /// @notice Remove a restriction list registry (only owner)
    /// @param registry The address of the restriction list registry to remove
    function removeRestrictionListRegistry(address registry) external onlyOwner {
        _removeRestrictionListRegistry(registry);
        
        // Disable enforcement if no registries remain
        PrivateERC20WithRestrictionList256Storage storage $ = _getPrivateERC20WithRestrictionList256Storage();
        if (getActiveRegistryCount() == 0 && $.restrictionListEnforcementEnabled) {
            $.restrictionListEnforcementEnabled = false;
            emit RestrictionListEnforcementChanged(false);
        }
    }

    /// @notice Enable or disable restriction list enforcement (only owner)
    /// @param _enabled Whether to enable restriction list enforcement
    function setRestrictionListEnforcement(bool _enabled) external onlyOwner {
        if (getActiveRegistryCount() == 0 && _enabled) revert NoRegistriesActive();
        PrivateERC20WithRestrictionList256Storage storage $ = _getPrivateERC20WithRestrictionList256Storage();
        $.restrictionListEnforcementEnabled = _enabled;
        emit RestrictionListEnforcementChanged(_enabled);
    }

    /// @notice Override the isRestricted check to respect enforcement setting
    /// @param account The address to check
    /// @return True if restricted and enforcement is enabled, false otherwise
    function isRestricted(address account) public view override returns (bool) {
        PrivateERC20WithRestrictionList256Storage storage $ = _getPrivateERC20WithRestrictionList256Storage();
        if (!$.restrictionListEnforcementEnabled) {
            return false;
        }
        return super.isRestricted(account);
    }

    /// @notice Check if restriction list enforcement is active and registries are configured
    /// @return True if restriction list is active
    function isRestrictionListActive() external view returns (bool) {
        PrivateERC20WithRestrictionList256Storage storage $ = _getPrivateERC20WithRestrictionList256Storage();
        return $.restrictionListEnforcementEnabled && getActiveRegistryCount() > 0;
    }

    /// @notice Emergency function to disable restriction list enforcement (only owner)
    /// @dev This can be used if restriction list registries become compromised
    function emergencyDisableRestrictionList() external onlyOwner {
        PrivateERC20WithRestrictionList256Storage storage $ = _getPrivateERC20WithRestrictionList256Storage();
        $.restrictionListEnforcementEnabled = false;
        emit RestrictionListEnforcementChanged(false);
    }

    /// @notice Get comprehensive restriction information for an address
    /// @param account The address to check
    /// @return allRestrictingRegistries All registries that restrict the address
    function getComprehensiveRestrictionInfo(address account) 
        external 
        view 
        returns (address[] memory allRestrictingRegistries) 
    {
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
        _pause();
    }

    /// @notice Unpause the contract (only owner)
    /// @dev Resumes all token operations
    function unpause() external onlyOwner {
        _unpause();
    }
}
