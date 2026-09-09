# Safe Agent UI — MVP plan & decisions

Status: **Phase 0 scaffold in progress** (`wallet/safe-agent-ui`).  
Date: 2026-09-09  
Related: [`FE-AGENT-WORKFLOW.md`](./FE-AGENT-WORKFLOW.md) (full protocol / facilitator product path), [`CONTEXT.md`](../CONTEXT.md).

---

## Goal

Build a **demo UI for Safe issuers** who:

1. Deploy or import a Safe wallet  
2. Generate agent EOAs (custodial keys in the browser)  
3. Mint anonymous OPRF notes and assign them to agents (off-chain)  
4. Act as an agent and convert **part** of a note to **clear** underlying on the agent’s balance  

No merchant destination payout in v1. No facilitator for spend in v1 (agent pays gas).

---

## Decisions (locked)

| Topic | Decision |
|-------|----------|
| **Where UI lives** | New folder **inside this project** for now; extract to its own repo later if needed |
| **Folder** | `wallet/safe-agent-ui/` (Next.js app) |
| **Framework reference** | Mirror structure/patterns from `/Users/anatseuski/work/sodalabs/sodawallet/packages/nextjs` (App Router, wagmi/viem/RainbowKit or equivalent wallet connect, Tailwind, services/hooks layout) — **slim copy**, not a full sodawallet fork |
| **Users (v1)** | **Issuer-only demo**: one browser; owner creates agents and spends **as** them |
| **Agent keys** | Generated in-browser; stored in **localStorage** (demo OK). Later: optional temp-account-service |
| **Safe** | Deploy new 1-of-1 **or** import existing address; connected MetaMask account must be an owner |
| **Network (v1)** | Arbitrum Sepolia (`421614`) |
| **Tokens** | **Configurable** via env. Default path: deploy fresh PrivateERC20 + mock TestUSD/USDC for the session or documented deploy script. Later: point env at already-deployed TestUSDC / private token |
| **Mint → agent** | Off-chain note handoff only. **Do not** use `splitTokenForRecipient` |
| **Spend path** | **No facilitator.** Agent EOA pays gas: `permitFullInsertAccess` (once) + `redeemManyToUnderlying` (or redeem then unshield if needed by contract API) → clear ERC20 lands on **agent** |
| **Partial amount** | User specifies how much clear the agent should receive; remainder stays as OPRF on the agent |
| **Destination / EIP-3009** | **Out of scope for v1** — stop when clear balance is on the agent |
| **Facilitator** | Not required for v1 spend. URL may be configured later for a future gasless path (local or deployed); user will provide when ready |

---

## Non-goals (v1)

- Merchant / destination payout (`transferWithAuthorization` / `/v1/spend`)  
- Gasless agent spend via facilitator  
- Multi-device agent sessions / QR handoff  
- Production key backup, passphrase encryption of localStorage  
- Multi-sig Safe UX beyond “I am an owner via MetaMask”  
- Using `splitTokenForRecipient` as “send to agent”  
- Extracting the app to a separate git remote (defer)

---

## Information architecture

Single app, issuer-centric modes (same browser):

```text
/                 Connect + network check
/safe             Deploy or import Safe
/treasury         Clear ↔ private (approve, shield); show balances
/agents           Create / list agents (localStorage)
/notes            Mint OPRF from Safe private balance; assign to agent
/act              Act as agent: amount → clear on agent; show clear balance
/activity         Optional: local history of mint / redeem txs
```

Product language: “Anonymous note”, “Agent”, “Cash out to clear” — keep `(x, y, q)` behind advanced disclosure.

---

## Screen flows (v1)

### 1. Connect

- MetaMask via RainbowKit/wagmi (same approach as sodawallet nextjs)  
- Require Arbitrum Sepolia  
- Persist last-used Safe address in localStorage / env override  

### 2. Safe — deploy or import

**Import**

- User pastes Safe address  
- App checks `getOwners()` includes connected EOA and `getThreshold()` (document 1-of-1 preferred for demo)  
- Store as active issuer Safe  

**Deploy**

- Reuse patterns from `scripts/safe/safe-core.ts` (canonical SafeL2 + factory on Arb Sepolia)  
- `createProxyWithNonce` with connected EOA as sole owner, threshold 1  
- Persist new address  

Issuer txs use Safe `execTransaction` + EIP-712 owner signature (same as `scripts/safe/safe-tx.ts`).

### 3. Treasury — clear → private

```text
Configure UNDERLYING + PRIVATE_ERC20 (or deploy helpers)
  → Show clear ERC20 balance of Safe
  → Safe approve(privateToken, amount)
  → Safe shield(amount)
  → Wait MPC / balance sync; show private balance (decrypt via Bubble proxy after GCACL.permit to owner EOA)
```

### 4. Agents — create roster

```text
Name agent
  → Wallet.createRandom()
  → Save { name, address, privateKey } in localStorage
  → Onboard Bubble USER_KEY for that EOA (proxy)
  → List: name, address, notes assigned, clear balance (read)
```

Never upload agent private keys to any backend.

### 5. Mint note + assign

```text
Choose amount from Safe private balance
  → Safe mintOPRFToken(quantity IT bound to Safe / owner encryption rules as in tests)
  → Decrypt (x, y, q) via Bubble proxy (owner EOA with view permit)
  → Persist note package locally; assign to selected agent (same-browser)
```

Note package shape: see `FE-AGENT-WORKFLOW.md` § Note package (`version`, `chainId`, `privateToken`, `underlying`, `x`, `y`, `q`, …).

### 6. Act as agent — OPRF → clear (no facilitator)

```text
Select agent + note + clear amount
  → Load agent key from localStorage
  → Ensure agent has enough ETH for gas (manual fund or small owner→agent transfer in demo UI)
  → Once per agent/token: GCACL.permitFullInsertAccess(privateToken, expiration) from agent
  → Build ITs with userAddress = agent; call redeemManyToUnderlying(..., recipient = agent)
  → Poll / wait until clear underlying balance on agent increases
  → Update local note state (partial spend / remainder OPRF if applicable)
```

**Gas:** agent pays. Demo may include “Fund agent with 0.001 ETH from owner” for convenience — not part of the privacy protocol (same caveat as tests).

### 7. Activity (nice-to-have in v1)

Local list: mint tx, redeem tx, unshield/callback if visible, amounts, agent name. Copy: “No on-chain address edge from Safe to agent on the cash-out tx.”

---

## Config (env)

All token/network endpoints **configurable**. Example:

| Variable | Purpose |
|----------|---------|
| `NEXT_PUBLIC_CHAIN_ID` | `421614` |
| `NEXT_PUBLIC_RPC_URL` | Arb Sepolia RPC |
| `NEXT_PUBLIC_SAFE_ADDRESS` | Optional pre-set Safe |
| `NEXT_PUBLIC_PRIVATE_ERC20` | Private token proxy (empty → deploy / prompt) |
| `NEXT_PUBLIC_UNDERLYING` | TestUSDC / mock EIP-3009 token (empty → deploy / prompt) |
| `NEXT_PUBLIC_GCACL` | GCACL address for network |
| `NEXT_PUBLIC_BUBBLE_PROXY_URL` | Default `https://proxy.bubble.sodalabs.net` |
| `NEXT_PUBLIC_FACILITATOR_URL` | Reserved for later gasless path; unused in v1 spend |

**Token strategy**

1. **Start:** support deploying a fresh mock underlying + PrivateERC20 (gasless or standard — prefer the variant tests use for Arb Sepolia redeem) via script or in-app deploy, then write addresses into env/local config.  
2. **Later:** set `NEXT_PUBLIC_UNDERLYING` / `NEXT_PUBLIC_PRIVATE_ERC20` to existing Arb Sepolia deployments (user already has TestUSDC).

---

## App layout (planned, sodawallet-inspired)

```text
wallet/safe-agent-ui/
  app/                 # Next.js App Router pages
  components/
  config/              # chains, contracts ABIs, env
  hooks/               # useSafe, useAgents, useNotes, …
  services/            # safe exec, bubble proxy, oprf redeem, localStorage
  lib/ / utils/
  types/
  package.json         # next, wagmi, viem, rainbowkit, tanstack-query, ethers as needed
```

Reuse **logic** from this repo where possible:

| Contracts repo | UI service |
|----------------|------------|
| `scripts/safe/safe-core.ts` | Deploy / resolve Safe infra + wallet |
| `scripts/safe/safe-tx.ts` | `execTransaction` helpers |
| `test/helpers/safeBubbleHelpers.ts` | Encode shield / mint / permit patterns |
| `test/helpers/bubbleCryptoTransport.ts` | Onboard + decrypt (browser port) |

Do **not** import Hardhat test files into the Next app; copy/adapt pure helpers into `services/`.

---

## Privacy rules (unchanged)

- Mint events must mention **Safe only**  
- Assign note **off-chain**  
- Cash-out txs must not include Safe address  
- Residual links (`y_clear`, timing, amounts) — honest UI copy only  

---

## Implementation phases

### Phase 0 — Scaffold (this doc done)

- [x] Lock product decisions  
- [x] Create `wallet/safe-agent-ui` Next app from sodawallet nextjs patterns (minimal)  
- [x] Wire Arb Sepolia + MetaMask  
- [x] Env template (`.env.example`)  

### Phase 1 — Safe + treasury

- [x] Import Safe + ownership check  
- [x] Deploy 1-of-1 Safe  
- [x] Configurable / deployable underlying + PrivateERC20  
- [x] Safe approve + shield + private balance view  
- [x] Agents localStorage CRUD (early)  
- [x] Notes placeholder + off-chain assign (early)  
- [x] Notes on-chain mintOPRFToken + decrypt + assign  

### Phase 2 — Agents + notes

- [x] Agent create / list (localStorage)  
- [ ] Bubble onboard per agent  
- [x] Safe mintOPRFToken + decrypt note + assign  

### Phase 3 — Act as agent (clear out)

- [x] Fund-agent helper (optional demo) — manual fund for now  
- [x] Insert ACL permit from agent  
- [x] Partial `redeemManyToUnderlying` → wait clear balance on agent  
- [x] Note remainder bookkeeping  

### Phase 4 — Polish / later

- [ ] Activity view  
- [ ] Point env at existing TestUSDC  
- [ ] Optional facilitator URL for gasless spend (separate decision)  
- [ ] Extract folder to standalone repo  

---

## Open / deferred (not blocking Phase 0–1)

| Item | Notes |
|------|--------|
| Exact package name | e.g. `safe-agent-ui` |
| PrivateERC20 variant | Prefer gasless contract only if we need `executeWithAuthorization` later; v1 agent-paid path can use standard PrivateERC20 if redeem APIs match |
| GCACL + MPC addresses | From existing Arb Sepolia Bubble deployment docs / sodawallet config |
| Facilitator URL | User will provide when needed; not used for v1 spend |
| Temp-account-service | Deferred key custody |

---

## Success criteria (MVP demo)

1. Connect MetaMask on Arb Sepolia  
2. Deploy or import Safe as owner  
3. Shield TestUSD (or mock) into Safe private balance  
4. Create ≥1 agent in UI  
5. Mint note and assign to agent (local only)  
6. Act as agent for a **partial** amount; agent clear ERC20 balance increases  
7. No facilitator required; no destination address required  

---

## Explicitly superseded vs `FE-AGENT-WORKFLOW.md`

The full workflow doc still describes the **gasless facilitator + EIP-3009 destination** product. This MVP **narrows** that:

| FE-AGENT-WORKFLOW | This MVP |
|-------------------|----------|
| Facilitator `/v1/spend` | Agent-paid redeem only |
| Destination + EIP-3009 | Clear balance on agent only |
| Safe issuer UI deferred | Safe deploy/import **in scope** |
| Encrypted local note store | Plain localStorage OK for demo |

When gasless spend is added later, re-enable facilitator sections from `FE-AGENT-WORKFLOW.md` without changing mint/assign privacy rules.
