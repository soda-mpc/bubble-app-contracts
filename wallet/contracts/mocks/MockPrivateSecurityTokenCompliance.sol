// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@sodalabs/bubble-core-contracts/contracts/bubble/MpcCore.sol";
import "../erc3643/interfaces/IPrivateSecurityTokenCompliance.sol";

contract MockPrivateSecurityTokenCompliance is IPrivateSecurityTokenCompliance {
    address private _tokenBound;
    bool private _transferAllowed = true;
    bool private _createAllowed = true;
    bool private _transferLimitEnabled;
    uint256 private _maxTransferAmount;
    gtUint256 private _zeroBalance;
    mapping(address => gtUint256) private _balances;
    mapping(address => uint256) private _maxBalances;
    mapping(address => bool) private _maxBalanceEnabled;

    event TransferAllowedSet(bool allowed);
    event CreateAllowedSet(bool allowed);
    event MaxTransferAmountSet(uint256 maxTransferAmount);
    event MaxBalanceSet(address indexed wallet, uint256 maxBalance);
    event TransferredCalled(address indexed from, address indexed to, gtUint256 amount);
    event CreatedCalled(address indexed to, gtUint256 amount);
    event DestroyedCalled(address indexed from, gtUint256 amount);

    function setTransferAllowed(bool allowed) external {
        _transferAllowed = allowed;
        emit TransferAllowedSet(allowed);
    }

    function setCreateAllowed(bool allowed) external {
        _createAllowed = allowed;
        emit CreateAllowedSet(allowed);
    }

    function setMaxTransferAmount(uint256 maxTransferAmount_) external {
        _transferLimitEnabled = true;
        _maxTransferAmount = maxTransferAmount_;
        emit MaxTransferAmountSet(maxTransferAmount_);
    }

    function clearMaxTransferAmount() external {
        _transferLimitEnabled = false;
        _maxTransferAmount = 0;
        emit MaxTransferAmountSet(0);
    }

    function setMaxBalance(address wallet, uint256 maxBalance_) external {
        _maxBalanceEnabled[wallet] = true;
        _maxBalances[wallet] = maxBalance_;
        emit MaxBalanceSet(wallet, maxBalance_);
    }

    function clearMaxBalance(address wallet) external {
        _maxBalanceEnabled[wallet] = false;
        _maxBalances[wallet] = 0;
        emit MaxBalanceSet(wallet, 0);
    }

    function complianceBalanceOf(address wallet) external view returns (gtUint256) {
        return _balances[wallet];
    }

    function bindToken(address token) external override {
        _tokenBound = token;
        if (gtUint256.unwrap(_zeroBalance) == 0) {
            _zeroBalance = MpcCore.setPublic256(0);
            MpcCore.permitThis(_zeroBalance);
        }
        emit TokenBound(token);
    }

    function unbindToken(address token) external override {
        if (_tokenBound == token) {
            _tokenBound = address(0);
        }
        emit TokenUnbound(token);
    }

    function transferred(address from, address to, gtUint256 amount) external override {
        (, gtUint256 newFromBalance) = MpcCore.checkedSubWithOverflowBit(_balanceOf(from), amount);
        _balances[from] = newFromBalance;
        _balances[to] = MpcCore.add(_balanceOf(to), amount);
        MpcCore.permitThis(_balances[from]);
        MpcCore.permitThis(_balances[to]);
        emit TransferredCalled(from, to, amount);
    }

    function created(address to, gtUint256 amount) external override {
        _balances[to] = MpcCore.add(_balanceOf(to), amount);
        MpcCore.permitThis(_balances[to]);
        emit CreatedCalled(to, amount);
    }

    function destroyed(address from, gtUint256 amount) external override {
        (, gtUint256 newBalance) = MpcCore.checkedSubWithOverflowBit(_balanceOf(from), amount);
        _balances[from] = newBalance;
        MpcCore.permitThis(newBalance);
        emit DestroyedCalled(from, amount);
    }

    function canCreate(address to, gtUint256 amount) external override returns (gtBool) {
        gtBool allowedFlag = MpcCore.setPublic(_createAllowed);
        if (_maxBalanceEnabled[to]) {
            gtUint256 projectedBalance = MpcCore.add(_balanceOf(to), amount);
            allowedFlag = MpcCore.and(allowedFlag, MpcCore.le(projectedBalance, MpcCore.setPublic256(_maxBalances[to])));
        }
        MpcCore.permitTransient(allowedFlag, msg.sender);
        return allowedFlag;
    }

    function canTransfer(address, address to, gtUint256 amount) external override returns (gtBool) {
        gtBool allowedFlag = MpcCore.setPublic(_transferAllowed);
        if (_maxBalanceEnabled[to]) {
            gtUint256 projectedBalance = MpcCore.add(_balanceOf(to), amount);
            allowedFlag = MpcCore.and(allowedFlag, MpcCore.le(projectedBalance, MpcCore.setPublic256(_maxBalances[to])));
        }
        if (_transferLimitEnabled) {
            allowedFlag = MpcCore.and(allowedFlag, MpcCore.le(amount, MpcCore.setPublic256(_maxTransferAmount)));
        }
        MpcCore.permitTransient(allowedFlag, msg.sender);
        return allowedFlag;
    }

    function getTokenBound() external view override returns (address) {
        return _tokenBound;
    }

    function _balanceOf(address wallet) internal returns (gtUint256) {
        if (gtUint256.unwrap(_balances[wallet]) == 0) {
            return _zero();
        }
        return _balances[wallet];
    }

    function _zero() internal returns (gtUint256) {
        if (gtUint256.unwrap(_zeroBalance) == 0) {
            _zeroBalance = MpcCore.setPublic256(0);
            MpcCore.permitThis(_zeroBalance);
        }
        return _zeroBalance;
    }
}
