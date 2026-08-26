# Agent workflow — frontend design

Standalone spec for the **FE app** (and the Python facilitator it talks to). Copy this file into the frontend repo; it does not depend on Hardhat layout.

**Product:** issuer turns clear USDC into an anonymous OPRF note, assigns it to a simulated **agent EOA**, and the agent spends a portion **gaslessly** to a destination. The public chain must not show an address edge from issuer (Safe/EOA) to agent.

**Related contracts repo:** `bubble-app-contracts/wallet` — `PrivateERC20Contract256`, Safe helpers, Arbitrum Sepolia tests (`safe-oprf-facilitator*.arbitrum-sepolia.test.ts`). Protocol notes: `CONTEXT.md`.

---

## Facilitator HTTP e2e (contracts repo)

Against `sodawallet/backend/facilitator-service` on Arb Sepolia:

```bash
# Terminal A — facilitator (CHAIN_ID must be 421614)
cd sodawallet/backend/facilitator-service
# start as you normally do (uvicorn / docker)

# Terminal B
cd bubble-app-contracts/wallet
FACILITATOR_URL=http://localhost:8002 npm run test:safe:oprf-facilitator-service:arbitrum-sepolia
```

Deploys `MockEIP3009Token` named **TestUSD** (matches facilitator `EIP3009_NAME`). Agent is funded only via `POST /v1/faucet`, then ACL permit, then signed `executeWithAuthorization` + `POST /v1/spend`.

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
3. Hand the note to the agent **off-chain** (copy, QR, encrypted payload).
4. Agent re-encrypts ITs with `userAddress = agent`, then spends via facilitator.

**Do not (this product path)**

- `splitTokenForRecipient` — emits `OPRFSplitForRecipient(issuer, agent)` and **links** them.
- Private `transfer` of the note on-chain to the agent.
- Putting the agent address in issuer mint/shield txs.

**What observers see:** `OPRFMinted(issuer)` in one tx; later `Unshield(agent)` from a facilitator tx. Mint handles ≠ spend handles (agent builds new ITs).

**Residual links (be honest in UI copy)**

- Anyone who already knows `y` (the issuer) can find `OPRFTokenInvalidated` and then the agent.
- Amount / timing can correlate mint ↔ cash-out.
- Facilitator sees agent address and destination (required for payout).

---

## Why spend is not a single chain tx

`redeemManyToUnderlying` does **not** pay USDC in that transaction. It requests MPC unshield; `callbackUnshield` later transfers underlying to `recipient`.

```text
Tx A  redeemManyToUnderlying     →  UnshieldRequested  (no USDC yet)
      … MPC delay …
Tx B  callbackUnshield           →  USDC to agent
Tx C  transferWithAuthorization  →  USDC agent → destination
```

Facilitator dest lock: if `tx.origin` is the facilitator, `recipient` **must** be the IT owner (agent). You cannot redeem straight to the merchant in this path.

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
  → mintOPRFToken(quantity IT, userAddress = issuer)
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
  → Insert grant once per agent:
       POC: faucet → agent calls GCACL.permitFullInsertAccess(privateToken)
       later: sign EIP-712 PermitFullInsertAccess; facilitator submits
              permitFullInsertAccessWithAuthorization (see Insert ACL)
  → Build redeemManyToUnderlying calldata
       ITs: userAddress = agent
       recipient = agent
  → Sign EIP-712 executeWithAuthorization over that calldata
       from = agent, verifyingContract = privateToken, name = token.name(), version = "1"
  → Sign EIP-3009 transferWithAuthorization
       from = agent, to = destination, value = amount
       validBefore = now + MPC slack (see below)
  → POST /v1/spend { redeem: { data, tokenName, authorization }, transfer }
  → Poll GET /v1/spend/{jobId}
  → Success: destination received USDC
```

**UI states:** `preparing` → `submitted` → `waiting for unshield` → `paying destination` → `done` | `needs attention`.

ACL bootstrap is the one extra on-chain step the agent may need **once**. Today that is `GCACL.permitFullInsertAccess` paid by the agent (after faucet). Intended GCACL change: signed `permitFullInsertAccessWithAuthorization` so the facilitator submits it (see Insert ACL below).

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

Atomic from the app’s point of view. Internally: redeem → wait `Unshield` → EIP-3009.

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
| Redeem reverts | Note still valid | Retry `/v1/spend` (new idempotency key if calldata changed) |
| `UnshieldFailed` | No clear USDC | Show error; do not assume payout |
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
| Sign EIP-712 `PermitFullInsertAccess` (proposed GCACL) | Agent FE (agent key); facilitator submits |
| Sign EIP-3009 | Agent FE (agent key) |
| Broadcast + wait unshield + 3009 | Facilitator |
| Store notes / agent keys | FE local (encrypted) |

Facilitator should receive **encoded calldata + signatures**, not a standing copy of note plaintext. Ciphertexts will appear on-chain anyway.

### Insert ACL (easy to get wrong)

`GCHandler.ValidateCiphertext` checks `isFullInsertPermitted(userAddress, msg.sender)` where `msg.sender` is **PrivateERC20**, not the facilitator. Granting insert to the facilitator EOA is a **no-op** on Arbitrum Sepolia.

**Today (POC):** the **agent** must call, once (long TTL is fine):

`GCACL.permitFullInsertAccess(privateTokenAddress, expiration)`

`permitter` is always `msg.sender` of that GCACL call. Relaying the agent’s raw EOA tx still charges `from` (the agent). Wrapping the call in PrivateERC20 `executeWithAuthorization` also fails: GCACL would see `permitter = token`. Faucet + agent-submitted permit is the current workaround.

**Proposed GCACL change (full agent gasless):** keep the existing function; add a signed sibling that writes the **same** mapping `ValidateCiphertext` already reads (`permitter = agent`, `permittee = privateToken`). `ValidateCiphertext` does not change. Pattern is ERC-2612 / the same EIP-712 + EIP-1271 style as `executeWithAuthorization`.

```solidity
function permitFullInsertAccessWithAuthorization(
    address permitter,      // agent
    address permittee,      // PrivateERC20
    uint64 expirationDate,
    uint256 validAfter,
    uint256 validBefore,
    bytes32 nonce,
    bytes calldata signature
) external;
```

Typed data (`verifyingContract` = GCACL):

```text
PermitFullInsertAccess(address permitter,address permittee,uint64 expirationDate,uint256 validAfter,uint256 validBefore,bytes32 nonce)
```

Checks: non-zero addresses, `expirationDate > now`, time window, nonce unused for `permitter`, `SignatureChecker.isValidSignatureNow(permitter, hash, signature)`, then the same store write as `permitFullInsertAccess`.

Agent signs; facilitator pays gas and submits. Do **not** set `permittee` to the facilitator. One facilitator tx can run grant then redeem:

1. `GCACL.permitFullInsertAccessWithAuthorization(agent, token, …)`
2. `token.executeWithAuthorization(…redeemManyToUnderlying…)`

This lives in **bubble-core-contracts** (GCACL), not `PrivateERC20Contract256Gasless`. Until it ships, FE still faucet → agent permit → spend.

### Dest lock (FE must set recipient = agent)

Inner `redeemManyToUnderlying.recipient` **must** still be the agent so unshield credits the agent and EIP-3009 can pay the merchant. On `PrivateERC20Contract256Gasless`, an unsigned relay is dest-locked on-chain; a signed `executeWithAuthorization` skips that lock — the facilitator still rejects a non-agent inner recipient so the 3009 pipeline holds.

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
| `PRIVATE_ERC20` | Proxy address |
| `UNDERLYING` | USDC or EIP-3009 mock |
| `GCACL` | Permit insert |
| `BUBBLE_PROXY_URL` | Key onboard + decrypt |
| `FACILITATOR_URL` | `/v1/spend` |
| `SAFE_ADDRESS` | Optional issuer Safe |

Underlying **must** support EIP-3009 `transferWithAuthorization` (real USDC or a mock on testnet).

---

## MVP slice (FE)

1. EOA issuer: shield + mint + decrypt + copy note JSON.
2. Create agent EOA in-browser; paste/assign note.
3. Spend form → build redeem + sign 3009 → `POST /v1/spend` → poll.
4. Activity list with three tx hashes.
5. Handle `complete-transfer` when unshield succeeded and 3009 failed.

**Defer:** Safe issuer UI, QR handoff, `splitToken` remainder UX, production key backup.

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
- [ ] Agent IT encrypt + `permitFullInsertAccess` (faucet POC; later signed `permitFullInsertAccessWithAuthorization`)
- [ ] EIP-3009 typed-data sign (USDC version / domain)
- [ ] `POST /v1/spend` + poll + partial-failure CTA
- [ ] Copy that does not claim issuer unlinkability beyond “no address edge on-chain”
