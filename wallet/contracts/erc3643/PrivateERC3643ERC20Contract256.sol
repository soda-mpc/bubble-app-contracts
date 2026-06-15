// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../base/PrivateERC20Wrapper256Base.sol";
import "./interfaces/IPrivateERC3643Wrapper.sol";
import "./interfaces/IPrivateIdentityRegistry.sol";
import "./interfaces/IPrivateModularCompliance.sol";

/// @title PrivateERC3643ERC20Contract256
/// @notice ERC-3643-aware private ERC20 wrapper backed by an underlying ERC20 token.
/// @dev This contract intentionally excludes arbitrary issuer mint/burn and OPRF functionality.
contract PrivateERC3643ERC20Contract256 is PrivateERC20Wrapper256Base, IPrivateERC3643Wrapper {
    string internal constant TOKEN_VERSION = "0.0.1";

    /// @custom:storage-location erc7201:bubble.storage.PrivateERC3643ERC20Contract256
    struct PrivateERC3643ERC20Contract256Storage {
        IPrivateIdentityRegistry identityRegistry;
        IPrivateModularCompliance compliance;
        address onchainID;
        mapping(address => bool) agents;
        mapping(address => bool) frozen;
        mapping(address => gtUint256) frozenTokens;
        mapping(uint256 => address) unshieldRequestUsers;
    }

    // keccak256(abi.encode(uint256(keccak256("bubble.storage.PrivateERC3643ERC20Contract256")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant PrivateERC3643ERC20Contract256StorageLocation =
        0xb2b5d06fa190aa05c6ab0d5a774a0864940c6e9acd84cafcb79f065f4b85d600;

    modifier onlyAgent() {
        require(isAgent(msg.sender), "AgentRole: caller does not have the Agent role");
        _;
    }

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function initialize(
        string memory name_,
        string memory symbol_,
        address underlying_,
        address owner_,
        address master_,
        bool underlyingIsWrappedNative_,
        address identityRegistry_,
        address compliance_,
        address onchainID_
    ) public initializer {
        _initializePrivateERC20Wrapper256Base(
            name_,
            symbol_,
            underlying_,
            owner_,
            master_,
            underlyingIsWrappedNative_
        );
        _initializePrivateERC3643(identityRegistry_, compliance_, onchainID_, owner_);
        emit UpdatedTokenInformation(name_, symbol_, decimals(), TOKEN_VERSION, onchainID_);
    }

    function _initializePrivateERC3643(
        address identityRegistry_,
        address compliance_,
        address onchainID_,
        address initialAgent
    ) internal onlyInitializing {
        require(identityRegistry_ != address(0), "Identity registry cannot be zero address");
        require(compliance_ != address(0), "Compliance cannot be zero address");
        require(initialAgent != address(0), "Agent cannot be zero address");

        PrivateERC3643ERC20Contract256Storage storage $ = _getPrivateERC3643ERC20Contract256Storage();
        $.identityRegistry = IPrivateIdentityRegistry(identityRegistry_);
        $.compliance = IPrivateModularCompliance(compliance_);
        $.onchainID = onchainID_;
        $.agents[initialAgent] = true;

        $.compliance.bindToken(address(this));

        emit IdentityRegistryAdded(identityRegistry_);
        emit ComplianceAdded(compliance_);
        emit AgentAdded(initialAgent);
    }

    function _getPrivateERC3643ERC20Contract256Storage()
        internal
        pure
        returns (PrivateERC3643ERC20Contract256Storage storage $)
    {
        assembly {
            $.slot := PrivateERC3643ERC20Contract256StorageLocation
        }
    }

    function setName(string calldata name_) external override onlyOwner {
        require(bytes(name_).length != 0, "invalid argument - empty string");
        _getPrivateERC20Wrapper256BaseStorage()._name = name_;
        emit UpdatedTokenInformation(name_, symbol(), decimals(), TOKEN_VERSION, onchainID());
    }

    function setSymbol(string calldata symbol_) external override onlyOwner {
        require(bytes(symbol_).length != 0, "invalid argument - empty string");
        _getPrivateERC20Wrapper256BaseStorage()._symbol = symbol_;
        emit UpdatedTokenInformation(name(), symbol_, decimals(), TOKEN_VERSION, onchainID());
    }

    function setOnchainID(address onchainID_) external override onlyOwner {
        _getPrivateERC3643ERC20Contract256Storage().onchainID = onchainID_;
        emit UpdatedTokenInformation(name(), symbol(), decimals(), TOKEN_VERSION, onchainID_);
    }

    function setIdentityRegistry(address identityRegistry_) external override onlyOwner {
        require(identityRegistry_ != address(0), "Identity registry cannot be zero address");
        _getPrivateERC3643ERC20Contract256Storage().identityRegistry =
            IPrivateIdentityRegistry(identityRegistry_);
        emit IdentityRegistryAdded(identityRegistry_);
    }

    function setCompliance(address compliance_) external override onlyOwner {
        require(compliance_ != address(0), "Compliance cannot be zero address");
        PrivateERC3643ERC20Contract256Storage storage $ = _getPrivateERC3643ERC20Contract256Storage();
        address previousCompliance = address($.compliance);
        if (previousCompliance == compliance_) {
            return;
        }

        $.compliance = IPrivateModularCompliance(compliance_);
        $.compliance.bindToken(address(this));
        if (previousCompliance != address(0)) {
            IPrivateModularCompliance(previousCompliance).unbindToken(address(this));
        }
        emit ComplianceAdded(compliance_);
    }

    function addAgent(address agent) external override onlyOwner {
        require(agent != address(0), "invalid argument - zero address");
        PrivateERC3643ERC20Contract256Storage storage $ = _getPrivateERC3643ERC20Contract256Storage();
        require(!$.agents[agent], "Roles: account already has role");
        $.agents[agent] = true;
        emit AgentAdded(agent);
    }

    function removeAgent(address agent) external override onlyOwner {
        require(agent != address(0), "invalid argument - zero address");
        PrivateERC3643ERC20Contract256Storage storage $ = _getPrivateERC3643ERC20Contract256Storage();
        require($.agents[agent], "Roles: account does not have role");
        $.agents[agent] = false;
        emit AgentRemoved(agent);
    }

    function pause() external override(PrivateERC20Wrapper256Base) onlyAgent {
        _pause();
    }

    function unpause() external override(PrivateERC20Wrapper256Base) onlyAgent {
        _unpause();
    }

    function setAddressFrozen(address userAddress, bool freeze) public override onlyAgent {
        _getPrivateERC3643ERC20Contract256Storage().frozen[userAddress] = freeze;
        emit AddressFrozen(userAddress, freeze, msg.sender);
    }

    function freezePartialTokens(address userAddress, itUint256 calldata it) external override onlyAgent {
        require(userAddress != address(0), "ERC20: freeze from the zero address");
        gtUint256 amount = MpcCore.validateCiphertext(it);
        _freezePartialTokensGt(userAddress, amount);
    }

    function unfreezePartialTokens(address userAddress, itUint256 calldata it) external override onlyAgent {
        require(userAddress != address(0), "ERC20: unfreeze from the zero address");
        gtUint256 amount = MpcCore.validateCiphertext(it);
        _unfreezePartialTokensGt(userAddress, amount);
    }

    function _freezePartialTokensGt(address userAddress, gtUint256 amount) internal {
        PrivateERC3643ERC20Contract256Storage storage $ = _getPrivateERC3643ERC20Contract256Storage();
        gtUint256 currentFrozen = _normalizedFrozen(userAddress);
        gtUint256 newFrozenCandidate = MpcCore.add(currentFrozen, amount);
        (gtBool freezeOverflowBit, ) = MpcCore.checkedSubWithOverflowBit(_balanceOf(userAddress), newFrozenCandidate);
        gtUint256 actualFrozen = MpcCore.mux(freezeOverflowBit, amount, _zeroGt());
        gtUint256 newFrozen = MpcCore.mux(freezeOverflowBit, newFrozenCandidate, currentFrozen);
        $.frozenTokens[userAddress] = newFrozen;
        MpcCore.permitThis(newFrozen);
        MpcCore.permit(newFrozen, userAddress);
        MpcCore.permit(newFrozen, msg.sender);
        MpcCore.permitThis(actualFrozen);
        MpcCore.permit(actualFrozen, userAddress);
        MpcCore.permit(actualFrozen, msg.sender);
        emit TokensFrozen(userAddress, actualFrozen);
    }

    function _unfreezePartialTokensGt(address userAddress, gtUint256 amount) internal {
        PrivateERC3643ERC20Contract256Storage storage $ = _getPrivateERC3643ERC20Contract256Storage();
        (gtBool overflowBit, gtUint256 newFrozenCandidate) =
            MpcCore.checkedSubWithOverflowBit(_normalizedFrozen(userAddress), amount);
        gtUint256 actualUnfrozen = MpcCore.mux(overflowBit, amount, _zeroGt());
        gtUint256 newFrozen = MpcCore.mux(overflowBit, newFrozenCandidate, _normalizedFrozen(userAddress));
        $.frozenTokens[userAddress] = newFrozen;
        MpcCore.permitThis(newFrozen);
        MpcCore.permit(newFrozen, userAddress);
        MpcCore.permit(newFrozen, msg.sender);
        MpcCore.permitThis(actualUnfrozen);
        MpcCore.permit(actualUnfrozen, userAddress);
        MpcCore.permit(actualUnfrozen, msg.sender);
        emit TokensUnfrozen(userAddress, actualUnfrozen);
    }

    function identityRegistry() external view override returns (IPrivateIdentityRegistry) {
        return _getPrivateERC3643ERC20Contract256Storage().identityRegistry;
    }

    function compliance() external view override returns (IPrivateModularCompliance) {
        return _getPrivateERC3643ERC20Contract256Storage().compliance;
    }

    function onchainID() public view override returns (address) {
        return _getPrivateERC3643ERC20Contract256Storage().onchainID;
    }

    function version() external pure override returns (string memory) {
        return TOKEN_VERSION;
    }

    function isAgent(address agent) public view override returns (bool) {
        require(agent != address(0), "Roles: account is the zero address");
        return _getPrivateERC3643ERC20Contract256Storage().agents[agent];
    }

    function isFrozen(address userAddress) external view override returns (bool) {
        return _getPrivateERC3643ERC20Contract256Storage().frozen[userAddress];
    }

    function getFrozenTokens(address userAddress) external view override returns (gtUint256) {
        return _getPrivateERC3643ERC20Contract256Storage().frozenTokens[userAddress];
    }

    function _beforeShield(address account, uint256 amount) internal view override {
        PrivateERC3643ERC20Contract256Storage storage $ = _getPrivateERC3643ERC20Contract256Storage();
        require(!$.frozen[account], "wallet is frozen");
        require($.identityRegistry.isVerified(account), "Identity is not verified.");
        require($.compliance.canCreate(account, amount), "Compliance not followed");
    }

    function _afterShield(address account, uint256 amount) internal override {
        _getPrivateERC3643ERC20Contract256Storage().compliance.created(account, amount);
    }

    function _effectivePrivateTransferAmount(address from, address to, gtUint256 amount)
        internal
        override
        returns (gtUint256)
    {
        PrivateERC3643ERC20Contract256Storage storage $ = _getPrivateERC3643ERC20Contract256Storage();
        require(!_isFrozenStorage($, from) && !_isFrozenStorage($, to), "wallet is frozen");
        require($.identityRegistry.isVerified(to), "Transfer not possible");
        MpcCore.permitTransient(amount, address($.compliance));
        gtBool complianceAllows = $.compliance.canTransfer(from, to, amount);
        gtBool amountWithinFreeBalance = _isAmountWithinFreeBalance(from, amount);
        gtBool transferAllowed = MpcCore.and(complianceAllows, amountWithinFreeBalance);
        gtUint256 effectiveAmount = MpcCore.mux(transferAllowed, _zeroGt(), amount);
        MpcCore.permitThis(effectiveAmount);
        return effectiveAmount;
    }

    function _afterPrivateTransfer(address from, address to, gtUint256 amount, gtBool) internal override {
        PrivateERC3643ERC20Contract256Storage storage $ = _getPrivateERC3643ERC20Contract256Storage();
        MpcCore.permitTransient(amount, address($.compliance));
        $.compliance.transferred(from, to, amount);
    }

    function _beforePrivateApprove(address tokenOwner, address spender) internal view override {
        PrivateERC3643ERC20Contract256Storage storage $ = _getPrivateERC3643ERC20Contract256Storage();
        require(!_isFrozenStorage($, tokenOwner) && !_isFrozenStorage($, spender), "wallet is frozen");
    }

    function _beforeUnshield(address account, address, uint256) internal view override {
        require(!_getPrivateERC3643ERC20Contract256Storage().frozen[account], "wallet is frozen");
    }

    function _debitBalanceForUnshield(address account, gtUint256 amount)
        internal
        override
        returns (gtUint256 amountToUnshieldGt)
    {
        gtBool amountWithinFreeBalance = _isAmountWithinFreeBalance(account, amount);
        gtUint256 effectiveAmount = MpcCore.mux(amountWithinFreeBalance, _zeroGt(), amount);
        MpcCore.permitThis(effectiveAmount);
        return super._debitBalanceForUnshield(account, effectiveAmount);
    }

    function _afterUnshieldRequest(address account, address, uint256, gtUint256) internal override {
        uint256 decryptID = decryptCounter > 0 ? decryptCounter - 1 : 0;
        _getPrivateERC3643ERC20Contract256Storage().unshieldRequestUsers[decryptID] = account;
    }

    function _afterUnshield(uint256 decryptID, address, uint256 amount) internal override {
        PrivateERC3643ERC20Contract256Storage storage $ = _getPrivateERC3643ERC20Contract256Storage();
        address account = $.unshieldRequestUsers[decryptID];
        require(account != address(0), "Invalid ERC3643 unshield request ID");
        $.compliance.destroyed(account, amount);
        delete $.unshieldRequestUsers[decryptID];
    }

    function _normalizedFrozen(address account) internal view returns (gtUint256) {
        gtUint256 frozen = _getPrivateERC3643ERC20Contract256Storage().frozenTokens[account];
        if (gtUint256.unwrap(frozen) == 0) {
            return _zeroGt();
        }
        return frozen;
    }

    function _isAmountWithinFreeBalance(address account, gtUint256 amount) internal returns (gtBool) {
        (gtBool freeBalanceUnderflow, gtUint256 freeBalanceCandidate) =
            MpcCore.checkedSubWithOverflowBit(_balanceOf(account), _normalizedFrozen(account));
        gtUint256 freeBalance = MpcCore.mux(freeBalanceUnderflow, freeBalanceCandidate, _zeroGt());
        (gtBool amountUnderflow, ) = MpcCore.checkedSubWithOverflowBit(freeBalance, amount);
        return MpcCore.mux(amountUnderflow, MpcCore.setPublic(true), MpcCore.setPublic(false));
    }

    function _isFrozenStorage(PrivateERC3643ERC20Contract256Storage storage $, address account)
        internal
        view
        returns (bool)
    {
        return $.frozen[account];
    }
}
