# PrivateERC20Contract256Gasless: security review and redesign

Developed on the `gasless` branch (review first done on `shield-and-mint`) and merged into `master` as a stack of PRs (#10–#18) · Network used for verification: Arbitrum Sepolia (421614)

## TL;DR

- The pre-staging review of the gasless token found **two critical bugs** in the gasless path (C1, C2) and later **one high-severity privacy leak** (C3). All three were reproduced on Arbitrum Sepolia before being fixed.
- The gasless path was redesigned: the token no longer calls itself. A separate **ERC-2771 forwarder** verifies the user's EIP-712 signature and relays the call; OPRF note logic moved into a **linked library**, first to stay under the 24 KB contract size limit.
- A follow-up refactor (section 8) split the code by responsibility, made emergency recovery retire the token, fixed self-transfer semantics and restored revert strings.
- 64 tests in the gasless suites pass on Arbitrum Sepolia, including a regression test for every finding: core 9, gasless and original contract 14, security 28, anonymity 4, native unwrap 3, factory 6. The local suites (`npx hardhat test`) cover the forwarder, the factory's input checks and the storage layout.

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

**Reproduced** on the gasless contract during the second review: the attacker decrypted the owner's secret value. The gasless token now checks `it.userAddress` against the signer on a forwarded call, or against `msg.sender` / `tx.origin` on a direct call. `PrivateERC20Contract256` on this branch does **not** have that check. A long-lived insert grant to the original token still allows the same replay.

### Medium and low findings

| ID | Finding | Resolution |
|---|---|---|
| M1 | The caller of burn/redeem was permitted on the transferred amount, so a relayer learned note values | Third-party permit removed |
| M2 | Anyone holding a user's note ciphertexts (with insert access) can force-spend the notes; value still returns to the owner | Inherent to unsigned relay; documented |
| H (old) | Owner/admin functions could be executed from a signature over opaque `bytes data`, which invites phishing | Admin functions now ignore the forwarder |
| L | Self-transfers emitted an inverted amount (zero on success) | Fixed |
| L | No way to cancel a signed authorization | `cancelAuthorization(nonce)` for the signer, and `cancelAuthorizationWithSig` so a relayer can submit the signer's revocation |
| L | `setTrustedForwarder` accepted the token's own address | Rejected. The forwarder must also be a contract whose `token()` is this token |
| H | `tx.origin` as note authorizer on direct calls let any contract the user calls take the note's value | Fixed. Note ops authorize on `_msgSender()`; new notes and remainders always go to the IT owner |
| M | A native unshield payout forwarded all gas to the recipient, so a gas-burning recipient could revert the callback before the wrapped-token or park fallback ran | Fixed. Supply is settled first; unwrap and send run in one all-or-nothing self-call with the recipient's gas capped at 50,000 |
| L | `shieldAndMint(amount, recipient)` accepted the token itself, stranding the deposit in a note nobody can spend | Rejected, like the other note destinations |
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

A single `executeWithAuthorization` decoded the selector and called internal `_op(from, …)` functions. It worked, but the token was **27,329 bytes vs the 24,576 limit** (revert strings and metadata were already stripped; section 8 removes that override again).

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
  _checkOwner() = raw msg.sender                               (admin never via signature)
  entrypoints, shield/unshield, callbacks, parked claims, recovery
  balances and allowances ──► PrivateLedger   (internal library, compiled into both)
  OPRF note ops           ──► PrivateOPRFNotes (linked library, DELEGATECALL)
```

| Contract | Size (bytes, with revert strings and metadata) |
|---|---|
| `PrivateERC20Contract256Gasless` | 21,687 |
| `PrivateOPRFNotes` | 6,350 |
| `PrivateERC20GaslessForwarder` | 4,269 |
| `PrivateERC20GaslessFactory` | 9,032 |

### Security rules now enforced

- **Raw handles:** the caller (or signer) must already be permitted on the handle.
- **Value ciphertexts:** must belong to the signer (forwarded) or to the direct caller / `tx.origin` (direct, keeps Safe execution working).
- **OPRF notes:** only a caller (`_msgSender()`, never `tx.origin`) equal to the note owner may send value anywhere but the owner. New notes and remainders always go to the owner. A Safe or smart account pays third parties from an EOA-owned note by having the EOA sign a forwarded operation.
- **Admin and ownership:** never authorized through the forwarder.
- **Emergency recovery:** retires the token for good (`unpause` reverts), drops in-flight unshield callbacks and leaves parked claims payable.
- **Self-transfers:** follow OpenZeppelin ERC20. They succeed only if the balance covers the amount, and a self-`transferFrom` also needs and spends the allowance.
- **Signatures:** EIP-712 domain bound to the forwarder and chain; one-time nonces; failed calls revert and leave the nonce unused; signers can cancel.

## 4. Files changed

| File | Change |
|---|---|
| `contracts/PrivateERC20Contract256Gasless.sol` | ERC-2771 context, removed self-call/dispatcher/EIP-712, ciphertext ownership check, raw-handle checks, admin hardening, OPRF ops call the library |
| `contracts/PrivateERC20GaslessForwarder.sol` | New: signature verification, nonces, cancel, insert grant, ERC-2771 call |
| `contracts/libraries/PrivateOPRFNotes.sol` | New: OPRF mint/split/burn/merge/transfer/redeem logic |
| `contracts/libraries/PrivateLedger.sol` | New: encrypted balance and allowance bookkeeping, including self-transfers |
| `contracts/libraries/PrivateERC20GaslessStorage.sol` | New: `abstract contract PrivateERC20GaslessStorage` with the annotated `Layout` struct (ERC-7201 namespace `bubble.storage.PrivateERC20Gasless`, inherited by the token so the upgrades plugin validates it) and the `gaslessStorage()` accessor; `UnshieldRequest` |
| `contracts/interfaces/IPrivateERC20Gasless.sol` | New: the token's external API, all its events, and `OPRFToken`. The token inherits it; the note library emits its events by qualified name |
| `contracts/interfaces/IPrivateERC20GaslessForwarder.sol`, `contracts/interfaces/IWrappedNative.sol` | New: forwarder API and events; wrapped-native underlying |
| `contracts/PrivateERC20GaslessFactory.sol` | New: deploys a token proxy and its forwarder |
| `contracts/tests/*.sol` | New test mocks: `BlockableERC20` (forces a parked payout), `FeeOnTransferERC20`, `ERC2771TargetMock`, `WrappedNativeMock` (call-based or WETH9-style withdraw), `GasBurningReceiver`, `CallRelayMock` (a contract the user calls directly) |
| `test/helpers/testHelpers.ts` | Deploys and links the library, deploys the forwarder, sets it on the token |
| `scripts/deploy-private-erc20-gasless-factory.ts`, `scripts/verify-contracts.ts` | Deploy, record and verify library, implementation and factory |
| `test/PrivateERC20GaslessSecurity.test.ts` | New: 28 security regression tests |
| `test/PrivateERC20GaslessCore.test.ts`, `test/PrivateERC20GaslessNativeUnwrap.test.ts`, `test/PrivateERC20GaslessFactory.test.ts`, `test/PrivateERC20GaslessForwarder.test.ts` | New: ledger, self-transfer, recovery and parking; native unwrap; factory; forwarder (local) |
| `test/PrivateERC20GaslessStorageLayout.test.ts`, `test/fixtures/PrivateERC20Gasless.storage-layout.json` | New: local storage-layout test and its committed snapshot |
| `test/PrivateERC20Gasless.test.ts`, `test/PrivateERC20GaslessAnonymity.test.ts` | Gasless flows through the forwarder; admin-rejection and cancel tests; note round trip; agent anonymity flow |

## 5. Test coverage (Arbitrum Sepolia)

| Area | Covered by |
|---|---|
| C1 | Forwarded `contractApprove` / `contractTransfer` / `contractTransferFrom` with foreign handles revert; no permit on victim balance or OPRF key; own handle still works |
| C2 | Exact revert `"Relayer dest must be IT owner"` for burn, split-for-recipient, transferOPRF, redeemMany, redeemManyToUnderlying; owner-signed burn to a third party succeeds |
| `tx.origin` on notes | A contract the owner calls directly cannot burn the owner's note to itself |
| C3 | Foreign ciphertext rejected in approve / transfer / transferFrom / mintOPRFToken, direct and forwarded |
| M1 | Relayer not permitted on the credited or the burned amount; owner decrypts exact value |
| Notes | Split, merge (the same note twice counts once), transferOPRF to a third party, burn, redeemMany to a third party (decrypted amounts, remainder and recipient balance); value conserved |
| Native unwrap | Call-based withdraw pays native; WETH9-style withdraw and a gas-burning recipient fall back to the wrapped token; nothing parked |
| Events | Self-transfer amount correct when sufficient, zero when not; `UnshieldRequested` on the redeem-to-underlying path |
| Self-transfers | Balance unchanged; clear, encrypted and raw-handle self-`transferFrom` spend the allowance only when balance and allowance cover it |
| Storage layout (local, `npm run test:layout`) | Upgrades plugin validation; slot constant equals the ERC-7201 formula for the namespace; layout equals the committed snapshot and is upgrade-compatible; the comparator rejects reordered, retyped and removed fields |
| Recovery | Owner-only; retires the token; `unpause`/`shield`/`unshield` revert; an in-flight unshield is dropped; a later stray deposit is swept; a parked payout survives and stays claimable |
| Forwarder | Replay, expiry, old-domain signature, `from` = token/forwarder, appended-address spoof, direct `consumeInsertGrant`, paused token, cancel |
| Admin / upgrade | Forwarder registration rules, owner-signed admin and upgrade via forwarder revert, `acceptOwnership` via forwarder reverts, owner upgrade to an implementation linked to a fresh library keeps state, the forwarder and the OPRF key, and a pre-upgrade note still burns for its full amount |
| Factory | Input checks (local); token and forwarder in one transaction, forwarder trusted, creator is master and pending owner, admin frozen and only the creator can accept until `acceptOwnership`, a relayed call works, wrapped-native overload |
| Existing flows | Gasless shield/transfer/unshield/mint/redeem; original contract |

Not covered: M2 (by design), direct library calls (compiler-enforced), Safe execution, and the facilitator service flow (its test lives with the external service, not in this repo).

## 6. Deployment checklist

1. **Facilitator service (outside this repo):** submit `executeWithAuthorization` to the **forwarder** and sign with `verifyingContract = forwarder`. Domain name and message type are unchanged. Insert grants are still signed for the **token**. Then run the facilitator service's own e2e test.
2. **Deploy order:** library → implementation linked to it → token proxy → forwarder(token) → `setTrustedForwarder`. The forwarder reads the token name once and reverts if it is empty. `npm run deploy:gasless-factory:arbitrum-sepolia` deploys the library, implementation and factory and records them in `scripts/deployments/<network>.json`; `verify-contracts.ts` verifies them. `PrivateERC20GaslessFactory.createToken` then does the rest in one transaction, and the creator calls `acceptOwnership()` on the token. Until then the factory is owner and the token's admin functions are unreachable, so call `createToken` from an account that can send `acceptOwnership()` itself (it needs gas: it cannot go through the forwarder). In tests, `deployPrivateTokenGasless` does the same; if the deployer isn't the owner, the owner must call `setTrustedForwarder(forwarder)`.
3. **Upgrading an existing proxy:** link the new implementation to the library, then set the forwarder. Upgrade preserving state is tested. The follow-up refactor moved `trustedForwarder` into the main struct, so proxies deployed before it (the Oct 15 Arbitrum Sepolia factory) must be redeployed, not upgraded.
4. **Ongoing rules:** never add `multicall` to the token (ERC-2771 sender spoofing); new user-facing checks must use `_msgSender()`; the owner can change the forwarder (equivalent to the existing upgrade power); `PrivateERC20GaslessStorage.Layout` is append-only (never reorder, retype or remove a field). `npm run test:layout` enforces this against `test/fixtures/PrivateERC20Gasless.storage-layout.json`; a deliberate append updates that snapshot in the same change (`UPDATE_LAYOUT_SNAPSHOT=1 npm run test:layout`).
5. **Before staging:** run `npm run test:gasless:arbitrum-sepolia` (all the gasless suites) and the facilitator service's e2e test on Arbitrum Sepolia.
6. **Indexer and frontend:** apply the event and ABI changes listed in section 8.

## 7. Residuals we are keeping

| Residual | Decision |
|---|---|
| `tx.origin` on direct calls (value ITs only) | Keep. Safe execution labels ciphertexts with the owner EOA while `msg.sender` is the Safe. A contract the user calls in that same transaction can use the user's public ciphertext. A stranger cannot. Facilitator submits the relay, so `tx.origin` is the facilitator and this arm does not apply. |
| Opaque `bytes data` on user operations | Keep. Per-function typed signatures do not fit in the token. Admin calls already revert. The wallet must display the inner selector and arguments before the user signs. |
| Insert signature is not in the execute hash | Keep. Splicing it onto another still-valid authorization from the same user only burns the insert nonce and delays a relay. It does not choose a recipient. Binding it would change the message type the facilitator already signs. |
| `from` equal to the token or the forwarder | Rejected explicitly after the signature check, so a later EIP-1271 on either contract cannot authorize a call as itself. |
| Factory `implementation` is immutable | Keep, as in `PrivateERC20Factory`. A patched implementation needs a new factory; tokens already created upgrade on their own. |
| Owner can upgrade a retired token | Keep. Within the existing owner trust model (the owner can already upgrade at any time); an upgrade could clear `retired`. |
| Native unwrap with a WETH9-style underlying | Keep. Its `withdraw` sends ETH with a 2300-gas stipend that cannot reach the proxy, so `unwrap = true` always pays the wrapped token there. Safe, documented on `redeemManyToUnderlying`. |
| Pool shortfall on note redemption | Not handled in code. The pool covers all live notes by construction, so its "moves nothing" branches are defensive; recovery, the one way to break this, retires the token. Documented in `PrivateOPRFNotes`. |

## 8. Follow-up refactor

A second architectural review moved logic to where it belongs and fixed what it found. Every step was re-run on Arbitrum Sepolia.

| Change | Why |
|---|---|
| `PrivateLedger` holds every balance and allowance write and the self-transfer rules | Bookkeeping lived in two copies (token and note library) with a hidden "from != to" precondition |
| All note minting goes through `PrivateOPRFNotes._issueNote` | Minting was split between the token and the library and repeated about eight times |
| `redeemManyToUnderlying` debits the pool directly | It credited and then debited the recipient, which once burned the recipient's own balance |
| Emergency recovery retires the token | Recovery zeroed supply but kept encrypted balances, and `unpause` was open, so an old balance could unshield against later deposits |
| Self-transfers follow OpenZeppelin ERC20 | Encrypted self-transfer returned true while emitting zero; self-`transferFrom` never checked the balance or spent the allowance |
| Revert strings and CBOR metadata are back | After the refactor the token fits under the limit with both (21,687 bytes now), so the strip override in `hardhat.config.ts` is gone |
| One storage namespace, shared events interface, SafeERC20, fewer wrappers | Simpler layout and ABI; non-standard underlying tokens supported |
| Own ERC-7201 namespace `bubble.storage.PrivateERC20Gasless`, annotated in an inherited abstract contract | The struct shared the old token's `bubble.storage.PrivateERC20Contract256` ID without the annotation, so the upgrades plugin never checked it. In-place upgrades from old token proxies are not supported |

Breaking changes for the indexer and frontend:

- `UnshieldRequested(to, amount, decryptId)`: new indexed `decryptId`. `redeemManyToUnderlying` now emits it too, with `amount = 0` because the amount is encrypted. `getLastDecryptRequestId` is removed.
- `EmergencyRecovery` is emitted on every call, also when the amount is zero, and marks retirement.
- `redeemManyToUnderlying` no longer emits `PrivateTransfer(token → recipient)`.
- In `splitToken`, `OPRFSplit` now comes after the two `OPRFMinted` logs (their order is unchanged).
- An encrypted self-transfer the balance cannot cover returns false.
- Both `initialize` overloads are removed (the 6-argument one, and later the 5-argument one nothing called); use `initializeWithWrappedNative`.
- `redeemMany` and `redeemManyToUnderlying` no longer emit a second `OPRFBurned(owner, recipient, totalBurned)` after the per-note ones. They emit `OPRFRedeemed(owner, recipient, amount)` with the amount that actually moved (credited, or debited from the pool for unshield) instead, so summing `OPRFBurned` no longer counts a redeem twice. The per-note `OPRFBurned(owner, token, amount)` events are unchanged.
- Event amount handles are decrypt-only: the token keeps no persistent rights on them, so pass a balance handle or a fresh IT to `contractTransfer` / `contractTransferFrom` / `contractApprove`. This was already true for `PrivateTransfer` from transfers; the note pool transfer (burn, `redeemMany`) no longer differs.
- Token reverts carry their reason strings again.
