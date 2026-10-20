# Transient insert grant

> Design record for the transient insert grant. The token consumes it in `consumeInsertGrant`, called by the
> forwarder right before a relayed operation.

## Problem

An agent spends an anonymous OPRF note through a facilitator who pays gas. Redeem, unshield, and the merchant EIP-3009 payment can all be relayed. Inserting the note cannot.

`GCHandler.ValidateCiphertext` allows the call when `tx.origin == it.userAddress`. When the facilitator is `tx.origin`, it requires `GCACL.isFullInsertPermitted(userAddress, msg.sender)`. In that check `msg.sender` is the app contract (PrivateERC20), because the token calls the handler.

The only writer of that mapping today is `permitFullInsertAccess(permittee, expiration)`, and it stores `permitter = msg.sender`. The agent must send that transaction and pay gas. Funding the agent with ETH also creates an address edge the anonymous handoff is trying to avoid.

One redeem calls `MpcCore.validateCiphertext` several times (`x` and `q` per note, plus splits). All of those calls in the facilitator’s transaction need to succeed. The permission should cover that transaction and then disappear.

## Options considered

### Verify the signature inside PrivateERC20

The token would check the user’s signature and then call `validateCiphertext`.

This was rejected as too dangerous. Insert permission is a system check. Every `validateCiphertext` already goes through the handler. If the handler trusts the calling token, each app contract becomes the ACL. A bug, a bad upgrade, or a malicious contract can insert ciphertexts for a user who never granted that contract.

### Sign each ciphertext separately

The user signs `x`, `q`, and each other parameter on its own. The handler checks that signature on the matching `validateCiphertext`.

This was rejected. One redeem already validates several ciphertexts, and `redeemMany` validates several notes. The wallet would ask for a signature per parameter.

### Deadline on the grant

EIP-3009-style `validBefore` was considered so an unused signature would expire.

It was left out. A late submitter cannot redirect the tokens. The destination lock pays the agent, so the signature can only delay or force the agent’s own cash-out. That is an accepted outcome.

## What shipped

The user signs one authorization for one contract. The forwarder calls `consumeInsertGrant`, which calls `MpcCore.transientInsertPermission`. The token and `PrivateOPRFNotes` then call the existing `MpcCore.validateCiphertext`.

The pinned `bubble-core-contracts` commit (`c2adb88`) has no `verifyCiphertextTransient`. `GCHandler.ValidateCiphertext` accepts the transient bit. For the rest of that transaction, every `validateCiphertext` sees the grant, including paths that are not the relayed note operation.

The token still refuses a ciphertext whose `userAddress` is not the signer, and the note destination lock still pays the IT owner unless that owner authorized another recipient. A facilitator who holds the grant can grief (force the owner's own cash-out) and cannot redirect the value or take decrypt permission.

## Chosen option

The user signs one authorization for one contract. PrivateERC20 calls `GCACL.transientInsertPermission`, then validates ciphertexts with `MpcCore.validateCiphertext`, which honours the transient bit for the rest of the transaction.

The signature is EIP-712, with `chainId` and `verifyingContract` in the domain. The signed fields are:

- `nonce` — incrementing integer
- `user` — the account whose ciphertexts may be inserted
- `contract` — the only contract that may use the grant. For this flow that contract is PrivateERC20. The signed `verifyingContract` of the insert grant is GCACL, not the token and not the forwarder.

The nonce is stored in a separate contract controlled by Soda. It is persistent storage. Transient storage would forget the nonce at the end of the transaction and the same signature could be replayed.

PrivateERC20 does not check the signature. On the relayed redeem, burn, or split it does two things:

1. Call `GCACL.transientInsertPermission(user, nonce, signature)`. GCACL recovers the signer, requires it to be `user`, consumes the nonce, and sets one transient bit (EIP-1153) keyed by `(user, msg.sender)`. `msg.sender` is PrivateERC20, and the signed `contract` must be that address. The bit clears itself at the end of the transaction. This function does not write `isFullInsertPermitted`.
2. Call `MpcCore.validateCiphertext(it)` for each ciphertext (`x`, `q`, and any splits). The handler accepts the call when the transient bit for `(it.userAddress, msg.sender)` is set, or when `tx.origin` is the user, or when a persistent insert grant exists. A grant for Alice does not authorize Bob’s ciphertext. The bit stays set for the whole transaction, so every `validateCiphertext` in that transaction sees it.

`permitFullInsertAccess` stays for a user who submits it directly. This grant is separate from `MpcCore.permitTransient`, which permits a handle after validation.

The signature does not name the note or the calldata. Whoever broadcasts it may attach any of that user’s ciphertexts, once, in one transaction, and only through the signed contract. Possession of the note remains the spend authority. `transientInsertPermission` and the `validateCiphertext` calls happen in the same token call. A grant in an earlier transaction is already gone.

## Implementation

1. Confirm that the handler reads GCACL by a call during the transaction. The transient flag is visible to `validateCiphertext` only that way. If the handler reads state from before the transaction, the flag is invisible and this design does not work.
2. Add a Soda-controlled nonce contract. It stores the next nonce per user, accepts only that nonce, and increments it when the grant is consumed. The increment happens inside the token call, so a reverted redeem rolls the nonce back too.
3. Add `GCACL.transientInsertPermission(user, nonce, signature)`, which PrivateERC20 calls:
   - rebuilds the EIP-712 digest for `(nonce, user, contract)`
   - recovers the signer and requires it to be `user` (EIP-1271 if the user can be a contract)
   - requires `contract == msg.sender`
   - consumes `nonce` on the Soda nonce contract
   - sets the transient insert bit for `(user, msg.sender)`
   - rejects a zero `user` or `contract`
   - does not write `isFullInsertPermitted`
4. Teach `GCHandler.ValidateCiphertext` to accept `GCACL.isTransientInsertPermitted(it.userAddress, msg.sender)`. Leave the bit set so one redeem can validate `x`, `q`, and any splits. Do not add a second entry point.
5. The forwarder takes the insert signature beside `executeWithAuthorization` and calls `consumeInsertGrant` once before the user operation. Direct user calls, where `tx.origin` is the user, keep working without a grant.
6. Pass the authorization inside the relayed token call (`executeWithAuthorization` → redeem / burn / split). Do not catch a failure and continue. The grant would already be live for whatever runs next in that transaction. A grant for the token does not cover a compliance module or vault that calls the precompile itself; that caller would need its own signature and its own `validateCiphertext` calls after its own `transientInsertPermission`.
7. Test the facilitator path on Arbitrum Sepolia: signature from the agent, gas from the facilitator, several `validateCiphertext` calls succeeding in that token call, the same ciphertexts failing through `validateCiphertext` without the transient grant or `permitFullInsertAccess`, a second transaction with the same signature failing, and a ciphertext whose `userAddress` is not the signer failing.

