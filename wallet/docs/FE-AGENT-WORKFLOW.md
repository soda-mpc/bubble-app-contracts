# Agent workflow — frontend design

Standalone spec for the **FE app** (and the Python facilitator it talks to). Copy this file into the frontend repo; it does not depend on Hardhat layout.

**v1 MVP (narrower):** `SAFE-AGENT-UI-MVP.md`, kept with the FE app (not in this repo): Safe deploy/import, custodial agents in localStorage, **agent-paid** redeem to clear on the agent (**no** facilitator, **no** destination/EIP-3009). This document remains the full gasless + destination product path.

**Product (full path):** issuer turns clear USDC into an anonymous OPRF note, assigns it to a simulated **agent EOA**, and the agent spends a portion **gaslessly** to a destination. The public chain must not show an address edge from issuer (Safe/EOA) to agent.

**Related contracts repo:** `bubble-app-contracts/wallet`: `PrivateERC20Contract256Gasless` (token), its `PrivateOPRFNotes` library, `PrivateERC20GaslessForwarder` and `PrivateERC20GaslessFactory` (creates a token and its forwarder), and the Arbitrum Sepolia suites `PrivateERC20Gasless*.test.ts` (`npm run test:gasless:arbitrum-sepolia`). The insert grant is described in [`TRANSIENT-INSERT-GRANT.md`](https://github.com/soda-mpc/bubble-app-contracts/blob/master/wallet/docs/TRANSIENT-INSERT-GRANT.md); security notes are in [`gasless-security-review.md`](https://github.com/soda-mpc/bubble-app-contracts/blob/master/wallet/docs/gasless-security-review.md).

---

## End-to-end tests

- **On-chain agent flow (this repo):** `test/PrivateERC20GaslessAnonymity.test.ts` runs the agent path without the HTTP service. A user mints a note and hands its plaintext to a fresh address that never holds gas. That address spends part of the note through the forwarder and cashes out the rest. The test checks that the user's address appears in none of those transactions.
- **Facilitator HTTP e2e:** lives with `sodawallet/backend/facilitator-service` (Arbitrum Sepolia, `CHAIN_ID` 421614), not in this repo.

---

## Roles

| Role | Who | Wallet | Gas |
|------|-----|--------|-----|
| **Issuer** | User / company treasury | Safe (preferred) or EOA | Pays shield / mint |
| **Agent** | Simulated agent in UI | Fresh EOA (key in browser) | **No ETH** in production |
| **Destination** | Payout / merchant | Any address | Receives clear USDC |
| **Facilitator** | Backend hot wallet | Funded EOA | Pays redeem + EIP-3009 txs |

---

## Privacy rules (non-negotiable)

OPRF notes are **bearer instruments**. Anonymity = no on-chain link issuer → agent.

**Do**

1. Issuer: `approve` → `shield` → `mintOPRFToken`.
2. Decrypt plaintext `(x, y, q)` in the issuer wallet.
   A note is permitted only to the account it is minted to. `mintOPRFToken` mints to the caller, so a Safe
   issuer's note belongs to the Safe, and its owner EOA cannot decrypt it. A Safe issuer should use
   `shieldAndMint(amount, issuerEOA)` instead: the Safe pays the underlying, and the EOA receives the note.
3. Hand the note to the agent **off-chain** (copy, QR, encrypted payload).
4. Agent re-encrypts ITs with `userAddress = agent`, then spends via facilitator.

**Do not (this product path)**

- `splitTokenForRecipient` — emits `OPRFSplitForRecipient(issuer, agent)` and **links** them.
- Private `transfer` of the note on-chain to the agent.
- Putting the agent address in issuer mint/shield txs.

**What observers see:** `OPRFMinted(issuer)` in one tx; later `UnshieldRequested(agent, 0, decryptId)` in the facilitator's redeem tx and `Unshield(agent, amount)` in the callback. Mint handles ≠ spend handles (agent builds new ITs).

**Residual links (be honest in UI copy)**

- Anyone who already knows `y` (the issuer) can find `OPRFTokenInvalidated` and then the agent. A spend
  transaction carries `y` in the clear in its calldata, so a mined but reverted spend exposes it the same way.
- Amount / timing can correlate mint ↔ cash-out.
- Facilitator sees agent address and destination (required for payout).

---

## Why spend is not a single chain tx

`redeemManyToUnderlying` does **not** pay USDC in that transaction. It requests MPC unshield; `callbackUnshield` later transfers underlying to `recipient`.

```text
Tx A  redeemManyToUnderlying     →  UnshieldRequested(agent, 0, decryptId)  (no USDC yet; amount is encrypted, so 0)
      … MPC delay …
Tx B  callbackUnshield           →  SuccessDecryption(decryptId) + Unshield(agent, amount): USDC to agent
                                    (or UnshieldParked / UnshieldFailed, see Partial failure)
Tx C  transferWithAuthorization  →  USDC agent → destination
```

Match Tx B to Tx A by `decryptId`: `Unshield`, `UnshieldParked` and `UnshieldFailed` carry no ID, but `SuccessDecryption(decryptId)` is emitted in the same callback transaction.

Dest lock: unless the caller (`_msgSender()`: the signer on a forwarded call, else `msg.sender`) is the IT owner, `recipient` **must** be the IT owner (agent). An unsigned facilitator call cannot redeem straight to the merchant.

**UX is still one action:** `POST /v1/spend` (atomic API, batched internally).

---

## Information architecture

One app, two modes (or two routes). Same deployment.

```text
/issuer     Treasury: clear ↔ private, mint notes, assign to agents
/agents     Roster: create EOAs, import notes, spend
/activity   Tx list with privacy-aware copy
```

Suggested first viewport jobs:

1. **Issuer:** balances + “Convert to private” + “Mint anonymous note”.
2. **Agents:** list of agents + “New agent” + assigned notes.
3. **Spend:** amount + destination + confirm (then poll job).

Do not dump protocol jargon in the hero; keep “Anonymous note” / “Agent spend” as product language. Advanced: show `(x, y, q)` behind a disclosure.

---

## Screen flows

### 1. Issuer — convert clear USDC → private

```text
Connect issuer wallet (Safe or EOA)
  → Show USDC (clear) and private balance
  → Approve PrivateERC20 to spend USDC (if needed)
  → Shield(amount)
  → Wait confirmation + private balance refresh (MPC delay)
```

**UI**

- Amount input, max, token symbol.
- Status: `approving` → `shielding` → `private balance updated`.
- Safe: build `execTransaction` for `approve` / `shield` (same pattern as contracts tests).

### 2. Issuer — mint OPRF note (portion)

```text
Choose portion of private balance
  → mintOPRFToken(itUint256 quantity)          IT encrypted with userAddress = issuer
  → Decrypt (x, y, q) via Bubble proxy
  → Persist note locally (encrypted)
  → Offer Assign / Copy / QR
```

**UI**

- Portion slider or exact amount.
- After mint: “Anonymous note created — this is a bearer secret.”
- Actions: **Assign to agent**, **Copy note**, **Download JSON** (dev).

Issuer events must mention **only** the issuer address.

### 3. Agents — create EOA (simulated)

```text
Name the agent
  → ethers.Wallet.createRandom()
  → Encrypt private key with user passphrase (or session-only for demo)
  → Onboard Bubble user key (getUserKeyViaProxy)
  → Show address + “Funded for gas: no”
```

**UI**

- List: name, truncated address, notes assigned, last spend.
- **Export key** / **Wipe** (demo only; warn).
- Never send the agent private key to the facilitator.

### 4. Assign note to agent (off-chain handoff)

```text
Issuer picks agent from roster
  → Attach note package to that agent in local state
  → Optional: encrypt note to agent pubkey (v2)
  → Agent view: “Note available — q = …”
```

v1 can be same-browser: issuer and agents share local persistence. v2: clipboard / deep link / QR for another device.

**Do not** submit an on-chain transfer to “assign”.

### 5. Agent — spend (gasless, one button)

```text
Select note + amount + destination
  → Sign one transient insert grant for this token (see TRANSIENT-INSERT-GRANT.md)
       domain verifyingContract = GCACL, name = "SodaLabs MPC", version = "1"
       fields: nonce, user = agent, contract = privateToken
  → Build redeemManyToUnderlying(OPRFToken[] tokens, itUint256 amount, address recipient, bool unwrap) calldata
       tokens = [{ x, q, y_clear }] for the note, amount = spend amount
       every IT: userAddress = agent
       recipient = agent, unwrap = false (USDC path)
  → Sign EIP-712 executeWithAuthorization over that calldata
       from = agent
       verifyingContract = forwarder (not the token)
       name = token.name(), version = "1"
       tx target = forwarder
       pass the insert signature in executeWithAuthorization so the forwarder calls consumeInsertGrant
  → Sign EIP-3009 transferWithAuthorization
       from = agent, to = destination, value = amount
       validBefore = now + MPC slack (see below)
  → POST /v1/spend { redeem: { data, tokenName, authorization }, transfer }
  → Poll GET /v1/spend/{jobId}
  → Success: destination received USDC
  → Replace the local note with the remainder (always, also on UnshieldFailed)
```

**The remainder note is the new bearer secret.** `redeemManyToUnderlying` burns every input note and issues one
new note to the agent for what is left (`OPRFMinted(agent, x, y, q)` in the redeem transaction). That happens
whether or not the unshield pays. Once the redeem is mined, mark the old note spent, decrypt the agent's new
`(x, y, q)`, and keep it. After `UnshieldFailed(agent, 0)`, it holds the note's full value; the old tuple now
burns for 0.

**UI states:** `preparing` → `submitted` → `waiting for unshield` → `paying destination` → `done` | `needs attention`.

The insert grant is per transaction, not a long-lived `permitFullInsertAccess`. The agent signs it; the facilitator submits it inside `executeWithAuthorization`. The agent does not need ETH for that step.

### 6. Activity

Per job: redeem hash, unshield hash, EIP-3009 hash. Copy: “No on-chain link from treasury to this agent.”

---

## Note package (off-chain secret)

Bearer check. Anyone with it can spend (prototype threat model).

```json
{
  "version": 1,
  "chainId": 421614,
  "privateToken": "0x…",
  "underlying": "0x…",
  "x": "0x…",
  "y": "0x…",
  "q": "0x…",
  "decimals": 18,
  "mintedAt": "2026-08-24T12:00:00.000Z",
  "label": "agent-demo-1"
}
```

**Storage**

- Encrypt at rest (passphrase or OS keychain).
- Do **not** log plaintext `x` / `y` / `q`.
- After a full redeem, mark `spent`; keep `y` only if you still need issuer-side correlation debug (default: drop).

**Portioning (v1 vs v2)**

| Version | Behavior |
|---------|----------|
| **v1** | Issuer mints the exact size the agent should spend. |
| **v2** | Agent (or issuer before handoff) `splitToken` via relay; remainder stays a local note. Still **not** `splitTokenForRecipient`. |

---

## Facilitator API (FE contract)

Atomic from the app’s point of view. Internally: redeem (read `decryptId` from `UnshieldRequested`) → wait for the callback with that `decryptId` → EIP-3009.

### `POST /v1/spend`

```json
{
  "chainId": 421614,
  "idempotencyKey": "client-generated-uuid",
  "redeem": {
    "privateToken": "0x…",
    "to": "0x…",
    "data": "0x…",
    "expectedRecipient": "0xAgent",
    "tokenName": "Facilitator Service Bubble Token",
    "authorization": {
      "from": "0xAgent",
      "validAfter": "0",
      "validBefore": "1735689600",
      "nonce": "0x…",
      "signature": "0x…"
    }
  },
  "transfer": {
    "token": "0xUSDC",
    "authorization": {
      "from": "0xAgent",
      "to": "0xDestination",
      "value": "1000000",
      "validAfter": "0",
      "validBefore": "1735689600",
      "nonce": "0x…",
      "v": 27,
      "r": "0x…",
      "s": "0x…"
    }
  }
}
```

Response `202`: `{ "jobId": "…", "status": "accepted" }`.

**EIP-3009 `validBefore`:** include slack for MPC unshield (start with **15–30 minutes** on Arbitrum Sepolia; tune from `waitForUnshieldOutcome` timings).

### `GET /v1/spend/{jobId}`

```json
{
  "jobId": "…",
  "status": "pending_unshield | transferring | succeeded | failed",
  "steps": {
    "redeem": { "txHash": "0x…", "status": "mined" },
    "unshield": { "txHash": "0x…", "status": "mined" },
    "transfer": { "txHash": "0x…", "status": "mined" }
  },
  "error": null
}
```

### Partial failure (must handle in UI)

| Failure | Chain state | FE |
|---------|-------------|-----|
| Redeem fails in simulation (`eth_call` / gas estimate) | Nothing on-chain | Fix the cause and retry. Do not send anything on-chain to "rotate" the note: that would be the first on-chain link |
| Redeem mined but reverted | Note still valid. Its `y` and the agent's ITs are public in the calldata, the same exposure a successful spend has. The revert rolled back the authorization's nonce and the insert grant's, so both stay usable until `validBefore` | Retry `/v1/spend` with freshly encrypted ITs (new idempotency key). If not retrying, revoke the old authorization with `forwarder.cancelAuthorizationWithSig` through the facilitator |
| `UnshieldFailed` (amount 0) | Decrypt produced 0. For a redeem: the note was already spent or invalid, or `amount` exceeded the notes' total. For `unshield`: the private balance could not cover it. Nothing is parked | Show error; do not assume payout. After a redeem, the remainder note holds the value (see above) |
| `UnshieldFailed` (amount > 0) | The request predates an emergency recovery, which already swept its backing. Nothing is paid or parked | Show error; the token is retired |
| `UnshieldParked` | Underlying sits on the private token for `account` | Read `claimableUnderlying(account)`. User calls `claimUnshielded(to)` to pull the ERC20. A pause or retirement does not block the claim |
| Token retired (`retired()` is true, `EmergencyRecovery` emitted) | Paused for good. Every user operation reverts with `EnforcedPause`; `unpause` reverts with `"Token retired"` | Show the token as retired; only parked claims can still be pulled |
| Unshield OK, 3009 fails / expired | **USDC sits on agent** | `failed` + “Complete payout”; resign 3009 |

Escape hatch (facilitator should expose):

`POST /v1/spend/{jobId}/complete-transfer` — new EIP-3009 auth only; **do not** redeem again.

Optional later (ops): `POST /v1/relay/redeem` and `POST /v1/relay/eip3009`. Product FE should only use `/v1/spend` + complete-transfer.

---

## Who does crypto (browser vs backend)

| Job | Where |
|-----|--------|
| Wallet connect / Safe `execTransaction` | Issuer FE |
| Bubble key onboard | Issuer EOA + each agent EOA |
| Encrypt ITs (`userAddress` = caller identity) | Issuer (mint), Agent (redeem) |
| Decrypt `(x, y, q)` | Issuer FE via Bubble proxy |
| Build `redeemManyToUnderlying` calldata | Agent FE |
| Sign EIP-712 `executeWithAuthorization` | Agent FE (agent key) |
| Sign EIP-712 transient insert grant (`verifyingContract` = GCACL) | Agent FE (agent key); facilitator submits it with the execute |
| Sign EIP-3009 | Agent FE (agent key) |
| Broadcast + wait unshield + 3009 | Facilitator |
| Store notes / agent keys | FE local (encrypted) |

Facilitator should receive **encoded calldata + signatures**, not a standing copy of note plaintext. Ciphertexts will appear on-chain anyway.

### Insert ACL

`GCHandler.ValidateCiphertext` accepts a ciphertext when `tx.origin` is the user, when a persistent `permitFullInsertAccess` exists, or when this transaction set the transient insert bit for `(it.userAddress, msg.sender)`. On a forwarded call `msg.sender` is the private token, not the facilitator. A grant to the facilitator EOA does nothing.

The facilitator path uses that transient grant. The agent signs `TransientInsertPermission` (`verifyingContract` = GCACL, name `"SodaLabs MPC"`, version `"1"`, fields `nonce`, `user` = agent, `contract` = private token). The facilitator submits it inside `forwarder.executeWithAuthorization`, which calls `consumeInsertGrant` before the redeem. The transaction target and the execute-signature `verifyingContract` are the forwarder. Follow the spend steps above and `TRANSIENT-INSERT-GRANT.md`.

A user who sends their own transaction can still call `GCACL.permitFullInsertAccess(privateToken, expiration)` and pay gas. The facilitator path does not.

### Dest lock (FE must set recipient = agent)

Inner `redeemManyToUnderlying.recipient` **must** still be the agent so unshield credits the agent and EIP-3009 can pay the merchant. On `PrivateERC20Contract256Gasless`, a caller who is not the note owner is dest-locked: `recipient` must be the IT owner. The caller is the signer on a forwarded call, otherwise `msg.sender`, never `tx.origin`. A signed `executeWithAuthorization` does not skip that lock. Only the note owner may choose another recipient, and any remainder note always goes to the owner. The transaction target and the EIP-712 `verifyingContract` are the forwarder. A violation reverts with `"Relayer dest must be IT owner"`; the forwarder passes the token's revert reason through, so the FE can show it.

---

## Suggested UI copy / states

**Issuer mint:** “Create an anonymous note. Share it only with the agent — anyone with the note can spend it.”

**Assign:** “Shared off-chain. This does not appear on the blockchain.”

**Spend:** “The agent never needs ETH. We wait for confidential unshield, then pay the destination.”

**Waiting unshield:** “Converting the note to USDC on the agent (this can take a minute).”

**Complete payout:** “USDC is on the agent; destination payment didn’t finish. Sign again to send.”

---

## Config the FE needs

| Variable | Purpose |
|----------|---------|
| `CHAIN_ID` | e.g. `421614` Arbitrum Sepolia |
| `RPC_URL` | Read + issuer txs |
| `PRIVATE_ERC20` | Proxy address, from `PrivateERC20GaslessFactory.createToken`. The creator must then call `acceptOwnership()` with its own gas; until then the token's admin functions are unreachable |
| `FORWARDER` | Per-token forwarder. Transaction target and EIP-712 `verifyingContract` |
| `UNDERLYING` | USDC or EIP-3009 mock |
| `GCACL` | Permit insert |
| `BUBBLE_PROXY_URL` | Key onboard + decrypt |
| `FACILITATOR_URL` | `/v1/spend` |
| `SAFE_ADDRESS` | Optional issuer Safe |

Underlying **must** support EIP-3009 `transferWithAuthorization` (real USDC or a mock on testnet).

---

## MVP slice (FE)

**Current locked MVP:** `SAFE-AGENT-UI-MVP.md` in the FE app (Safe in scope; facilitator + EIP-3009 out).

**Full-path MVP (later / gasless destination):**

1. EOA or Safe issuer: shield + mint + decrypt + copy note JSON.
2. Create agent EOA in-browser; paste/assign note.
3. Spend form → build redeem + sign 3009 → `POST /v1/spend` → poll.
4. Activity list with three tx hashes.
5. Handle `complete-transfer` when unshield succeeded and 3009 failed.

**Defer from full path:** QR handoff, `splitToken` remainder UX, production key backup.

---

## Out of scope for this FE path

- Using `splitTokenForRecipient` as “send to agent”.
- Multicall of redeem + EIP-3009 in **one** chain transaction (USDC does not exist until callback).
- Facilitator choosing `recipient = destination` on redeem (blocked by dest lock).

---

## Implementation checklist (other repo)

- [ ] Issuer shield / mint / decrypt note
- [ ] Agent EOA create + Bubble onboard
- [ ] Local encrypted note store + assign
- [ ] Agent IT encrypt + transient insert grant, then `executeWithAuthorization` with `verifyingContract` = forwarder
- [ ] EIP-3009 typed-data sign (USDC version / domain)
- [ ] `POST /v1/spend` + poll + partial-failure CTA
- [ ] Copy that does not claim issuer unlinkability beyond “no address edge on-chain”
