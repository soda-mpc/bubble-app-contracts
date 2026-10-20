// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import "@sodalabs/bubble-core-contracts/contracts/bubble/MpcCore.sol";
import {PrivateERC20GaslessStorage, gaslessStorage} from "./PrivateERC20GaslessStorage.sol";
import {IPrivateERC20Gasless, OPRFToken} from "../interfaces/IPrivateERC20Gasless.sol";
import {PrivateLedger} from "./PrivateLedger.sol";

/// @title PrivateOPRFNotes
/// @notice All OPRF note issuance and spending for PrivateERC20Contract256Gasless. The token keeps the ERC20 side
///         (underlying pulls, private transfers) and calls `issueNote` once the backing is in the pool.
/// @dev Linked library: external functions run via DELEGATECALL in the token's context, so storage, `address(this)`,
///      MPC permissions (GC contracts see the token as caller) and emitted events all belong to the token.
///      Solidity's library call guard makes the state-changing functions revert when called directly.
///
///      `caller` is the token's `_msgSender()`: the direct caller, or the signer of a call relayed by the trusted
///      forwarder. Never `tx.origin`, so a contract the user calls cannot act with the user's authority. Only a
///      caller that is the IT owner may route note value elsewhere. New notes and remainders always go to the
///      IT owner, whoever calls.
///
///      Pool invariant: the token's own private balance (the pool) is at least the value of all live notes. Every
///      note is issued against value moved or shielded into the pool, and burning a note takes out at most its
///      value. So pool debits here (`_transferFromContract`, `debitIfSufficient`) always succeed, and the
///      "moves nothing" branches are defensive only. If they fired, the notes would already be burned and the
///      payout zero. Emergency recovery, which sweeps the backing, retires the token so no note operation runs
///      after it.
library PrivateOPRFNotes {
    // ---------------------------------------------------------------------------------------------
    // Entry points (called by the token)
    // ---------------------------------------------------------------------------------------------

    /// @dev Both notes go to the note owner, so anyone holding the ITs may split.
    function splitToken(
        itUint128 memory x,
        itUint256 memory q,
        uint128 y_clear,
        itUint256 memory qSplit
    ) external {
        address owner = _noteOwner(x, q, qSplit);

        (gtUint256 qRemainder, gtUint256 qPay) = _split(x, q, qSplit, y_clear, owner);

        (gtUint128 xrRemainder, gtUint128 yRemainder) = _issueNote(owner, qRemainder);
        (gtUint128 xrPay, gtUint128 yPay) = _issueNote(owner, qPay);

        emit IPrivateERC20Gasless.OPRFSplit(owner, xrRemainder, qRemainder, yRemainder, xrPay, qPay, yPay);
    }

    function splitTokenForRecipient(
        address caller,
        itUint128 memory x,
        itUint256 memory q,
        uint128 y_clear,
        itUint256 memory qSplit,
        address recipient
    ) external {
        address owner = _noteOwner(x, q, qSplit);
        _rejectBadRecipient(recipient);
        _requireDest(owner, caller, recipient);

        (gtUint256 qRemainder, gtUint256 qPay) = _split(x, q, qSplit, y_clear, owner);

        (gtUint128 xrRemainder, gtUint128 yRemainder) = _issueNote(owner, qRemainder);
        (gtUint128 xrPay, gtUint128 yPay) = _issueNote(recipient, qPay);

        emit IPrivateERC20Gasless.OPRFSplitForRecipient(owner, recipient, xrRemainder, qRemainder, yRemainder, xrPay, qPay, yPay);
    }

    function burnToken(
        address caller,
        itUint128 memory x,
        itUint256 memory q,
        uint128 y_clear,
        address recipient
    ) external {
        address owner = _noteOwner(x, q);
        _rejectBadRecipient(recipient);
        _requireDest(owner, caller, recipient);

        gtUint128 xGT = MpcCore.validateCiphertext(x);
        gtUint256 qGT = MpcCore.validateCiphertext(q);

        // If the OPRF token is invalid, burnedAmount will be 0
        gtUint256 burnedAmount = MpcCore.oprfBurn(gaslessStorage()._oprfKey, xGT, qGT, y_clear);
        MpcCore.permitThis(burnedAmount);

        _transferFromContract(recipient, burnedAmount);

        MpcCore.permit(burnedAmount, owner);

        emit IPrivateERC20Gasless.OPRFTokenInvalidated(owner, xGT, qGT, y_clear, 3); // 3=burned
        emit IPrivateERC20Gasless.OPRFBurned(owner, recipient, burnedAmount);
    }

    /// @dev The merged note goes to the note owner, so anyone holding the ITs may merge.
    function mergeMany(OPRFToken[] memory tokens) external returns (gtUint128 x, gtUint128 y, gtUint256 qMerged) {
        address owner = _tokensOwner(tokens);

        qMerged = _burnTokensAndAccumulate(tokens, owner);
        (x, y) = _issueNote(owner, qMerged);

        emit IPrivateERC20Gasless.OPRFMerged(owner, x, qMerged, y);
    }

    function transferOPRF(
        address caller,
        OPRFToken[] memory tokens,
        itUint256 memory amount,
        address recipient
    ) external returns (
        gtUint128 xRecipient,
        gtUint128 yRecipient,
        gtUint256 qRecipient,
        gtUint128 xSender,
        gtUint128 ySender,
        gtUint256 qSender
    ) {
        address owner = _spendCheck(tokens, amount, recipient, caller);

        (, qRecipient, qSender) = _spendAmounts(tokens, amount, owner);

        // The sender also sees how much it sent.
        MpcCore.permit(qRecipient, owner);
        emit IPrivateERC20Gasless.OPRFTransferred(owner, recipient, qRecipient);

        (xRecipient, yRecipient) = _issueNote(recipient, qRecipient);
        (xSender, ySender) = _issueNote(owner, qSender);
    }

    function redeemMany(
        address caller,
        OPRFToken[] memory tokens,
        itUint256 memory amount,
        address recipient
    ) external returns (gtUint128, gtUint128, gtUint256) {
        address owner = _spendCheck(tokens, amount, recipient, caller);

        (gtUint256 totalBurned, gtUint256 recipientAmount, gtUint256 senderRemainder) =
            _spendAmounts(tokens, amount, owner);

        _transferFromContract(recipient, recipientAmount);

        return _mintRemainder(owner, recipient, totalBurned, recipientAmount, senderRemainder);
    }

    /// @notice Burns notes and debits the redeemed amount from the pool for unshielding to `recipient`.
    /// @dev `amountToUnshield` is the handle the token must submit for decryption to pay `recipient` in underlying.
    ///      `recipient`'s private balance is never touched.
    function redeemManyToUnderlying(
        address caller,
        OPRFToken[] memory tokens,
        itUint256 memory amount,
        address recipient
    ) external returns (gtUint128 x, gtUint128 y, gtUint256 q, gtUint256 amountToUnshield) {
        address owner = _spendCheck(tokens, amount, recipient, caller);

        (gtUint256 totalBurned, gtUint256 recipientAmount, gtUint256 senderRemainder) =
            _spendAmounts(tokens, amount, owner);

        // Debits the full amount, or nothing if the pool cannot cover it.
        amountToUnshield = PrivateLedger.debitIfSufficient(address(this), recipientAmount);

        (x, y, q) = _mintRemainder(owner, recipient, totalBurned, recipientAmount, senderRemainder);
    }

    /// @notice Issues a note for `q` to `to`. The token calls this after it has moved or shielded the backing.
    function issueNote(address to, gtUint256 q) external returns (gtUint128 x, gtUint128 y) {
        return _issueNote(to, q);
    }

    // ---------------------------------------------------------------------------------------------
    // Authorization helpers
    // ---------------------------------------------------------------------------------------------

    /// @dev Zero strands the value. The token address makes `_transferFromContract` credit the pool twice,
    ///      because the pool is both the sender and the recipient of that transfer.
    function _rejectBadRecipient(address recipient) private view {
        require(recipient != address(0), "Recipient cannot be zero address");
        require(recipient != address(this), "Recipient cannot be token");
    }

    /// @dev Only the IT owner may choose where a note's value goes. Any other caller (a relayer, or a signer who is
    ///      not the owner) may only credit the owner.
    function _requireDest(address owner, address caller, address recipient) private pure {
        if (caller != owner) {
            require(recipient == owner, "Relayer dest must be IT owner");
        }
    }

    /// @dev Shared input checks for spend-style ops. Budget owner is `it.userAddress`; all OPRF/amount ITs must
    ///      agree so a relayer cannot mix signers. Returns the owner, who gets any remainder.
    function _spendCheck(
        OPRFToken[] memory tokens,
        itUint256 memory amount,
        address recipient,
        address caller
    ) private view returns (address owner) {
        _rejectBadRecipient(recipient);
        owner = _tokensOwner(tokens);
        require(amount.userAddress == owner, "OPRF IT user mismatch");
        _requireDest(owner, caller, recipient);
    }

    function _noteOwner(itUint128 memory x, itUint256 memory q) private pure returns (address owner) {
        owner = x.userAddress;
        require(owner != address(0), "OPRF owner cannot be zero");
        require(q.userAddress == owner, "OPRF IT user mismatch");
    }

    function _noteOwner(
        itUint128 memory x,
        itUint256 memory q,
        itUint256 memory extra
    ) private pure returns (address owner) {
        owner = _noteOwner(x, q);
        require(extra.userAddress == owner, "OPRF IT user mismatch");
    }

    function _tokensOwner(OPRFToken[] memory tokens) private pure returns (address owner) {
        require(tokens.length > 0, "At least one token required");
        owner = tokens[0].x.userAddress;
        require(owner != address(0), "OPRF owner cannot be zero");
        for (uint256 i = 0; i < tokens.length; ++i) {
            require(tokens[i].x.userAddress == owner && tokens[i].q.userAddress == owner, "OPRF IT user mismatch");
        }
    }

    // ---------------------------------------------------------------------------------------------
    // MPC helpers
    // ---------------------------------------------------------------------------------------------

    /// @dev Mints a note for `q` and lets `to` decrypt all of it. `q` must already be usable by the token.
    function _issueNote(address to, gtUint256 q) private returns (gtUint128 x, gtUint128 y) {
        (x, y) = MpcCore.oprfMint(gaslessStorage()._oprfKey, q);
        MpcCore.permit(x, to);
        MpcCore.permit(y, to);
        MpcCore.permit(q, to);
        emit IPrivateERC20Gasless.OPRFMinted(to, x, y, q);
    }

    /// @dev Burns the note and splits off `qSplit` (or nothing if it exceeds the note). The caller issues the notes.
    function _split(
        itUint128 memory x,
        itUint256 memory q,
        itUint256 memory qSplit,
        uint128 y_clear,
        address attributedUser
    ) private returns (gtUint256 qRemainder, gtUint256 qPay) {
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();
        gtUint128 xGT = MpcCore.validateCiphertext(x);
        gtUint256 qGT = MpcCore.validateCiphertext(q);
        gtUint256 qSplitGT = MpcCore.validateCiphertext(qSplit);

        // Burn the original token to validate it and get the burned amount
        gtUint256 qBurned = MpcCore.oprfBurn($._oprfKey, xGT, qGT, y_clear);
        MpcCore.permitThis(qBurned);

        // Use checked subtraction to avoid underflow when requested split exceeds burned amount.
        // If overflow occurs, keep full amount as remainder and set payment to zero.
        (gtBool overflowBit, gtUint256 qRemainderCandidate) = MpcCore.checkedSubWithOverflowBit(qBurned, qSplitGT);
        qRemainder = MpcCore.mux(overflowBit, qRemainderCandidate, qBurned);
        qPay = MpcCore.mux(overflowBit, qSplitGT, $.zero);
        MpcCore.permitThis(qRemainder);
        MpcCore.permitThis(qPay);

        emit IPrivateERC20Gasless.OPRFTokenInvalidated(attributedUser, xGT, qGT, y_clear, 1); // 1=split
    }

    function _burnTokensAndAccumulate(
        OPRFToken[] memory tokens,
        address attributedUser
    ) private returns (gtUint256 totalBurned) {
        PrivateERC20GaslessStorage.Layout storage $ = gaslessStorage();

        // MPC operations grant transient permission automatically
        totalBurned = $.zero;

        for (uint256 i = 0; i < tokens.length; i++) {
            gtUint128 xGT = MpcCore.validateCiphertext(tokens[i].x);
            gtUint256 qGT = MpcCore.validateCiphertext(tokens[i].q);

            gtUint256 burnedAmount = MpcCore.oprfBurn($._oprfKey, xGT, qGT, tokens[i].y_clear);
            totalBurned = MpcCore.add(totalBurned, burnedAmount);

            emit IPrivateERC20Gasless.OPRFTokenInvalidated(attributedUser, xGT, qGT, tokens[i].y_clear, 3); // 3=burned
            emit IPrivateERC20Gasless.OPRFBurned(attributedUser, address(this), burnedAmount);
        }
    }

    function _spendAmounts(
        OPRFToken[] memory tokens,
        itUint256 memory amount,
        address attributedUser
    ) private returns (
        gtUint256 totalBurned,
        gtUint256 spendAmount,
        gtUint256 remainderAmount
    ) {
        totalBurned = _burnTokensAndAccumulate(tokens, attributedUser);
        gtUint256 amountToTransfer = MpcCore.validateCiphertext(amount);
        (gtBool overflowBit, gtUint256 remainder) = MpcCore.checkedSubWithOverflowBit(totalBurned, amountToTransfer);

        spendAmount = MpcCore.mux(overflowBit, amountToTransfer, gaslessStorage().zero);
        remainderAmount = MpcCore.mux(overflowBit, remainder, totalBurned);
    }

    /// @dev Lets the owner read what was redeemed and burned, and issues the owner a note for the rest.
    function _mintRemainder(
        address owner,
        address recipient,
        gtUint256 totalBurned,
        gtUint256 recipientAmount,
        gtUint256 qRemainder
    ) private returns (
        gtUint128 xRemainder,
        gtUint128 yRemainder,
        gtUint256
    ) {
        MpcCore.permit(recipientAmount, owner);
        MpcCore.permit(totalBurned, owner);
        emit IPrivateERC20Gasless.OPRFRedeemed(owner, recipient, recipientAmount);

        (xRemainder, yRemainder) = _issueNote(owner, qRemainder);
        return (xRemainder, yRemainder, qRemainder);
    }

    // ---------------------------------------------------------------------------------------------
    // Balance helpers
    // ---------------------------------------------------------------------------------------------

    /// @notice Moves `amount` from the token's pooled balance to `recipient`.
    /// @dev Only the recipient (and the token) may decrypt the credited amount. The caller is deliberately not
    ///      permitted: on relayed calls it is not the note owner, who is permitted separately by the entry point.
    function _transferFromContract(address recipient, gtUint256 amount) private {
        gtUint256 credited = PrivateLedger.movedAmount(PrivateLedger.move(address(this), recipient, amount), amount);
        MpcCore.permit(credited, recipient);
        emit IPrivateERC20Gasless.PrivateTransfer(address(this), recipient, credited);
    }
}
