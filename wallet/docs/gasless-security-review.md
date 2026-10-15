# PrivateERC20Contract256Gasless: security review and redesign

Branch: `shield-and-mint` · Network used for verification: Arbitrum Sepolia (421614)

## TL;DR

- The pre-staging review of the gasless token found **two critical bugs** in the gasless path (C1, C2) and later **one high-severity privacy leak** (C3). All three were reproduced on Arbitrum Sepolia before being fixed.
- The gasless path was redesigned: the token no longer calls itself. A separate **ERC-2771 forwarder** verifies the user's EIP-712 signature and relays the call; OPRF note logic moved into a **linked library** to stay under the 24 KB contract size limit.
- 49 tests pass on Arbitrum Sepolia, including a regression test for every finding (28 security, 17 gasless and original-contract, 4 Safe facilitator).

## 1. Findings

### C1 (Critical): anyone could get decrypt permission on any stored handle

The old `executeWithAuthorization` ran the user's `data` through `address(this).call(data)`. Inside that call `msg.sender` was the token itself. `contractApprove`, `contractTransfer` and `contractTransferFrom` guarded raw handles with `MpcCore.isSenderPermitted(h)`, which reads `msg.sender`, so the check became "is the token permitted on `h`?".

The token must hold persistent `permitThis` on every handle it stores (all balances, allowances, its pooled balance, `zero`, the OPRF key), because it computes on them in later transactions. So the check always passed, and `contractApprove` then permitted the handle to the signer.

**Reproduced:** an attacker signed `contractApprove(attacker, H)` for itself and **decrypted the victim's balance and the OPRF key**. The key handle was read straight from storage with `eth_getStorageAt`.

### C2 (Critical): relayer could bypass the OPRF destination lock

In an authorized call, `_requireOprfRelayerDest` returned early without checking that the note owner was the signer. Unsigned relay requires the owner to grant the token full insert access, so anyone holding the owner's note ciphertexts could sign an authorization as themselves and burn the note to themselves.

**Reproduced:** the attacker's private balance went from 0 to the full note amount.

### C3 (High): ciphertext owner not tied to the caller

`transfer(it)`, `transferFrom(it)`, `approve(it)` and `mintOPRFToken(it)` never checked that `it.userAddress` is the caller. While a user's insert grant to the token is active (routine in the relay and Safe facilitator flows, which use 365-day grants), anyone could replay that user's public ciphertext via `approve(attacker, it)` and decrypt it through their own allowance.

**Reproduced** on the refactored contract during the second review: the attacker decrypted the owner's secret value. `PrivateERC20Contract256` now has the same check (`msg.sender` or `tx.origin`). The wrapper and ERC-3643 token still copy the old entry points.

### Medium and low findings

| ID | Finding | Resolution |
|---|---|---|
| M1 | The caller of burn/redeem was permitted on the transferred amount, so a relayer learned note values | Third-party permit removed |
| M2 | Anyone holding a user's note ciphertexts (with insert access) can force-spend the notes; value still returns to the owner | Inherent to unsigned relay; documented |
| H (old) | Owner/admin functions could be executed from a signature over opaque `bytes data`, which invites phishing | Admin functions now ignore the forwarder |
| L | Self-transfers emitted an inverted amount (zero on success) | Fixed |
| L | No way to cancel a signed authorization | `cancelAuthorization(nonce)` added (EIP-3009 style) |
| L | `setTrustedForwarder` accepted the token's own address | Rejected |
| L | `tx.origin` as authorizer on direct calls (Safe support) is a phishing class | Accepted. Same arm on value ITs. Closed for facilitator relays |
| Info | OPRF double-spend protection is off-chain (sequencer nullifiers), not in the contract | Noted as trust assumption |

## 2. Approach and reasoning

### Step 1: reproduce before fixing

Wrote `test/PrivateERC20GaslessSecurity.test.ts`. Each test asserts the **secure** behaviour, so it failed against the vulnerable contract with a message showing what leaked, and now serves as a regression test.

### Step 2: choose how to remove the self-call

Root cause of C1: a self-call puts the contract's own permissions in play for every user call. Options considered:

| Option | Verdict |
|---|---|
| Keep the self-call, check `_msgSender()` instead of `msg.sender` | Smallest fix, but every future check must remember the rule |
| Keep the self-call plus a selector allowlist | Removes features from the gasless path |
| **Drop the self-call; run the operation with `from` as an explicit caller** | Chosen: safest model, matches EIP-3009 |

### Step 3: first implementation (internal dispatcher) and the size limit

A single `executeWithAuthorization` decoded the selector and called internal `_op(from, …)` functions. It worked, but the token was **27,329 bytes vs the 24,576 limit** (revert strings and metadata were already stripped).

- Moved OPRF note logic into a **linked library** (`PrivateOPRFNotes`, runs via `DELEGATECALL` in the token's context, so storage, MPC permissions and events stay the token's). Got the token to 24,079.
- Feedback: the dispatcher's long `if` chain was hard to read.

### Step 4: readability (final design)

Measured per-operation EIP-3009 functions (`shieldWithAuthorization`, …): about **600 bytes each**, so ~20 operations would put the token near 34 KB. Not viable on the token.

| Option | Verdict |
|---|---|
| EIP-3009 functions on the token | Does not fit |
| **ERC-2771: generic forwarder contract + plain token entrypoints** | Chosen: no dispatch code anywhere, same signed message as before, forwarder has its own size budget |
| ERC-2771 with typed per-operation functions in the forwarder | Best wallet display, but ~20 functions and bigger client changes |

Why ERC-2771 doesn't bring C1 back: the forwarder is a separate contract with **no MPC permissions**, raw-handle checks use `isPermitted(handle, _msgSender())`, and admin checks use the raw `msg.sender`.

## 3. Final architecture

```
Facilitator ──► PrivateERC20GaslessForwarder.executeWithAuthorization(from, data, …, sig, insertNonce, insertSig)
                  │ verify EIP-712 (domain: token name, "1", verifyingContract = forwarder)
                  │ mark nonce used
                  ├─► token.consumeInsertGrant(insertNonce, insertSig) ‖ from   (optional)
                  └─► token.call(data ‖ from)                                   (ERC-2771)

PrivateERC20Contract256Gasless
  _msgSender()  = appended `from` only when msg.sender == trustedForwarder
  _authorizer() = `from` on forwarded calls, else tx.origin   (OPRF destination rules)
  _checkOwner() = raw msg.sender                               (admin never via signature)
  OPRF ops      ──► PrivateOPRFNotes (linked library, DELEGATECALL)
```

| Contract | Size (bytes) |
|---|---|
| `PrivateERC20Contract256Gasless` | 20,495 |
| `PrivateOPRFNotes` | 6,376 |
| `PrivateERC20GaslessForwarder` | 3,494 |

### Security rules now enforced

- **Raw handles:** the caller (or signer) must already be permitted on the handle.
- **Value ciphertexts:** must belong to the signer (forwarded) or to the direct caller / `tx.origin` (direct, keeps Safe execution working).
- **OPRF notes:** only an authorizer equal to the note owner may send value anywhere but the owner; otherwise the owner is credited.
- **Admin and ownership:** never authorized through the forwarder.
- **Signatures:** EIP-712 domain bound to the forwarder and chain; one-time nonces; failed calls revert and leave the nonce unused; signers can cancel.

## 4. Files changed

| File | Change |
|---|---|
| `contracts/PrivateERC20Contract256Gasless.sol` | ERC-2771 context, removed self-call/dispatcher/EIP-712, ciphertext ownership check, raw-handle checks, admin hardening, OPRF ops call the library |
| `contracts/PrivateERC20GaslessForwarder.sol` | New: signature verification, nonces, cancel, insert grant, ERC-2771 call |
| `contracts/libraries/PrivateOPRFNotes.sol` | New: OPRF split/burn/merge/transfer/redeem logic |
| `contracts/libraries/PrivateERC20GaslessStorage.sol` | New: shared storage struct (same ERC-7201 slot and layout), `OPRFToken` |
| `test/helpers/testHelpers.ts` | Deploys and links the library, deploys the forwarder, sets it on the token |
| `scripts/deploy-private-erc20-for-underlying.ts`, `scripts/verify-contracts.ts` | Record and verify library and forwarder addresses |
| `test/PrivateERC20GaslessSecurity.test.ts` | New: 28 security regression tests |
| `test/PrivateERC20Gasless.test.ts`, `test/integration/safe-oprf-facilitator-service…` | Retargeted to the forwarder; admin-rejection and cancel tests |

## 5. Test coverage (Arbitrum Sepolia)

| Area | Covered by |
|---|---|
| C1 | Forwarded `contractApprove` / `contractTransfer` / `contractTransferFrom` with foreign handles revert; no permit on victim balance or OPRF key; own handle still works |
| C2 | Exact revert `"Relayer dest must be IT owner"` for burn, split-for-recipient, transferOPRF, redeemMany, redeemManyToUnderlying; owner-signed burn to a third party succeeds |
| C3 | Foreign ciphertext rejected in approve / transfer / transferFrom / mintOPRFToken, direct and forwarded |
| M1 | Relayer not permitted on burned amount; owner decrypts exact value |
| Events | Self-transfer amount correct when sufficient, zero when not |
| Forwarder | Replay, expiry, old-domain signature, `from` = token/forwarder, appended-address spoof, direct `consumeInsertGrant`, paused token, cancel |
| Admin / upgrade | Forwarder registration rules, owner-signed admin and upgrade via forwarder revert, `acceptOwnership` via forwarder reverts, owner upgrade keeps state and forwarder |
| Existing flows | Gasless shield/transfer/unshield/mint/redeem; Safe mint + facilitator redeem; original contract |

Not covered: M2 (by design), direct library calls (compiler-enforced), and `safe-oprf-facilitator-service` (needs the updated external service).

## 6. Deployment checklist

1. **Facilitator service (outside this repo):** submit `executeWithAuthorization` to the **forwarder** and sign with `verifyingContract = forwarder`. Domain name and message type are unchanged. Insert grants are still signed for the **token**. Then run `safe-oprf-facilitator-service.arbitrum-sepolia.test.ts`.
2. **Deploy order:** library → initialize the token proxy → forwarder(token) → `setTrustedForwarder`. The forwarder reads the token name once and reverts if it is empty. `deployPrivateTokenGasless` does this; if the deployer isn't the owner, the owner must call `setTrustedForwarder(forwarder)`.
3. **Upgrading an existing proxy:** link the new implementation to the library, then set the forwarder. Upgrade preserving state is tested.
4. **Ongoing rules:** never add `multicall` to the token (ERC-2771 sender spoofing); new user-facing checks must use `_msgSender()`; the owner can change the forwarder (equivalent to the existing upgrade power).
5. **Before staging:** run `npm run test:gasless:arbitrum-sepolia` and `safe-oprf-facilitator.arbitrum-sepolia.test.ts` on Arbitrum Sepolia. The security tests in this review were not re-run in the follow-up pass.

## 7. Residuals we are keeping

| Residual | Decision |
|---|---|
| `tx.origin` on direct calls (value ITs and note destinations) | Keep. Safe execution labels ciphertexts with the owner EOA while `msg.sender` is the Safe. A contract the user calls in that same transaction can use the user's public ciphertext. A stranger cannot. Facilitator submits the relay, so `tx.origin` is the facilitator and this arm does not apply. |
| Opaque `bytes data` on user operations | Keep. Per-function typed signatures do not fit in the token. Admin calls already revert. The wallet must display the inner selector and arguments before the user signs. |
| Insert signature is not in the execute hash | Keep. Splicing it onto another still-valid authorization from the same user only burns the insert nonce and delays a relay. It does not choose a recipient. Binding it would change the message type the facilitator already signs. |
| `from` equal to the token or the forwarder | Rejected explicitly after the signature check, so a later EIP-1271 on either contract cannot authorize a call as itself. |
