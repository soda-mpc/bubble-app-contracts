// SPDX-License-Identifier: MIT
pragma solidity ^0.8.26;
import "@sodalabs/bubble-core-contracts/contracts/bubble/MpcCore.sol";
import {
    PrivateERC20Contract256Storage,
    OPRFToken,
    privateERC20Storage,
    privateBalanceOf
} from "./PrivateERC20GaslessStorage.sol";

/// @title PrivateOPRFNotes
/// @notice OPRF note logic for PrivateERC20Contract256Gasless, split out to keep the token under the 24 KB limit.
/// @dev Linked library: external functions run via DELEGATECALL in the token's context, so storage, `address(this)`,
///      MPC permissions (GC contracts see the token as caller) and emitted events all belong to the token.
///      Solidity's library call guard makes the state-changing functions revert when called directly.
///
///      `sender` is the account credited with the operation; `authorizer` is who chose the arguments:
///      `tx.origin` on a direct call (the owner EOA, also when executing through its Safe), or the signer on a call
///      relayed by the trusted forwarder. Only an authorizer equal to the IT owner may route note value elsewhere.
library PrivateOPRFNotes {
    // Mirrors of the token's events, so logs emitted here decode against the token ABI.
    event PrivateTransfer(address indexed from, address indexed to, gtUint256 amount);
    event OPRFMinted(address indexed user, gtUint128 x, gtUint128 y, gtUint256 q);
    event OPRFSplit(address indexed user, gtUint128 xrRemainder, gtUint256 qRemainder, gtUint128 yRemainder, gtUint128 xrPay, gtUint256 qPay, gtUint128 yPay);
    event OPRFSplitForRecipient(address indexed user, address indexed recipient, gtUint128 xrRemainder, gtUint256 qRemainder, gtUint128 yRemainder, gtUint128 xrPay, gtUint256 qPay, gtUint128 yPay);
    event OPRFMerged(address indexed user, gtUint128 xrMerged, gtUint256 qMerged, gtUint128 yMerged);
    event OPRFTransferred(address indexed sender, address indexed recipient, gtUint256 amount);
    event OPRFBurned(address indexed user, address indexed recipient, gtUint256 burnedAmount);
    // Reason codes: 1=split, 2=merged, 3=burned
    event OPRFTokenInvalidated(address indexed user, gtUint128 x, gtUint256 q, uint128 y, uint8 reason);

    // ---------------------------------------------------------------------------------------------
    // Entry points (called by the token)
    // ---------------------------------------------------------------------------------------------

    function splitToken(
        address sender,
        address authorizer,
        itUint128 memory x,
        itUint256 memory q,
        uint128 y_clear,
        itUint256 memory qSplit
    ) external {
        address creditTo = _creditTo(_noteOwner(x, q, qSplit), sender, authorizer);

        (gtUint128 xrRemainder, gtUint128 yRemainder, gtUint256 qRemainder, gtUint128 xrPay, gtUint256 qPay, gtUint128 yPay) =
            _split(x, q, qSplit, y_clear, creditTo);

        // Permit the note owner (or Safe, when the owner executes) to decrypt the results
        MpcCore.permit(xrRemainder, creditTo);
        MpcCore.permit(qRemainder, creditTo);
        MpcCore.permit(yRemainder, creditTo);
        MpcCore.permit(xrPay, creditTo);
        MpcCore.permit(qPay, creditTo);
        MpcCore.permit(yPay, creditTo);

        emit OPRFSplit(creditTo, xrRemainder, qRemainder, yRemainder, xrPay, qPay, yPay);
        emit OPRFMinted(creditTo, xrRemainder, yRemainder, qRemainder);
        emit OPRFMinted(creditTo, xrPay, yPay, qPay);
    }

    function splitTokenForRecipient(
        address sender,
        address authorizer,
        itUint128 memory x,
        itUint256 memory q,
        uint128 y_clear,
        itUint256 memory qSplit,
        address recipient
    ) external {
        address owner = _noteOwner(x, q, qSplit);
        _requireDest(owner, authorizer, recipient);
        address creditTo = _creditTo(owner, sender, authorizer);

        (gtUint128 xrRemainder, gtUint128 yRemainder, gtUint256 qRemainder, gtUint128 xrPay, gtUint256 qPay, gtUint128 yPay) =
            _split(x, q, qSplit, y_clear, creditTo);

        MpcCore.permit(xrRemainder, creditTo);
        MpcCore.permit(qRemainder, creditTo);
        MpcCore.permit(yRemainder, creditTo);

        MpcCore.permit(xrPay, recipient);
        MpcCore.permit(qPay, recipient);
        MpcCore.permit(yPay, recipient);

        emit OPRFMinted(creditTo, xrRemainder, yRemainder, qRemainder);
        emit OPRFMinted(recipient, xrPay, yPay, qPay);
        emit OPRFSplitForRecipient(creditTo, recipient, xrRemainder, qRemainder, yRemainder, xrPay, qPay, yPay);
    }

    function burnToken(
        address sender,
        address authorizer,
        itUint128 memory x,
        itUint256 memory q,
        uint128 y_clear,
        address recipient
    ) external {
        address owner = _noteOwner(x, q);
        _requireDest(owner, authorizer, recipient);
        address creditTo = _creditTo(owner, sender, authorizer);

        gtUint128 xGT = MpcCore.validateCiphertext(x);
        gtUint256 qGT = MpcCore.validateCiphertext(q);

        // If the OPRF token is invalid, burnedAmount will be 0
        gtUint256 burnedAmount = MpcCore.oprfBurn(privateERC20Storage()._oprfKey, xGT, qGT, y_clear);
        MpcCore.permitThis(burnedAmount);

        _transferFromContract(recipient, burnedAmount);

        MpcCore.permit(burnedAmount, creditTo);

        emit OPRFTokenInvalidated(creditTo, xGT, qGT, y_clear, 3); // 3=burned
        emit OPRFBurned(creditTo, recipient, burnedAmount);
    }

    function mergeMany(
        address sender,
        address authorizer,
        OPRFToken[] memory tokens
    ) external returns (gtUint128 x, gtUint128 y, gtUint256 qMerged) {
        address creditTo = _creditTo(_tokensOwner(tokens), sender, authorizer);

        qMerged = _burnTokensAndAccumulate(tokens, creditTo);
        (x, y) = MpcCore.oprfMint(privateERC20Storage()._oprfKey, qMerged);

        MpcCore.permit(x, creditTo);
        MpcCore.permit(y, creditTo);
        MpcCore.permit(qMerged, creditTo);

        emit OPRFMinted(creditTo, x, y, qMerged);
        emit OPRFMerged(creditTo, x, qMerged, y);
    }

    function transferOPRF(
        address sender,
        address authorizer,
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
        gtUint128 oprfKey = privateERC20Storage()._oprfKey;
        address creditTo = _spendCheck(tokens, amount, recipient, sender, authorizer);

        (, qRecipient, qSender) = _spendAmounts(tokens, amount, creditTo);

        (xRecipient, yRecipient) = MpcCore.oprfMint(oprfKey, qRecipient);
        (xSender, ySender) = MpcCore.oprfMint(oprfKey, qSender);

        MpcCore.permit(xRecipient, recipient);
        MpcCore.permit(yRecipient, recipient);
        MpcCore.permit(qRecipient, recipient);
        MpcCore.permit(qRecipient, creditTo);

        MpcCore.permit(xSender, creditTo);
        MpcCore.permit(ySender, creditTo);
        MpcCore.permit(qSender, creditTo);

        emit OPRFTransferred(creditTo, recipient, qRecipient);
        emit OPRFMinted(recipient, xRecipient, yRecipient, qRecipient);
        emit OPRFMinted(creditTo, xSender, ySender, qSender);
    }

    function redeemMany(
        address sender,
        address authorizer,
        OPRFToken[] memory tokens,
        itUint256 memory amount,
        address recipient
    ) external returns (gtUint128, gtUint128, gtUint256) {
        address creditTo = _spendCheck(tokens, amount, recipient, sender, authorizer);

        (gtUint256 totalBurned, gtUint256 recipientAmount, gtUint256 senderRemainder) =
            _spendAmounts(tokens, amount, creditTo);

        _transferFromContract(recipient, recipientAmount);

        return _mintRemainder(creditTo, recipient, totalBurned, recipientAmount, senderRemainder);
    }

    /// @notice Burns notes, credits `recipient` with the redeemed amount and immediately debits it again.
    /// @dev `amountToUnshield` is the handle the token must submit for decryption to pay `recipient` in underlying.
    function redeemManyToUnderlying(
        address sender,
        address authorizer,
        OPRFToken[] memory tokens,
        itUint256 memory amount,
        address recipient
    ) external returns (gtUint128 x, gtUint128 y, gtUint256 q, gtUint256 amountToUnshield) {
        address creditTo = _spendCheck(tokens, amount, recipient, sender, authorizer);

        (gtUint256 totalBurned, gtUint256 recipientAmount, gtUint256 senderRemainder) =
            _spendAmounts(tokens, amount, creditTo);

        _transferFromContract(recipient, recipientAmount);
        amountToUnshield = _debitBalanceForUnshield(recipient, recipientAmount);

        (x, y, q) = _mintRemainder(creditTo, recipient, totalBurned, recipientAmount, senderRemainder);
    }

    // ---------------------------------------------------------------------------------------------
    // Authorization helpers
    // ---------------------------------------------------------------------------------------------

    /// @dev Only the IT owner may choose where a note's value goes. Anyone else (a relayer, or a signer who is not
    ///      the owner) may only credit the owner.
    function _requireDest(address owner, address authorizer, address recipient) private pure {
        if (authorizer != owner) {
            require(recipient == owner, "Relayer dest must be IT owner");
        }
    }

    /// @dev Remainder credit: when the owner authorized the call, credit the sender (the owner itself, or its Safe on
    ///      a direct Safe exec). Otherwise credit the IT owner.
    function _creditTo(address owner, address sender, address authorizer) private pure returns (address) {
        return authorizer == owner ? sender : owner;
    }

    /// @dev Shared input checks for spend-style ops. Budget owner is `it.userAddress`; all OPRF/amount ITs must
    ///      agree so a relayer cannot mix signers. Returns the remainder credit address.
    function _spendCheck(
        OPRFToken[] memory tokens,
        itUint256 memory amount,
        address recipient,
        address sender,
        address authorizer
    ) private pure returns (address) {
        require(recipient != address(0), "Recipient cannot be zero address");
        address owner = _tokensOwner(tokens);
        require(amount.userAddress == owner, "OPRF IT user mismatch");
        _requireDest(owner, authorizer, recipient);
        return _creditTo(owner, sender, authorizer);
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

    /// @dev Burns the note, splits off `qSplit` (or nothing if it exceeds the note) and mints remainder + payment.
    function _split(
        itUint128 memory x,
        itUint256 memory q,
        itUint256 memory qSplit,
        uint128 y_clear,
        address attributedUser
    ) private returns (
        gtUint128 xrRemainder,
        gtUint128 yRemainder,
        gtUint256 qRemainder,
        gtUint128 xrPay,
        gtUint256 qPay,
        gtUint128 yPay
    ) {
        PrivateERC20Contract256Storage storage $ = privateERC20Storage();
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

        (xrRemainder, yRemainder) = MpcCore.oprfMint($._oprfKey, qRemainder);
        (xrPay, yPay) = MpcCore.oprfMint($._oprfKey, qPay);

        emit OPRFTokenInvalidated(attributedUser, xGT, qGT, y_clear, 1); // 1=split
    }

    function _burnTokensAndAccumulate(
        OPRFToken[] memory tokens,
        address attributedUser
    ) private returns (gtUint256 totalBurned) {
        PrivateERC20Contract256Storage storage $ = privateERC20Storage();

        // MPC operations grant transient permission automatically
        totalBurned = $.zero;

        for (uint256 i = 0; i < tokens.length; i++) {
            gtUint128 xGT = MpcCore.validateCiphertext(tokens[i].x);
            gtUint256 qGT = MpcCore.validateCiphertext(tokens[i].q);

            gtUint256 burnedAmount = MpcCore.oprfBurn($._oprfKey, xGT, qGT, tokens[i].y_clear);
            totalBurned = MpcCore.add(totalBurned, burnedAmount);

            emit OPRFTokenInvalidated(attributedUser, xGT, qGT, tokens[i].y_clear, 3); // 3=burned
            emit OPRFBurned(attributedUser, address(this), burnedAmount);
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

        spendAmount = MpcCore.mux(overflowBit, amountToTransfer, privateERC20Storage().zero);
        remainderAmount = MpcCore.mux(overflowBit, remainder, totalBurned);
    }

    function _mintRemainder(
        address creditTo,
        address recipient,
        gtUint256 totalBurned,
        gtUint256 recipientAmount,
        gtUint256 senderRemainder
    ) private returns (
        gtUint128 xRemainder,
        gtUint128 yRemainder,
        gtUint256 qRemainder
    ) {
        (xRemainder, yRemainder) = MpcCore.oprfMint(privateERC20Storage()._oprfKey, senderRemainder);

        MpcCore.permit(xRemainder, creditTo);
        MpcCore.permit(yRemainder, creditTo);
        MpcCore.permit(senderRemainder, creditTo);
        MpcCore.permit(recipientAmount, creditTo);
        MpcCore.permit(totalBurned, creditTo);

        qRemainder = senderRemainder;

        emit OPRFBurned(creditTo, recipient, totalBurned);
        emit OPRFMinted(creditTo, xRemainder, yRemainder, qRemainder);
    }

    // ---------------------------------------------------------------------------------------------
    // Balance helpers (same semantics as the token's own)
    // ---------------------------------------------------------------------------------------------

    /// @notice Moves `amount` from the token's pooled balance to `recipient`.
    /// @dev Only the recipient (and the token) may decrypt the credited amount. The caller is deliberately not
    ///      permitted: on relayed calls it is not the note owner, who is permitted separately by the entry point.
    function _transferFromContract(address recipient, gtUint256 amount) private {
        PrivateERC20Contract256Storage storage $ = privateERC20Storage();
        (gtUint256 newFromBalance, gtUint256 newToBalance, gtBool result) =
            MpcCore.transfer(privateBalanceOf(address(this)), privateBalanceOf(recipient), amount);

        $.balances[address(this)] = newFromBalance;
        $.balances[recipient] = newToBalance;
        MpcCore.permitThis(newFromBalance);
        MpcCore.permit(newFromBalance, address(this));
        MpcCore.permitThis(newToBalance);
        MpcCore.permit(newToBalance, recipient);

        // `amount` is masked to zero when the transfer did not credit it.
        gtUint256 transferredAmount = MpcCore.mux(MpcCore.not(result), amount, $.zero);
        MpcCore.permit(transferredAmount, recipient);
        MpcCore.permit(transferredAmount, address(this));
        emit PrivateTransfer(address(this), recipient, transferredAmount);
    }

    /// @notice Debits up to `amount` from `account`; returns the handle of what was actually debited.
    function _debitBalanceForUnshield(address account, gtUint256 amount) private returns (gtUint256 amountToUnshieldGt) {
        gtUint256 balanceBefore = privateBalanceOf(account);
        (, gtUint256 balanceAfter) = MpcCore.checkedSubWithOverflowBit(balanceBefore, amount);
        (, amountToUnshieldGt) = MpcCore.checkedSubWithOverflowBit(balanceBefore, balanceAfter);

        MpcCore.permitThis(amountToUnshieldGt);
        MpcCore.permitThis(balanceAfter);
        MpcCore.permit(balanceAfter, account);
        privateERC20Storage().balances[account] = balanceAfter;
    }
}
