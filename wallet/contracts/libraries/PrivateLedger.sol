// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import "@sodalabs/bubble-core-contracts/contracts/bubble/MpcCore.sol";
import {PrivateERC20GaslessStorage, gaslessStorage} from "./PrivateERC20GaslessStorage.sol";

/// @title PrivateLedger
/// @notice Encrypted balance and allowance bookkeeping shared by PrivateERC20Contract256Gasless and PrivateOPRFNotes.
/// @dev Internal library: compiled into each caller, so it runs in the token's context either way.
///      Every write stores the handle and permits the token plus the account that owns it.
library PrivateLedger {
    // ---------------------------------------------------------------------------------------------
    // Balances
    // ---------------------------------------------------------------------------------------------

    /// @notice Balance handle of `account`, or the stored zero handle if it was never set.
    function balanceOf(address account) internal view returns (gtUint256 balance) {
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        balance = $.balances[account];
        if (gtUint256.unwrap(balance) == 0) {
            balance = $.zero;
        }
    }

    function setBalance(address account, gtUint256 balance) internal {
        gaslessStorage().balances[account] = balance;
        MpcCore.permitThis(balance);
        if (account != address(this)) {
            MpcCore.permit(balance, account);
        }
    }

    /// @notice Adds `amount` to `account` (shield paths, where the amount is backed by pulled underlying).
    function credit(address account, gtUint256 amount) internal {
        setBalance(account, MpcCore.add(balanceOf(account), amount));
    }

    // Self-transfers follow OpenZeppelin ERC20: they succeed only if the balance covers `amount`, and a
    // self-transferFrom also needs and spends the allowance. Nothing else changes, since the balance is both sides.

    /// @notice Moves `amount` from `from` to `to`. Moves nothing when `from` cannot cover it.
    function move(address from, address to, gtUint256 amount) internal returns (gtBool ok) {
        if (from == to) {
            return MpcCore.ge(balanceOf(from), amount);
        }
        gtUint256 newFrom;
        gtUint256 newTo;
        (newFrom, newTo, ok) = MpcCore.transfer(balanceOf(from), balanceOf(to), amount);
        _setPair(from, to, newFrom, newTo);
    }

    /// @dev Clear-amount variant. Cheaper than converting `amount` with `setPublic256` first.
    function move(address from, address to, uint256 amount) internal returns (gtBool ok) {
        if (from == to) {
            return MpcCore.ge(balanceOf(from), amount);
        }
        gtUint256 newFrom;
        gtUint256 newTo;
        (newFrom, newTo, ok) = MpcCore.transfer(balanceOf(from), balanceOf(to), amount);
        _setPair(from, to, newFrom, newTo);
    }

    /// @notice Moves `amount` from `from` to `to` against `spender`'s allowance. Moves nothing when either
    ///         the balance or the allowance cannot cover it.
    function moveWithAllowance(address spender, address from, address to, gtUint256 amount)
        internal
        returns (gtBool ok)
    {
        if (from == to) {
            return _selfMoveWithAllowance(spender, from, amount);
        }
        gtUint256 newFrom;
        gtUint256 newTo;
        gtUint256 newAllowance;
        (newFrom, newTo, ok, newAllowance) =
            MpcCore.transferWithAllowance(balanceOf(from), balanceOf(to), amount, allowanceOf(from, spender));
        setAllowance(from, spender, newAllowance);
        _setPair(from, to, newFrom, newTo);
    }

    /// @dev Clear-amount variant. Cheaper than converting `amount` with `setPublic256` first.
    function moveWithAllowance(address spender, address from, address to, uint256 amount)
        internal
        returns (gtBool ok)
    {
        if (from == to) {
            return _selfMoveWithAllowance(spender, from, MpcCore.setPublic256(amount));
        }
        gtUint256 newFrom;
        gtUint256 newTo;
        gtUint256 newAllowance;
        (newFrom, newTo, ok, newAllowance) =
            MpcCore.transferWithAllowance(balanceOf(from), balanceOf(to), amount, allowanceOf(from, spender));
        setAllowance(from, spender, newAllowance);
        _setPair(from, to, newFrom, newTo);
    }

    /// @notice Debits `amount` from `account` if the balance covers it, otherwise nothing. Returns what was debited.
    /// @dev balance = 10, amount = 3: new balance 7, debited 3.
    ///      balance = 5, amount = 7: the subtraction overflows, so the balance stays 5 and debited is 0.
    function debitIfSufficient(address account, gtUint256 amount) internal returns (gtUint256 debited) {
        gtUint256 balanceBefore = balanceOf(account);
        (gtBool overflow, gtUint256 difference) = MpcCore.checkedSubWithOverflowBit(balanceBefore, amount);
        // mux(bit, a, b) returns b when bit is true: on overflow keep the balance and debit nothing.
        gtUint256 balanceAfter = MpcCore.mux(overflow, difference, balanceBefore);
        debited = MpcCore.mux(overflow, amount, gaslessStorage().zero);
        MpcCore.permitThis(debited);
        setBalance(account, balanceAfter);
    }

    /// @dev Self-transferFrom: succeeds if both the balance and `spender`'s allowance cover `amount`, and then
    ///      spends the allowance. `sub` is only kept when it cannot underflow.
    function _selfMoveWithAllowance(address spender, address account, gtUint256 amount) private returns (gtBool ok) {
        gtUint256 allowance = allowanceOf(account, spender);
        ok = MpcCore.and(MpcCore.ge(balanceOf(account), amount), MpcCore.ge(allowance, amount));
        // mux(bit, a, b) returns b when bit is true.
        setAllowance(account, spender, MpcCore.mux(ok, allowance, MpcCore.sub(allowance, amount)));
    }

    /// @dev Writes both sides of a move. `from == to` would overwrite the debit with the credit and mint
    ///      `amount`; the move functions return early for self-transfers, so this guard should never fire.
    function _setPair(address from, address to, gtUint256 newFrom, gtUint256 newTo) private {
        require(from != to, "Ledger self-move");
        setBalance(from, newFrom);
        setBalance(to, newTo);
    }

    // ---------------------------------------------------------------------------------------------
    // Allowances
    // ---------------------------------------------------------------------------------------------

    /// @notice Allowance handle, or the stored zero handle if it was never set.
    function allowanceOf(address owner, address spender) internal view returns (gtUint256 value) {
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        value = $.allowances[owner][spender];
        if (gtUint256.unwrap(value) == 0) {
            value = $.zero;
        }
    }

    function setAllowance(address owner, address spender, gtUint256 value) internal {
        gaslessStorage().allowances[owner][spender] = value;
        MpcCore.permitThis(value);
        MpcCore.permit(value, owner);
    }
}
