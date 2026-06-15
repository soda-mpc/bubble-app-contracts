// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;

import "@sodalabs/bubble-core-contracts/contracts/bubble/MpcCore.sol";
import "../erc3643/interfaces/IPrivateModularCompliance.sol";

contract MockPrivateModularCompliance is IPrivateModularCompliance {
    address private _tokenBound;
    bool private _transferAllowed = true;
    bool private _transferLimitEnabled;
    uint256 private _maxTransferAmount;
    gtUint256 private _zeroBalance;
    mapping(address => gtUint256) private _balances;
    mapping(address => uint256) private _createdBalances;
    mapping(address => uint256) private _maxBalances;
    mapping(address => bool) private _maxBalanceEnabled;

    event TransferAllowedSet(bool allowed);
    event MaxTransferAmountSet(uint256 maxTransferAmount);
    event MaxBalanceSet(address indexed wallet, uint256 maxBalance);
    event TransferredCalled(address indexed from, address indexed to, gtUint256 amount);
    event CreatedCalled(address indexed to, uint256 amount);
    event DestroyedCalled(address indexed from, uint256 amount);

    function setTransferAllowed(bool allowed) external {
        _transferAllowed = allowed;
        emit TransferAllowedSet(allowed);
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

    function transferLimitEnabled() external view returns (bool) {
        return _transferLimitEnabled;
    }

    function maxTransferAmount() external view returns (uint256) {
        return _maxTransferAmount;
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

    function maxBalance(address wallet) external view returns (uint256) {
        return _maxBalances[wallet];
    }

    function maxBalanceEnabled(address wallet) external view returns (bool) {
        return _maxBalanceEnabled[wallet];
    }

    function complianceBalanceOf(address wallet) external view returns (gtUint256) {
        return _balances[wallet];
    }

    function createdBalanceOf(address wallet) external view returns (uint256) {
        return _createdBalances[wallet];
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

    function created(address to, uint256 amount) external override {
        _balances[to] = MpcCore.add(_balanceOf(to), MpcCore.setPublic256(amount));
        _createdBalances[to] += amount;
        MpcCore.permitThis(_balances[to]);
        emit CreatedCalled(to, amount);
    }

    function destroyed(address from, uint256 amount) external override {
        (, gtUint256 newBalance) = MpcCore.checkedSubWithOverflowBit(_balanceOf(from), MpcCore.setPublic256(amount));
        _balances[from] = newBalance;
        if (_createdBalances[from] >= amount) {
            _createdBalances[from] -= amount;
        } else {
            _createdBalances[from] = 0;
        }
        MpcCore.permitThis(newBalance);
        emit DestroyedCalled(from, amount);
    }

    function canCreate(address to, uint256 amount) external view override returns (bool) {
        if (!_transferAllowed) {
            return false;
        }
        if (_transferLimitEnabled && amount > _maxTransferAmount) {
            return false;
        }
        if (!_maxBalanceEnabled[to]) {
            return true;
        }
        return _createdBalances[to] + amount <= _maxBalances[to];
    }

    function canTransfer(address, address to, gtUint256 amount) external override returns (gtBool) {
        gtBool allowedFlag = MpcCore.setPublic(_transferAllowed);
        gtBool maxBalanceAllows = MpcCore.setPublic(true);
        if (_maxBalanceEnabled[to]) {
            gtUint256 projectedBalance = MpcCore.add(_balanceOf(to), amount);
            maxBalanceAllows = MpcCore.le(projectedBalance, MpcCore.setPublic256(_maxBalances[to]));
        }

        allowedFlag = MpcCore.and(allowedFlag, maxBalanceAllows);
        if (!_transferLimitEnabled) {
            MpcCore.permitTransient(allowedFlag, msg.sender);
            return allowedFlag;
        }
        gtBool withinLimit = MpcCore.le(amount, MpcCore.setPublic256(_maxTransferAmount));
        gtBool result = MpcCore.and(allowedFlag, withinLimit);
        MpcCore.permitTransient(result, msg.sender);
        return result;
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
