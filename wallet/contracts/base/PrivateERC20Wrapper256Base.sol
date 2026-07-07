// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@sodalabs/bubble-core-contracts/contracts/bubble/MpcCore.sol";
import "@sodalabs/bubble-core-contracts/contracts/bubble/DecryptionCaller.sol";
import "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import "@openzeppelin/contracts-upgradeable/access/Ownable2StepUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/proxy/utils/UUPSUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/PausableUpgradeable.sol";
import "@openzeppelin/contracts-upgradeable/utils/ReentrancyGuardUpgradeable.sol";

interface IBaseWrappedNative is IERC20 {
    function withdraw(uint256 wad) external;
}

/// @title PrivateERC20Wrapper256Base
/// @notice Reduced private ERC20 wrapper base with shield/unshield and encrypted ERC20-style balances.
/// @dev This base intentionally excludes OPRF functionality. Feature contracts should add their own
///      ERC-7201 storage namespaces instead of inheriting direct-storage implementation contracts.
abstract contract PrivateERC20Wrapper256Base is
    DecryptionCaller,
    UUPSUpgradeable,
    Ownable2StepUpgradeable,
    ReentrancyGuardUpgradeable,
    PausableUpgradeable
{
    event Transfer(address indexed _from, address indexed _to, uint256 _value);
    /// @notice Emitted when tokens are transferred using encrypted amounts
    event PrivateTransfer(address indexed from, address indexed to, gtUint256 amount);
    event Approval(address indexed _owner, address indexed _spender, uint256 _value);
    event Approval(address indexed _owner, address indexed _spender);
    event Shield(address indexed from, uint256 amount);
    event Unshield(address indexed to, uint256 amount);
    event UnshieldRequested(address indexed to, uint256 amount);
    event UnshieldFailed(address indexed to, uint256 amount);
    event MasterUpdated(address indexed oldMaster, address indexed newMaster);
    event EmergencyRecovery(address indexed owner, uint256 amount);
    event NativeRecovered(address indexed to, uint256 amount);

    /// @custom:storage-location erc7201:bubble.storage.PrivateERC20Wrapper256Base
    struct PrivateERC20Wrapper256BaseStorage {
        string _name;
        string _symbol;
        uint256 _totalSupply;
        gtUint256 zero;
        mapping(address => gtUint256) balances;
        mapping(address => mapping(address => gtUint256)) allowances;
        address master;
        IERC20 underlying;
        mapping(uint256 => UnshieldRequest) unshieldRequests;
        uint8 underlyingDecimals;
        bool underlyingIsWrappedNative;
    }

    struct UnshieldRequest {
        address user;
        bool unwrapNative;
    }

    // keccak256(abi.encode(uint256(keccak256("bubble.storage.PrivateERC20Wrapper256Base")) - 1)) & ~bytes32(uint256(0xff))
    bytes32 private constant PrivateERC20Wrapper256BaseStorageLocation =
        0x8ab512b72e76caebe6b1cc326e82ffd7b5a4dc04a08aa7dacf8f84ba6d8ee300;

    /// @custom:oz-upgrades-unsafe-allow constructor
    constructor() {
        _disableInitializers();
    }

    function _initializePrivateERC20Wrapper256Base(
        string memory name_,
        string memory symbol_,
        address underlying_,
        address owner_,
        address master_,
        bool underlyingIsWrappedNative_
    ) internal onlyInitializing {
        require(underlying_ != address(0), "Underlying cannot be zero address");
        require(owner_ != address(0), "Owner cannot be zero address");
        require(master_ != address(0), "Master cannot be zero address");

        __Ownable_init(owner_);
        __ReentrancyGuard_init();
        __Pausable_init();

        PrivateERC20Wrapper256BaseStorage storage $ = _getPrivateERC20Wrapper256BaseStorage();
        $._name = name_;
        $._symbol = symbol_;
        $.master = master_;
        $.underlying = IERC20(underlying_);
        $.underlyingIsWrappedNative = underlyingIsWrappedNative_;
        $.underlyingDecimals = IERC20Metadata(underlying_).decimals();
        $.zero = MpcCore.setPublic256(0);
        MpcCore.permitThis($.zero);
    }

    receive() external payable {
        PrivateERC20Wrapper256BaseStorage storage $ = _getPrivateERC20Wrapper256BaseStorage();
        require($.underlyingIsWrappedNative && msg.sender == address($.underlying), "Unexpected native sender");
    }

    function _getPrivateERC20Wrapper256BaseStorage()
        internal
        pure
        returns (PrivateERC20Wrapper256BaseStorage storage $)
    {
        assembly {
            $.slot := PrivateERC20Wrapper256BaseStorageLocation
        }
    }

    function _authorizeUpgrade(address _newImplementation) internal virtual override onlyOwner {}

    function name() public view returns (string memory) {
        return _getPrivateERC20Wrapper256BaseStorage()._name;
    }

    function symbol() public view returns (string memory) {
        return _getPrivateERC20Wrapper256BaseStorage()._symbol;
    }

    function decimals() public view returns (uint8) {
        return _getPrivateERC20Wrapper256BaseStorage().underlyingDecimals;
    }

    function totalSupply() public view returns (uint256) {
        return _getPrivateERC20Wrapper256BaseStorage()._totalSupply;
    }

    function master() public view returns (address) {
        return _getPrivateERC20Wrapper256BaseStorage().master;
    }

    function underlying() public view returns (address) {
        return address(_getPrivateERC20Wrapper256BaseStorage().underlying);
    }

    function underlyingIsWrappedNative() public view returns (bool) {
        return _getPrivateERC20Wrapper256BaseStorage().underlyingIsWrappedNative;
    }

    function getLastDecryptRequestId() external view returns (uint256) {
        return decryptCounter > 0 ? decryptCounter - 1 : 0;
    }

    function setMaster(address newMaster) external onlyOwner {
        require(newMaster != address(0), "Master cannot be zero address");
        PrivateERC20Wrapper256BaseStorage storage $ = _getPrivateERC20Wrapper256BaseStorage();
        address oldMaster = $.master;
        $.master = newMaster;
        emit MasterUpdated(oldMaster, newMaster);
    }

    function pause() external virtual onlyOwner {
        _pause();
    }

    function unpause() external virtual onlyOwner {
        _unpause();
    }

    function emergencyRecovery() external onlyOwner nonReentrant returns (uint256) {
        PrivateERC20Wrapper256BaseStorage storage $ = _getPrivateERC20Wrapper256BaseStorage();
        if (!paused()) {
            _pause();
        }

        address ownerAddress = owner();
        uint256 balance = $.underlying.balanceOf(address(this));
        if (balance > 0) {
            require($.underlying.transfer(ownerAddress, balance), "Transfer failed");
            emit EmergencyRecovery(ownerAddress, balance);
        }

        $._totalSupply = 0;
        return balance;
    }

    function recoverNative(address to, uint256 amount)
        external
        onlyOwner
        nonReentrant
        returns (uint256 recoveredAmount)
    {
        require(to != address(0), "Recipient cannot be zero address");
        uint256 nativeBalance = address(this).balance;
        recoveredAmount = amount == 0 ? nativeBalance : amount;
        require(recoveredAmount <= nativeBalance, "Insufficient native balance");
        (bool sent, ) = payable(to).call{value: recoveredAmount}("");
        require(sent, "Native transfer failed");
        emit NativeRecovered(to, recoveredAmount);
    }

    function balanceOf() public view returns (gtUint256) {
        return _getPrivateERC20Wrapper256BaseStorage().balances[msg.sender];
    }

    function balanceOf(address account) public view returns (gtUint256) {
        return _getPrivateERC20Wrapper256BaseStorage().balances[account];
    }

    function transfer(address to, itUint256 calldata it) public virtual whenNotPaused returns (gtBool) {
        gtUint256 value = MpcCore.validateCiphertext(it);
        MpcCore.permitTransient(value, msg.sender);
        return contractTransfer(to, value);
    }

    function transfer(address to, uint256 value) public virtual whenNotPaused returns (gtBool) {
        gtUint256 requestedValue = MpcCore.setPublic256(value);
        if (msg.sender == to) {
            _effectivePrivateTransferAmount(msg.sender, to, requestedValue);
            gtBool selfTransferResult = MpcCore.setPublic(true);
            _afterPrivateTransfer(msg.sender, to, _zeroGt(), selfTransferResult);
            return selfTransferResult;
        }

        (gtUint256 fromBalance, gtUint256 toBalance) = _getBalances(msg.sender, to);
        gtUint256 effectiveValue = _effectivePrivateTransferAmount(msg.sender, to, requestedValue);
        (gtUint256 newFromBalance, gtUint256 newToBalance, gtBool result) =
            MpcCore.transfer(fromBalance, toBalance, effectiveValue);
        _setNewBalances(msg.sender, to, newFromBalance, newToBalance);
        _permitAndEmitPrivateTransfer(msg.sender, to, effectiveValue, MpcCore.not(result));
        _afterPrivateTransfer(msg.sender, to, _calculateBalanceIncrease(toBalance, newToBalance), result);
        return result;
    }

    function contractTransfer(address to, gtUint256 value) public virtual whenNotPaused returns (gtBool) {
        require(MpcCore.isSenderPermitted(value));

        if (msg.sender == to) {
            gtBool hasSufficientBalance = MpcCore.ge(_balanceOf(msg.sender), value);
            _effectivePrivateTransferAmount(msg.sender, to, value);
            _permitAndEmitPrivateTransfer(msg.sender, to, value, hasSufficientBalance);
            gtBool selfTransferResult = MpcCore.setPublic(true);
            _afterPrivateTransfer(msg.sender, to, _zeroGt(), selfTransferResult);
            return selfTransferResult;
        }

        (gtUint256 fromBalance, gtUint256 toBalance) = _getBalances(msg.sender, to);
        gtUint256 effectiveValue = _effectivePrivateTransferAmount(msg.sender, to, value);
        (gtUint256 newFromBalance, gtUint256 newToBalance, gtBool result) =
            MpcCore.transfer(fromBalance, toBalance, effectiveValue);
        _setNewBalances(msg.sender, to, newFromBalance, newToBalance);
        _permitAndEmitPrivateTransfer(msg.sender, to, effectiveValue, MpcCore.not(result));
        _afterPrivateTransfer(msg.sender, to, _calculateBalanceIncrease(toBalance, newToBalance), result);
        return result;
    }

    function transferFrom(address from, address to, itUint256 calldata it)
        public
        virtual
        whenNotPaused
        returns (gtBool)
    {
        gtUint256 value = MpcCore.validateCiphertext(it);
        MpcCore.permitTransient(value, msg.sender);
        return contractTransferFrom(from, to, value);
    }

    function transferFrom(address from, address to, uint256 value) public virtual whenNotPaused returns (gtBool) {
        gtUint256 allowanceValue = _getGTAllowance(from, msg.sender);
        gtUint256 requestedValue = MpcCore.setPublic256(value);

        if (from == to) {
            MpcCore.permitThis(requestedValue);
            _effectivePrivateTransferAmount(from, to, requestedValue);
            gtBool hasSufficientAllowance = MpcCore.ge(allowanceValue, requestedValue);
            _permitAndEmitPrivateTransfer(from, to, requestedValue, hasSufficientAllowance);
            _afterPrivateTransfer(from, to, _zeroGt(), hasSufficientAllowance);
            return hasSufficientAllowance;
        }

        (gtUint256 fromBalance, gtUint256 toBalance) = _getBalances(from, to);
        gtUint256 effectiveValue = _effectivePrivateTransferAmount(from, to, requestedValue);
        (gtUint256 newFromBalance, gtUint256 newToBalance, gtBool result, gtUint256 newAllowance) =
            MpcCore.transferWithAllowance(fromBalance, toBalance, effectiveValue, allowanceValue);
        _setApproveValue(from, msg.sender, newAllowance);
        _setNewBalances(from, to, newFromBalance, newToBalance);
        _permitAndEmitPrivateTransfer(from, to, effectiveValue, MpcCore.not(result));
        _afterPrivateTransfer(from, to, _calculateBalanceIncrease(toBalance, newToBalance), result);
        return result;
    }

    function contractTransferFrom(address from, address to, gtUint256 value)
        public
        virtual
        whenNotPaused
        returns (gtBool)
    {
        require(MpcCore.isSenderPermitted(value));
        gtUint256 allowanceValue = _getGTAllowance(from, msg.sender);

        if (from == to) {
            _effectivePrivateTransferAmount(from, to, value);
            gtBool hasSufficientAllowance = MpcCore.ge(allowanceValue, value);
            _permitAndEmitPrivateTransfer(from, to, value, hasSufficientAllowance);
            _afterPrivateTransfer(from, to, _zeroGt(), hasSufficientAllowance);
            return hasSufficientAllowance;
        }

        (gtUint256 fromBalance, gtUint256 toBalance) = _getBalances(from, to);
        gtUint256 effectiveValue = _effectivePrivateTransferAmount(from, to, value);
        (gtUint256 newFromBalance, gtUint256 newToBalance, gtBool result, gtUint256 newAllowance) =
            MpcCore.transferWithAllowance(fromBalance, toBalance, effectiveValue, allowanceValue);
        _setApproveValue(from, msg.sender, newAllowance);
        _setNewBalances(from, to, newFromBalance, newToBalance);
        _permitAndEmitPrivateTransfer(from, to, effectiveValue, MpcCore.not(result));
        _afterPrivateTransfer(from, to, _calculateBalanceIncrease(toBalance, newToBalance), result);
        return result;
    }

    function approve(address spender, itUint256 calldata it) public virtual whenNotPaused returns (bool) {
        return contractApprove(spender, MpcCore.validateCiphertext(it));
    }

    function approve(address spender, uint256 value) public virtual whenNotPaused returns (bool) {
        _beforePrivateApprove(msg.sender, spender);
        gtUint256 gt = MpcCore.setPublic256(value);
        _setApproveValue(msg.sender, spender, gt);
        emit Approval(msg.sender, spender, value);
        return true;
    }

    function contractApprove(address spender, gtUint256 value) public virtual whenNotPaused returns (bool) {
        require(MpcCore.isSenderPermitted(value));
        _beforePrivateApprove(msg.sender, spender);
        _setApproveValue(msg.sender, spender, value);
        emit Approval(msg.sender, spender);
        return true;
    }

    function allowance(address tokenOwner, address spender) public view returns (gtUint256) {
        require(tokenOwner == msg.sender || spender == msg.sender);
        return _getGTAllowance(tokenOwner, spender);
    }

    function shield(uint256 amount) public virtual nonReentrant whenNotPaused returns (bool) {
        require(amount > 0, "Amount must be greater than 0");
        _beforeShield(msg.sender, amount);
        _shield(msg.sender, amount);
        _afterShield(msg.sender, amount);
        return true;
    }

    function unshield(uint256 privateAmount) public virtual whenNotPaused returns (bool) {
        return _unshieldTo(privateAmount, msg.sender);
    }

    function callbackUnshield(uint256 decryptID, bytes[] calldata output, bytes[] calldata signatures)
        public
        virtual
        nonReentrant
        verifyCallback(decryptID, output, signatures)
    {
        PrivateERC20Wrapper256BaseStorage storage $ = _getPrivateERC20Wrapper256BaseStorage();
        UnshieldRequest storage request = $.unshieldRequests[decryptID];
        require(request.user != address(0), "Invalid request ID");

        uint256 privateAmountToUnshield = abi.decode(output[0], (uint256));
        if (privateAmountToUnshield > 0) {
            $._totalSupply -= privateAmountToUnshield;
            if (request.unwrapNative) {
                require($.underlyingIsWrappedNative, "Underlying unwrap not configured");
                IBaseWrappedNative(address($.underlying)).withdraw(privateAmountToUnshield);
                (bool sent, ) = payable(request.user).call{value: privateAmountToUnshield}("");
                require(sent, "Native transfer failed");
            } else {
                require($.underlying.transfer(request.user, privateAmountToUnshield), "Transfer failed");
            }
            emit Unshield(request.user, privateAmountToUnshield);
            _afterUnshield(decryptID, request.user, privateAmountToUnshield);
        } else {
            emit UnshieldFailed(request.user, privateAmountToUnshield);
        }

        delete $.unshieldRequests[decryptID];
    }

    function _shield(address account, uint256 amount) internal virtual {
        PrivateERC20Wrapper256BaseStorage storage $ = _getPrivateERC20Wrapper256BaseStorage();
        require($.underlying.transferFrom(account, address(this), amount), "Transfer failed");
        gtUint256 newBalanceGt = MpcCore.add(_balanceOf(account), MpcCore.setPublic256(amount));
        $.balances[account] = newBalanceGt;
        $._totalSupply += amount;
        MpcCore.permitThis(newBalanceGt);
        MpcCore.permit(newBalanceGt, account);
        emit Shield(account, amount);
    }

    function _unshieldTo(uint256 privateAmount, address recipient) internal virtual returns (bool) {
        require(privateAmount > 0, "Amount must be greater than 0");
        _beforeUnshield(msg.sender, recipient, privateAmount);
        gtUint256 amountGt = MpcCore.setPublic256(privateAmount);
        gtUint256 amountToUnshieldGt = _debitBalanceForUnshield(msg.sender, amountGt);
        _requestUnshieldFromHandle(amountToUnshieldGt, recipient);
        emit UnshieldRequested(recipient, privateAmount);
        _afterUnshieldRequest(msg.sender, recipient, privateAmount, amountToUnshieldGt);
        return true;
    }

    function _debitBalanceForUnshield(address account, gtUint256 amount)
        internal
        virtual
        returns (gtUint256 amountToUnshieldGt)
    {
        PrivateERC20Wrapper256BaseStorage storage $ = _getPrivateERC20Wrapper256BaseStorage();
        gtUint256 balanceBefore = _balanceOf(account);
        (, gtUint256 balanceAfter) = MpcCore.checkedSubWithOverflowBit(balanceBefore, amount);
        (, amountToUnshieldGt) = MpcCore.checkedSubWithOverflowBit(balanceBefore, balanceAfter);

        MpcCore.permitThis(amountToUnshieldGt);
        MpcCore.permitThis(balanceAfter);
        MpcCore.permit(balanceAfter, account);
        $.balances[account] = balanceAfter;
    }

    function _requestUnshieldFromHandle(gtUint256 amountToUnshieldGt, address recipient) internal virtual {
        _requestUnshieldFromHandle(amountToUnshieldGt, recipient, false);
    }

    function _requestUnshieldFromHandle(gtUint256 amountToUnshieldGt, address recipient, bool unwrapNative)
        internal
        virtual
    {
        PrivateERC20Wrapper256BaseStorage storage $ = _getPrivateERC20Wrapper256BaseStorage();
        uint256[] memory handles = new uint256[](1);
        handles[0] = gtUint256.unwrap(amountToUnshieldGt);

        $.unshieldRequests[decryptCounter] = UnshieldRequest({
            user: recipient,
            unwrapNative: unwrapNative
        });

        requestDecryption(handles, this.callbackUnshield.selector);
    }

    function _balanceOf(address account) internal view returns (gtUint256) {
        PrivateERC20Wrapper256BaseStorage storage $ = _getPrivateERC20Wrapper256BaseStorage();
        gtUint256 balance = $.balances[account];
        if (gtUint256.unwrap(balance) == 0) {
            balance = $.zero;
        }
        return balance;
    }

    function _getBalances(address from, address to) internal view returns (gtUint256, gtUint256) {
        return (_balanceOf(from), _balanceOf(to));
    }

    function _setNewBalances(address from, address to, gtUint256 newFromBalance, gtUint256 newToBalance)
        internal
        virtual
    {
        PrivateERC20Wrapper256BaseStorage storage $ = _getPrivateERC20Wrapper256BaseStorage();
        $.balances[from] = newFromBalance;
        $.balances[to] = newToBalance;
        MpcCore.permitThis(newFromBalance);
        MpcCore.permit(newFromBalance, from);
        MpcCore.permitThis(newToBalance);
        MpcCore.permit(newToBalance, to);
    }

    function _getGTAllowance(address tokenOwner, address spender) internal view returns (gtUint256) {
        PrivateERC20Wrapper256BaseStorage storage $ = _getPrivateERC20Wrapper256BaseStorage();
        if (gtUint256.unwrap($.allowances[tokenOwner][spender]) == 0) {
            return $.zero;
        }
        return $.allowances[tokenOwner][spender];
    }

    function _setApproveValue(address tokenOwner, address spender, gtUint256 value) internal virtual {
        PrivateERC20Wrapper256BaseStorage storage $ = _getPrivateERC20Wrapper256BaseStorage();
        $.allowances[tokenOwner][spender] = value;
        MpcCore.permitThis(value);
        MpcCore.permit(value, tokenOwner);
    }

    function _zeroGt() internal view returns (gtUint256) {
        return _getPrivateERC20Wrapper256BaseStorage().zero;
    }

    function _calculateBalanceIncrease(gtUint256 beforeBalance, gtUint256 afterBalance)
        internal
        returns (gtUint256)
    {
        (gtBool didIncrease, gtUint256 increaseCandidate) =
            MpcCore.checkedSubWithOverflowBit(afterBalance, beforeBalance);
        return MpcCore.mux(didIncrease, increaseCandidate, _zeroGt());
    }

    function _beforeShield(address account, uint256 amount) internal virtual {}

    function _afterShield(address account, uint256 amount) internal virtual {}

    function _beforeUnshield(address account, address recipient, uint256 amount) internal virtual {}

    function _afterUnshieldRequest(address account, address recipient, uint256 amount, gtUint256 amountHandle)
        internal
        virtual
    {}

    function _afterUnshield(uint256 decryptID, address recipient, uint256 amount) internal virtual {}

    function _effectivePrivateTransferAmount(address from, address to, gtUint256 amount)
        internal
        virtual
        returns (gtUint256)
    {
        from;
        to;
        return amount;
    }

    function _afterPrivateTransfer(address from, address to, gtUint256 amount, gtBool result) internal virtual {}

    function _beforePrivateApprove(address tokenOwner, address spender) internal virtual {}

    /// @notice Emits PrivateTransfer and grants both parties permission to decrypt the credited amount.
    function _permitAndEmitPrivateTransfer(address from, address to, gtUint256 amount, gtBool success) internal {
        _permitAndEmitPrivateTransfer(from, to, address(0), amount, success);
    }

    /// @notice Emits PrivateTransfer and grants decrypt permission to from, to, and an optional third party.
    function _permitAndEmitPrivateTransfer(
        address from,
        address to,
        address additionalPermittee,
        gtUint256 amount,
        gtBool success
    ) internal {
        gtUint256 transferredAmount = MpcCore.mux(success, amount, _zeroGt());
        MpcCore.permit(transferredAmount, to);
        MpcCore.permit(transferredAmount, from);
        if (additionalPermittee != address(0) && additionalPermittee != from && additionalPermittee != to) {
            MpcCore.permit(transferredAmount, additionalPermittee);
        }
        emit PrivateTransfer(from, to, transferredAmount);
    }
}
