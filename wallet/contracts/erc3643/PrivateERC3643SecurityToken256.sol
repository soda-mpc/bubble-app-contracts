// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@sodalabs/bubble-core-contracts/contracts/bubble/DecryptionCaller.sol";
import "@sodalabs/bubble-core-contracts/contracts/bubble/MpcCore.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";
import "./interfaces/IPrivateERC3643SecurityToken.sol";
import "./interfaces/IPrivateIdentityRegistry.sol";
import "./interfaces/IPrivateSecurityTokenCompliance.sol";

/// @title PrivateERC3643SecurityToken256
/// @notice T-REX-style private security token with agent mint/burn and encrypted balances.
/// @dev This contract intentionally has no shield/unshield or underlying ERC20 custody.
contract PrivateERC3643SecurityToken256 is
    DecryptionCaller,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable,
    IPrivateERC3643SecurityToken
{
    string internal constant TOKEN_VERSION = "0.0.1";

    /// @custom:storage-location erc7201:bubble.storage.PrivateERC3643SecurityToken256
    struct PrivateERC3643SecurityToken256Storage {
        string name;
        string symbol;
        uint8 decimals;
        gtUint256 totalSupply;
        gtUint256 zero;
        mapping(address => gtUint256) balances;
        mapping(address => mapping(address => gtUint256)) allowances;
        IPrivateIdentityRegistry identityRegistry;
        IPrivateSecurityTokenCompliance compliance;
        address onchainID;
        mapping(address => bool) agents;
        mapping(address => bool) frozen;
        mapping(address => gtUint256) frozenTokens;
    }

    // keccak256(abi.encode(uint256(keccak256("bubble.storage.PrivateERC3643SecurityToken256")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant PrivateERC3643SecurityToken256StorageLocation =
        0x9628652b5f6f4de50d2eec11f63f84357259b3c6b175ddb702295f835ad4cf00;

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
        uint8 decimals_,
        address owner_,
        address identityRegistry_,
        address compliance_,
        address onchainID_
    ) public initializer {
        require(bytes(name_).length != 0, "invalid argument - empty string");
        require(bytes(symbol_).length != 0, "invalid argument - empty string");
        require(owner_ != address(0), "Owner cannot be zero address");
        require(identityRegistry_ != address(0), "Identity registry cannot be zero address");
        require(compliance_ != address(0), "Compliance cannot be zero address");

        __Ownable_init(owner_);
        __ReentrancyGuard_init();
        __Pausable_init();

        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        $.name = name_;
        $.symbol = symbol_;
        $.decimals = decimals_;
        $.identityRegistry = IPrivateIdentityRegistry(identityRegistry_);
        $.compliance = IPrivateSecurityTokenCompliance(compliance_);
        $.onchainID = onchainID_;
        $.agents[owner_] = true;
        $.zero = MpcCore.setPublic256(0);
        $.totalSupply = $.zero;

        MpcCore.permitThis($.zero);
        MpcCore.permit($.zero, owner_);
        $.compliance.bindToken(address(this));

        emit IdentityRegistryAdded(identityRegistry_);
        emit ComplianceAdded(compliance_);
        emit AgentAdded(owner_);
        emit UpdatedTokenInformation(name_, symbol_, decimals_, TOKEN_VERSION, onchainID_);
        emit PrivateTotalSupplyUpdated($.totalSupply);
    }

    function _getStorage() internal pure returns (PrivateERC3643SecurityToken256Storage storage $) {
        assembly {
            $.slot := PrivateERC3643SecurityToken256StorageLocation
        }
    }

    function _authorizeUpgrade(address) internal override onlyOwner {}

    function name() public view returns (string memory) {
        return _getStorage().name;
    }

    function symbol() public view returns (string memory) {
        return _getStorage().symbol;
    }

    function decimals() public view returns (uint8) {
        return _getStorage().decimals;
    }

    function totalSupply() public view returns (gtUint256) {
        return _getStorage().totalSupply;
    }

    function balanceOf() public view returns (gtUint256) {
        return _getStorage().balances[msg.sender];
    }

    function balanceOf(address account) public view returns (gtUint256) {
        return _getStorage().balances[account];
    }

    function allowance(address tokenOwner, address spender) public view returns (gtUint256) {
        require(tokenOwner == msg.sender || spender == msg.sender);
        return _getGTAllowance(tokenOwner, spender);
    }

    function transfer(address to, itUint256 calldata it) public whenNotPaused returns (gtBool) {
        gtUint256 value = MpcCore.validateCiphertext(it);
        MpcCore.permitTransient(value, msg.sender);
        return contractTransfer(to, value);
    }

    function transfer(address to, uint256 value) public whenNotPaused returns (gtBool) {
        gtUint256 requestedValue = MpcCore.setPublic256(value);
        MpcCore.permitThis(requestedValue);
        return _transferGt(msg.sender, to, requestedValue);
    }

    function contractTransfer(address to, gtUint256 value) public whenNotPaused returns (gtBool) {
        require(MpcCore.isSenderPermitted(value));
        return _transferGt(msg.sender, to, value);
    }

    function transferFrom(address from, address to, itUint256 calldata it) public whenNotPaused returns (gtBool) {
        gtUint256 value = MpcCore.validateCiphertext(it);
        MpcCore.permitTransient(value, msg.sender);
        return contractTransferFrom(from, to, value);
    }

    function transferFrom(address from, address to, uint256 value) public whenNotPaused returns (gtBool) {
        gtUint256 requestedValue = MpcCore.setPublic256(value);
        MpcCore.permitThis(requestedValue);
        return _transferFromGt(from, to, requestedValue);
    }

    function contractTransferFrom(address from, address to, gtUint256 value) public whenNotPaused returns (gtBool) {
        require(MpcCore.isSenderPermitted(value));
        return _transferFromGt(from, to, value);
    }

    function approve(address spender, itUint256 calldata it) public whenNotPaused returns (bool) {
        gtUint256 value = MpcCore.validateCiphertext(it);
        MpcCore.permitTransient(value, msg.sender);
        return contractApprove(spender, value);
    }

    function approve(address spender, uint256 value) public whenNotPaused returns (bool) {
        _beforePrivateApprove(msg.sender, spender);
        gtUint256 gt = MpcCore.setPublic256(value);
        _setApproveValue(msg.sender, spender, gt);
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function contractApprove(address spender, gtUint256 value) public whenNotPaused returns (bool) {
        require(MpcCore.isSenderPermitted(value));
        _beforePrivateApprove(msg.sender, spender);
        _setApproveValue(msg.sender, spender, value);
        emit Approval(msg.sender, spender);
        return true;
    }

    function mint(address to, itUint256 calldata it) external override onlyAgent whenNotPaused returns (bool) {
        require(to != address(0), "ERC20: mint to the zero address");
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        require(!$.frozen[to], "wallet is frozen");
        require($.identityRegistry.isVerified(to), "Identity is not verified.");

        gtUint256 requestedAmount = MpcCore.validateCiphertext(it);
        MpcCore.permitTransient(requestedAmount, address($.compliance));
        gtBool complianceAllows = $.compliance.canCreate(to, requestedAmount);
        gtUint256 actualAmount = MpcCore.mux(complianceAllows, _zeroGt(), requestedAmount);

        $.balances[to] = MpcCore.add(_balanceOf(to), actualAmount);
        $.totalSupply = MpcCore.add(_totalSupply(), actualAmount);
        _permitBalance(to);
        _permitSupply();
        _permitAmount(actualAmount, to);

        MpcCore.permitTransient(actualAmount, address($.compliance));
        $.compliance.created(to, actualAmount);
        emit PrivateMint(to, actualAmount);
        emit PrivateTotalSupplyUpdated($.totalSupply);
        return true;
    }

    function burn(address from, itUint256 calldata it) external override onlyAgent whenNotPaused returns (bool) {
        require(from != address(0), "ERC20: burn from the zero address");
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        require(!$.frozen[from], "wallet is frozen");

        gtUint256 requestedAmount = MpcCore.validateCiphertext(it);
        gtBool amountWithinFreeBalance = _isAmountWithinFreeBalance(from, requestedAmount);
        gtUint256 realBurned = MpcCore.mux(amountWithinFreeBalance, _zeroGt(), requestedAmount);

        (, $.balances[from]) = MpcCore.checkedSubWithOverflowBit(_balanceOf(from), realBurned);
        (, $.totalSupply) = MpcCore.checkedSubWithOverflowBit(_totalSupply(), realBurned);
        _permitBalance(from);
        _permitSupply();
        _permitAmount(realBurned, from);
        _permitAmount(requestedAmount, from);

        MpcCore.permitTransient(realBurned, address($.compliance));
        $.compliance.destroyed(from, realBurned);
        emit PrivateBurn(from, requestedAmount, realBurned);
        emit PrivateTotalSupplyUpdated($.totalSupply);
        return true;
    }

    function setName(string calldata name_) external override onlyOwner {
        require(bytes(name_).length != 0, "invalid argument - empty string");
        _getStorage().name = name_;
        emit UpdatedTokenInformation(name_, symbol(), decimals(), TOKEN_VERSION, onchainID());
    }

    function setSymbol(string calldata symbol_) external override onlyOwner {
        require(bytes(symbol_).length != 0, "invalid argument - empty string");
        _getStorage().symbol = symbol_;
        emit UpdatedTokenInformation(name(), symbol_, decimals(), TOKEN_VERSION, onchainID());
    }

    function setOnchainID(address onchainID_) external override onlyOwner {
        _getStorage().onchainID = onchainID_;
        emit UpdatedTokenInformation(name(), symbol(), decimals(), TOKEN_VERSION, onchainID_);
    }

    function setIdentityRegistry(address identityRegistry_) external override onlyOwner {
        require(identityRegistry_ != address(0), "Identity registry cannot be zero address");
        _getStorage().identityRegistry = IPrivateIdentityRegistry(identityRegistry_);
        emit IdentityRegistryAdded(identityRegistry_);
    }

    function setCompliance(address compliance_) external override onlyOwner {
        require(compliance_ != address(0), "Compliance cannot be zero address");
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        address previousCompliance = address($.compliance);
        if (previousCompliance == compliance_) {
            return;
        }
        $.compliance = IPrivateSecurityTokenCompliance(compliance_);
        $.compliance.bindToken(address(this));
        if (previousCompliance != address(0)) {
            IPrivateSecurityTokenCompliance(previousCompliance).unbindToken(address(this));
        }
        emit ComplianceAdded(compliance_);
    }

    function addAgent(address agent) external override onlyOwner {
        require(agent != address(0), "invalid argument - zero address");
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        require(!$.agents[agent], "Roles: account already has role");
        $.agents[agent] = true;
        emit AgentAdded(agent);
    }

    function removeAgent(address agent) external override onlyOwner {
        require(agent != address(0), "invalid argument - zero address");
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        require($.agents[agent], "Roles: account does not have role");
        $.agents[agent] = false;
        emit AgentRemoved(agent);
    }

    function pause() external onlyAgent {
        _pause();
    }

    function unpause() external onlyAgent {
        _unpause();
    }

    function setAddressFrozen(address userAddress, bool freeze) public override onlyAgent {
        _getStorage().frozen[userAddress] = freeze;
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

    function forcedTransfer(address from, address to, itUint256 calldata it)
        external
        override
        onlyAgent
        whenNotPaused
        returns (bool)
    {
        require(from != address(0), "ERC20: transfer from the zero address");
        require(to != address(0), "ERC20: transfer to the zero address");
        require(from != to, "ERC20: forced transfer to self");
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        require(!$.frozen[to], "wallet is frozen");
        require($.identityRegistry.isVerified(to), "Transfer not possible");

        gtUint256 requestedAmount = MpcCore.validateCiphertext(it);
        gtUint256 actualAmount = _applyForcedTransfer(from, to, requestedAmount);
        MpcCore.permitTransient(actualAmount, address($.compliance));
        $.compliance.transferred(from, to, actualAmount);
        emit Transfer(from, to);
        emit ForcedTransfer(from, to, actualAmount);
        return true;
    }

    function identityRegistry() external view override returns (IPrivateIdentityRegistry) {
        return _getStorage().identityRegistry;
    }

    function compliance() external view override returns (IPrivateSecurityTokenCompliance) {
        return _getStorage().compliance;
    }

    function onchainID() public view override returns (address) {
        return _getStorage().onchainID;
    }

    function version() external pure override returns (string memory) {
        return TOKEN_VERSION;
    }

    function isAgent(address agent) public view override returns (bool) {
        require(agent != address(0), "Roles: account is the zero address");
        return _getStorage().agents[agent];
    }

    function isFrozen(address userAddress) external view override returns (bool) {
        return _getStorage().frozen[userAddress];
    }

    function getFrozenTokens(address userAddress) external view override returns (gtUint256) {
        return _getStorage().frozenTokens[userAddress];
    }

    function _transferGt(address from, address to, gtUint256 requestedValue) internal returns (gtBool) {
        require(to != address(0), "ERC20: transfer to the zero address");
        if (from == to) {
            _effectivePrivateTransferAmount(from, to, requestedValue);
            gtBool selfTransferResult = MpcCore.setPublic(true);
            _afterPrivateTransfer(from, to, _zeroGt());
            emit Transfer(from, to);
            return selfTransferResult;
        }

        (gtUint256 fromBalance, gtUint256 toBalance) = (_balanceOf(from), _balanceOf(to));
        gtUint256 effectiveValue = _effectivePrivateTransferAmount(from, to, requestedValue);
        (gtUint256 newFromBalance, gtUint256 newToBalance, gtBool result) =
            MpcCore.transfer(fromBalance, toBalance, effectiveValue);
        _setNewBalances(from, to, newFromBalance, newToBalance);
        _afterPrivateTransfer(from, to, _calculateBalanceIncrease(toBalance, newToBalance));
        emit Transfer(from, to);
        return result;
    }

    function _transferFromGt(address from, address to, gtUint256 requestedValue) internal returns (gtBool) {
        require(from != address(0), "ERC20: transfer from the zero address");
        require(to != address(0), "ERC20: transfer to the zero address");
        gtUint256 allowanceValue = _getGTAllowance(from, msg.sender);
        if (from == to) {
            _effectivePrivateTransferAmount(from, to, requestedValue);
            gtBool hasSufficientAllowance = MpcCore.ge(allowanceValue, requestedValue);
            _afterPrivateTransfer(from, to, _zeroGt());
            emit Transfer(from, to);
            return hasSufficientAllowance;
        }

        (gtUint256 fromBalance, gtUint256 toBalance) = (_balanceOf(from), _balanceOf(to));
        gtUint256 effectiveValue = _effectivePrivateTransferAmount(from, to, requestedValue);
        (gtUint256 newFromBalance, gtUint256 newToBalance, gtBool result, gtUint256 newAllowance) =
            MpcCore.transferWithAllowance(fromBalance, toBalance, effectiveValue, allowanceValue);
        _setApproveValue(from, msg.sender, newAllowance);
        _setNewBalances(from, to, newFromBalance, newToBalance);
        _afterPrivateTransfer(from, to, _calculateBalanceIncrease(toBalance, newToBalance));
        emit Transfer(from, to);
        return result;
    }

    function _effectivePrivateTransferAmount(address from, address to, gtUint256 amount)
        internal
        returns (gtUint256)
    {
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        require(!$.frozen[from] && !$.frozen[to], "wallet is frozen");
        require($.identityRegistry.isVerified(to), "Transfer not possible");
        MpcCore.permitTransient(amount, address($.compliance));
        gtBool complianceAllows = $.compliance.canTransfer(from, to, amount);
        gtBool amountWithinFreeBalance = _isAmountWithinFreeBalance(from, amount);
        gtBool transferAllowed = MpcCore.and(complianceAllows, amountWithinFreeBalance);
        gtUint256 effectiveAmount = MpcCore.mux(transferAllowed, _zeroGt(), amount);
        MpcCore.permitThis(effectiveAmount);
        return effectiveAmount;
    }

    function _afterPrivateTransfer(address from, address to, gtUint256 amount) internal {
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        MpcCore.permitTransient(amount, address($.compliance));
        $.compliance.transferred(from, to, amount);
    }

    function _beforePrivateApprove(address tokenOwner, address spender) internal view {
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        require(!$.frozen[tokenOwner] && !$.frozen[spender], "wallet is frozen");
    }

    function _freezePartialTokensGt(address userAddress, gtUint256 amount) internal {
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        gtUint256 currentFrozen = _normalizedFrozen(userAddress);
        gtUint256 newFrozenCandidate = MpcCore.add(currentFrozen, amount);
        (gtBool freezeOverflowBit, ) = MpcCore.checkedSubWithOverflowBit(_balanceOf(userAddress), newFrozenCandidate);
        gtUint256 actualFrozen = MpcCore.mux(freezeOverflowBit, amount, _zeroGt());
        gtUint256 newFrozen = MpcCore.mux(freezeOverflowBit, newFrozenCandidate, currentFrozen);
        $.frozenTokens[userAddress] = newFrozen;
        _permitFrozen(userAddress);
        _permitAmount(actualFrozen, userAddress);
        emit TokensFrozen(userAddress, actualFrozen);
    }

    function _unfreezePartialTokensGt(address userAddress, gtUint256 amount) internal {
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        (gtBool overflowBit, gtUint256 newFrozenCandidate) =
            MpcCore.checkedSubWithOverflowBit(_normalizedFrozen(userAddress), amount);
        gtUint256 actualUnfrozen = MpcCore.mux(overflowBit, amount, _zeroGt());
        gtUint256 newFrozen = MpcCore.mux(overflowBit, newFrozenCandidate, _normalizedFrozen(userAddress));
        $.frozenTokens[userAddress] = newFrozen;
        _permitFrozen(userAddress);
        _permitAmount(actualUnfrozen, userAddress);
        emit TokensUnfrozen(userAddress, actualUnfrozen);
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
        _capFrozenTokensAfterForcedTransfer(from, newFromBalance);
        _permitAmount(actualAmount, from);
    }

    function _capFrozenTokensAfterForcedTransfer(address from, gtUint256 newFromBalance) internal {
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        gtUint256 currentFrozen = _normalizedFrozen(from);
        (gtBool frozenExceedsBalance, ) = MpcCore.checkedSubWithOverflowBit(newFromBalance, currentFrozen);
        gtUint256 newFrozen = MpcCore.mux(frozenExceedsBalance, currentFrozen, newFromBalance);
        (gtBool unfreezeUnderflow, gtUint256 actualUnfrozenCandidate) =
            MpcCore.checkedSubWithOverflowBit(currentFrozen, newFrozen);
        gtUint256 actualUnfrozen = MpcCore.mux(unfreezeUnderflow, actualUnfrozenCandidate, _zeroGt());

        $.frozenTokens[from] = newFrozen;
        _permitFrozen(from);
        _permitAmount(actualUnfrozen, from);
        emit TokensUnfrozen(from, actualUnfrozen);
    }

    function _balanceOf(address account) internal view returns (gtUint256) {
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        gtUint256 balance = $.balances[account];
        if (gtUint256.unwrap(balance) == 0) {
            balance = $.zero;
        }
        return balance;
    }

    function _totalSupply() internal view returns (gtUint256) {
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        if (gtUint256.unwrap($.totalSupply) == 0) {
            return $.zero;
        }
        return $.totalSupply;
    }

    function _setNewBalances(address from, address to, gtUint256 newFromBalance, gtUint256 newToBalance) internal {
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        $.balances[from] = newFromBalance;
        $.balances[to] = newToBalance;
        _permitBalance(from);
        _permitBalance(to);
    }

    function _getGTAllowance(address tokenOwner, address spender) internal view returns (gtUint256) {
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        if (gtUint256.unwrap($.allowances[tokenOwner][spender]) == 0) {
            return $.zero;
        }
        return $.allowances[tokenOwner][spender];
    }

    function _setApproveValue(address tokenOwner, address spender, gtUint256 value) internal {
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        $.allowances[tokenOwner][spender] = value;
        MpcCore.permitThis(value);
        MpcCore.permit(value, tokenOwner);
    }

    function _zeroGt() internal view returns (gtUint256) {
        return _getStorage().zero;
    }

    function _normalizedFrozen(address account) internal view returns (gtUint256) {
        PrivateERC3643SecurityToken256Storage storage $ = _getStorage();
        gtUint256 frozen = $.frozenTokens[account];
        if (gtUint256.unwrap(frozen) == 0) {
            return $.zero;
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

    function _calculateBalanceIncrease(gtUint256 beforeBalance, gtUint256 afterBalance)
        internal
        returns (gtUint256)
    {
        (gtBool didIncrease, gtUint256 increaseCandidate) =
            MpcCore.checkedSubWithOverflowBit(afterBalance, beforeBalance);
        return MpcCore.mux(didIncrease, increaseCandidate, _zeroGt());
    }

    function _permitBalance(address account) internal {
        gtUint256 balance = _getStorage().balances[account];
        MpcCore.permitThis(balance);
        MpcCore.permit(balance, account);
        MpcCore.permit(balance, owner());
        MpcCore.permit(balance, msg.sender);
    }

    function _permitSupply() internal {
        gtUint256 supply = _getStorage().totalSupply;
        MpcCore.permitThis(supply);
        MpcCore.permit(supply, owner());
        MpcCore.permit(supply, msg.sender);
    }

    function _permitFrozen(address account) internal {
        gtUint256 frozen = _getStorage().frozenTokens[account];
        MpcCore.permitThis(frozen);
        MpcCore.permit(frozen, account);
        MpcCore.permit(frozen, owner());
        MpcCore.permit(frozen, msg.sender);
    }

    function _permitAmount(gtUint256 amount, address account) internal {
        MpcCore.permitThis(amount);
        MpcCore.permit(amount, account);
        MpcCore.permit(amount, owner());
        MpcCore.permit(amount, msg.sender);
    }
}
