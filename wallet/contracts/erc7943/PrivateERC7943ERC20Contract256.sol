// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "../base/PrivateERC20Wrapper256Base.sol";
import "./interfaces/IPrivateERC7943Wrapper.sol";

/// @title PrivateERC7943ERC20Contract256
/// @notice ERC-7943-aware private ERC20 wrapper backed by an underlying ERC20 token.
/// @dev `canTransfer` is intentionally not implemented because private balance sufficiency cannot be
///      truthfully answered from a view function.
contract PrivateERC7943ERC20Contract256 is PrivateERC20Wrapper256Base, IPrivateERC7943Wrapper {
    string internal constant TOKEN_VERSION = "0.0.1";
    bytes4 internal constant ERC7943_FUNGIBLE_INTERFACE_ID = 0x3edbb4c4;

    /// @custom:storage-location erc7201:bubble.storage.PrivateERC7943ERC20Contract256
    struct PrivateERC7943ERC20Contract256Storage {
        mapping(address => bool) agents;
        mapping(address => bool) sendAllowed;
        mapping(address => bool) receiveAllowed;
        mapping(address => bool) sendConfigured;
        mapping(address => bool) receiveConfigured;
        mapping(address => uint256) frozenTokens;
        mapping(uint256 => ForcedTransferRequest) forcedTransferRequests;
        bool defaultSendAllowed;
        bool defaultReceiveAllowed;
    }

    struct ForcedTransferRequest {
        address from;
        address to;
        uint256 requestedAmount;
    }

    // keccak256(abi.encode(uint256(keccak256("bubble.storage.PrivateERC7943ERC20Contract256")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant PrivateERC7943ERC20Contract256StorageLocation =
        0x47a0d1b782d36aeace081428ec912f06da3c418c3ca167b1020a23fe1df3be00;

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
        bool defaultSendAllowed_,
        bool defaultReceiveAllowed_
    ) public initializer {
        _initializePrivateERC20Wrapper256Base(
            name_,
            symbol_,
            underlying_,
            owner_,
            master_,
            underlyingIsWrappedNative_
        );
        _initializePrivateERC7943(owner_, defaultSendAllowed_, defaultReceiveAllowed_);
    }

    function _initializePrivateERC7943(
        address initialAgent,
        bool defaultSendAllowed_,
        bool defaultReceiveAllowed_
    ) internal onlyInitializing {
        require(initialAgent != address(0), "Agent cannot be zero address");

        PrivateERC7943ERC20Contract256Storage storage $ = _getPrivateERC7943ERC20Contract256Storage();
        $.agents[initialAgent] = true;
        $.defaultSendAllowed = defaultSendAllowed_;
        $.defaultReceiveAllowed = defaultReceiveAllowed_;

        emit AgentAdded(initialAgent);
        emit DefaultEligibilitySet(defaultSendAllowed_, defaultReceiveAllowed_);
    }

    function _getPrivateERC7943ERC20Contract256Storage()
        internal
        pure
        returns (PrivateERC7943ERC20Contract256Storage storage $)
    {
        assembly {
            $.slot := PrivateERC7943ERC20Contract256StorageLocation
        }
    }

    function addAgent(address agent) external override onlyOwner {
        require(agent != address(0), "invalid argument - zero address");
        PrivateERC7943ERC20Contract256Storage storage $ = _getPrivateERC7943ERC20Contract256Storage();
        require(!$.agents[agent], "Roles: account already has role");
        $.agents[agent] = true;
        emit AgentAdded(agent);
    }

    function removeAgent(address agent) external override onlyOwner {
        require(agent != address(0), "invalid argument - zero address");
        PrivateERC7943ERC20Contract256Storage storage $ = _getPrivateERC7943ERC20Contract256Storage();
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

    function setCanSend(address account, bool allowed) external override onlyAgent {
        _setCanSend(account, allowed);
    }

    function setCanReceive(address account, bool allowed) external override onlyAgent {
        _setCanReceive(account, allowed);
    }

    function setUserAllowed(address account, bool sendAllowed_, bool receiveAllowed_) external override onlyAgent {
        _setCanSend(account, sendAllowed_);
        _setCanReceive(account, receiveAllowed_);
    }

    function setDefaultEligibility(bool sendAllowed_, bool receiveAllowed_) external override onlyOwner {
        PrivateERC7943ERC20Contract256Storage storage $ = _getPrivateERC7943ERC20Contract256Storage();
        $.defaultSendAllowed = sendAllowed_;
        $.defaultReceiveAllowed = receiveAllowed_;
        emit DefaultEligibilitySet(sendAllowed_, receiveAllowed_);
    }

    function setFrozenTokens(address account, uint256 amount) external override onlyAgent returns (bool) {
        require(account != address(0), "ERC20: freeze from the zero address");
        _getPrivateERC7943ERC20Contract256Storage().frozenTokens[account] = amount;
        emit Frozen(account, amount);
        return true;
    }

    function forcedTransfer(address from, address to, uint256 amount)
        external
        override
        onlyAgent
        whenNotPaused
        returns (bool)
    {
        require(from != address(0), "ERC20: transfer from the zero address");
        require(to != address(0), "ERC20: transfer to the zero address");
        require(from != to, "ERC20: forced transfer to self");
        require(amount > 0, "Amount must be greater than 0");
        if (!canReceive(to)) revert ERC7943CannotReceive(to);

        PrivateERC7943ERC20Contract256Storage storage $ = _getPrivateERC7943ERC20Contract256Storage();
        uint256 frozenAmount = $.frozenTokens[from];
        if (frozenAmount == 0) revert ERC7943NoFrozenTokens(from);

        uint256 forceableAmount = amount > frozenAmount ? frozenAmount : amount;
        gtUint256 forceableAmountGt = MpcCore.setPublic256(forceableAmount);
        gtUint256 actualAmount = _applyForcedTransfer(from, to, forceableAmountGt);

        uint256 decryptID = decryptCounter;
        $.forcedTransferRequests[decryptID] = ForcedTransferRequest({
            from: from,
            to: to,
            requestedAmount: amount
        });

        uint256[] memory handles = new uint256[](1);
        handles[0] = gtUint256.unwrap(actualAmount);
        requestDecryption(handles, this.callbackForcedTransfer.selector);

        emit Transfer(from, to);
        emit ForcedTransferRequested(decryptID, from, to, amount, actualAmount);
        return true;
    }

    function callbackForcedTransfer(uint256 decryptID, bytes[] calldata output, bytes[] calldata signatures)
        external
        nonReentrant
        verifyCallback(decryptID, output, signatures)
    {
        PrivateERC7943ERC20Contract256Storage storage $ = _getPrivateERC7943ERC20Contract256Storage();
        ForcedTransferRequest memory request = $.forcedTransferRequests[decryptID];
        require(request.from != address(0), "Invalid forced transfer request ID");

        uint256 actualAmount = abi.decode(output[0], (uint256));
        if (actualAmount > 0) {
            uint256 currentFrozen = $.frozenTokens[request.from];
            if (currentFrozen > 0) {
                uint256 newFrozen = actualAmount >= currentFrozen ? 0 : currentFrozen - actualAmount;
                $.frozenTokens[request.from] = newFrozen;
                emit Frozen(request.from, newFrozen);
            }
        }

        emit ForcedTransfer(request.from, request.to, actualAmount);
        delete $.forcedTransferRequests[decryptID];
    }

    function isAgent(address agent) public view override returns (bool) {
        require(agent != address(0), "Roles: account is the zero address");
        return _getPrivateERC7943ERC20Contract256Storage().agents[agent];
    }

    function canSend(address account) public view override returns (bool) {
        if (account == address(0)) {
            return false;
        }
        PrivateERC7943ERC20Contract256Storage storage $ = _getPrivateERC7943ERC20Contract256Storage();
        return $.sendConfigured[account] ? $.sendAllowed[account] : $.defaultSendAllowed;
    }

    function canReceive(address account) public view override returns (bool) {
        if (account == address(0)) {
            return false;
        }
        PrivateERC7943ERC20Contract256Storage storage $ = _getPrivateERC7943ERC20Contract256Storage();
        return $.receiveConfigured[account] ? $.receiveAllowed[account] : $.defaultReceiveAllowed;
    }

    function canTransfer(address, address, uint256) external pure override returns (bool) {
        revert ERC7943CanTransferNotImplemented();
    }

    function getFrozenTokens(address account) external view override returns (uint256) {
        return _getPrivateERC7943ERC20Contract256Storage().frozenTokens[account];
    }

    function version() external pure returns (string memory) {
        return TOKEN_VERSION;
    }

    function supportsInterface(bytes4 interfaceId) public pure override returns (bool) {
        return interfaceId == type(IERC165).interfaceId && interfaceId != ERC7943_FUNGIBLE_INTERFACE_ID;
    }

    function _beforeShield(address account, uint256) internal view override {
        if (!canReceive(account)) revert ERC7943CannotReceive(account);
    }

    function _effectivePrivateTransferAmount(address from, address to, gtUint256 amount)
        internal
        override
        returns (gtUint256)
    {
        if (!canSend(from)) revert ERC7943CannotSend(from);
        if (!canReceive(to)) revert ERC7943CannotReceive(to);
        gtBool amountWithinFreeBalance = _isAmountWithinFreeBalance(from, amount);
        gtUint256 effectiveAmount = MpcCore.mux(amountWithinFreeBalance, _zeroGt(), amount);
        MpcCore.permitThis(effectiveAmount);
        return effectiveAmount;
    }

    function _beforeUnshield(address account, address, uint256) internal view override {
        if (!canSend(account)) revert ERC7943CannotSend(account);
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

    function _setCanSend(address account, bool allowed) internal {
        require(account != address(0), "invalid argument - zero address");
        PrivateERC7943ERC20Contract256Storage storage $ = _getPrivateERC7943ERC20Contract256Storage();
        $.sendAllowed[account] = allowed;
        $.sendConfigured[account] = true;
        emit CanSendSet(account, allowed);
    }

    function _setCanReceive(address account, bool allowed) internal {
        require(account != address(0), "invalid argument - zero address");
        PrivateERC7943ERC20Contract256Storage storage $ = _getPrivateERC7943ERC20Contract256Storage();
        $.receiveAllowed[account] = allowed;
        $.receiveConfigured[account] = true;
        emit CanReceiveSet(account, allowed);
    }

    function _applyForcedTransfer(address from, address to, gtUint256 requestedAmount)
        internal
        returns (gtUint256 actualAmount)
    {
        gtUint256 fromBalance = _balanceOf(from);
        gtUint256 toBalance = _balanceOf(to);
        (gtBool insufficientBalance, gtUint256 newFromCandidate) =
            MpcCore.checkedSubWithOverflowBit(fromBalance, requestedAmount);

        actualAmount = MpcCore.mux(insufficientBalance, requestedAmount, fromBalance);
        gtUint256 newFromBalance = MpcCore.mux(insufficientBalance, newFromCandidate, _zeroGt());
        gtUint256 newToBalance = MpcCore.add(toBalance, actualAmount);

        _setNewBalances(from, to, newFromBalance, newToBalance);

        MpcCore.permitThis(actualAmount);
        MpcCore.permit(actualAmount, from);
        MpcCore.permit(actualAmount, to);
        MpcCore.permit(actualAmount, msg.sender);
    }

    function _isAmountWithinFreeBalance(address account, gtUint256 amount) internal returns (gtBool) {
        gtUint256 frozen = MpcCore.setPublic256(_getPrivateERC7943ERC20Contract256Storage().frozenTokens[account]);
        (gtBool freeBalanceUnderflow, gtUint256 freeBalanceCandidate) =
            MpcCore.checkedSubWithOverflowBit(_balanceOf(account), frozen);
        gtUint256 freeBalance = MpcCore.mux(freeBalanceUnderflow, freeBalanceCandidate, _zeroGt());
        (gtBool amountUnderflow, ) = MpcCore.checkedSubWithOverflowBit(freeBalance, amount);
        return MpcCore.mux(amountUnderflow, MpcCore.setPublic(true), MpcCore.setPublic(false));
    }
}
