# Bubble wallet + Safe — project context

Use this file to onboard agents or developers working in `bubble-app-contracts/wallet`. It captures architecture, integration decisions, and open research.

Frontend (separate repo): copy [`docs/FE-AGENT-WORKFLOW.md`](docs/FE-AGENT-WORKFLOW.md) — issuer/agent screens, note package, gasless `POST /v1/spend`.

## What this repo is

Hardhat project for **Bubble private ERC20** contracts on confidential/MPC-enabled networks (Kurtosis, Base Sepolia, Arbitrum Sepolia, etc.).

Core contract: `contracts/PrivateERC20Contract256.sol`

Gasless variant: `contracts/PrivateERC20Contract256Gasless.sol` — EIP-712 `executeWithAuthorization` (EIP-1271 for Safes) plus OPRF dest lock for unsigned relays. Facilitator tests deploy this contract.

- UUPS upgradeable proxy pattern
- Encrypted balances/allowances via `MpcCore` (`@sodalabs/bubble-core-contracts`)
- Operations: `shield`, `unshield`, encrypted `transfer`, OPRF token flows
- Tests use **EOA signers** + Bubble proxy (`PROXY_URL`) for MPC key onboarding and decryption

Sibling repos (under `sodalabs/`):

| Repo | Role |
|------|------|
| `bubble-core-contracts` | MPC primitives (`MpcCore`, `DecryptionCaller`, …) |
| `safe-smart-account` | Safe v1.4.1 source (tag `v1.4.1`) — optional local read via `npm run link:safe` |
| `confidential-safe` | Reserved for future Safe + privacy research workspace |

## Research goal: Safe instead of EOA for privacy

**Question:** Can Bubble confidential balances and transfers work when the **user identity on-chain is a Safe smart wallet** rather than an EOA?

### Two distinct Safe use cases

| Use case | Status | Description |
|----------|--------|-------------|
| **A. Safe as admin/owner** | Already implemented | Safe owns UUPS proxy (`owner`), controls upgrades. Scripts: `deploy-upgradable-private-erc20.ts`, `prepare-upgrade.ts`, `transfer-ownership-to-safe.ts`. Env: `SAFE_ADDRESS`. |
| **B. Safe as privacy wallet** | Implemented (prototype) | Safe holds encrypted balances; `shield`/`transfer`/OPRF via `execTransaction`. Anonymous OPRF cash-out via facilitator (off-chain note handoff). |

### Why EOA works today

- `PrivateERC20Contract256` keys state by **address**: `mapping(address => gtUint256) balances`
- `msg.sender` is the actor for `shield`, `transfer`, `approve`, OPRF ops
- Bubble proxy onboardings: `getUserKeyViaProxy(signer, PROXY_URL)` — **EOA-centric** today
- `MpcCore.permit(handle, addr)` grants decrypt rights to specific addresses
- GCACL supports `permitContractViewAccess` (view-only sharing between EOAs)

### Candidate models for Safe + privacy

1. **Safe vault** — balances on Safe address; owners sign `execTransaction` with encrypted calldata. **Blocker to validate:** Bubble MPC key onboarding for contract addresses.
2. **EOA user + Safe admin** — privacy on EOA, Safe only for governance (current scripts).
3. **Safe + module** (XDC AI pattern) — Allowance Module + session key executes capped spends from Safe. Most practical if contract-address MPC keys are hard.

## Safe integration (implemented)

Safe **v1.4.1** is integrated for deploy and test helpers. Bubble contracts stay on **Solidity 0.8.26**; Safe bytecode comes from **prebuilt npm artifacts** (not recompiled in this project — solc 0.7.6 stack-too-deep in Hardhat).

### Dependencies

| Package | Version | Purpose |
|---------|---------|---------|
| `@safe-global/safe-contracts` | 1.4.1 | Prebuilt `SafeL2`, `SafeProxyFactory` artifacts |
| `@safe-global/safe-deployments` | 1.37.62 | Canonical addresses on public networks |

`.npmrc` sets `legacy-peer-deps=true` (Safe package peers ethers v5; this project uses ethers v6).

### Key files

```
scripts/safe/
  safe-artifacts.ts       # Load bytecode from node_modules/@safe-global/safe-contracts
  safe-core.ts            # getOrDeploySafeInfrastructure(), deploySafeWallet(), encodeSafeSetup()
  deployments-io.ts       # Read/write scripts/deployments/safe/*.json
  deploy-infrastructure.ts
  create-wallet.ts

test/helpers/safeHelpers.ts              # Re-exports safe-core for tests
test/integration/safe-infrastructure.test.ts
```

### Deploy behavior

- **Kurtosis (50505070) / Hardhat:** deploys fresh `SafeL2` + `SafeProxyFactory` locally (`source: "local"`).
- **Public networks with canonical Safe:** reuses on-chain addresses if bytecode exists (`source: "canonical"`).
- **Wallet creation:** `SafeProxyFactory.createProxyWithNonce(singleton, setupData, saltNonce)` → 1-of-N proxy.

Canonical SafeL2 on many networks (including XDC chain 50): `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`

### Commands

See `README.md` for `test:safe*`, deploy, and `link:safe` scripts. Deployment JSON: `scripts/deployments/safe/{network}-*.json`.

## Bubble test infrastructure

- **Network:** Kurtosis `50505070` — `https://kurtosis.node.sodalabs.net`
- **Proxy:** `PROXY_URL` (default `https://proxy.bubble.sodalabs.net`) for MPC keys and decryption
- **Env:** `MNEMONIC` required for live-network tests
- **Main test:** `test/privateERC20Contract256.test.ts`
- **Helpers:** `test/helpers/testHelpers.ts`, `test/helpers/bubbleCryptoTransport.ts`

Hardhat config: Solidity 0.8.26, optimizer on, `viaIR`, `evmVersion: cancun`.

## XDC AI reference (external, for comparison)

XDC AI uses Safe v1.4.1 as user smart wallets with Allowance Module for session-key spending caps. Example deployed proxy: `0x26A19aF0481ef1fD09A2767DCbe7e5d746c6C251` (SafeProxy → SafeL2 singleton). Not part of this repo; useful reference for module-based agent spending.

## Open tasks (suggested next steps)

1. **Module path:** Allowance Module + session key for capped agent spends (XDC AI pattern).
2. **Reuse Safe:** set `SAFE_ADDRESS` env to skip wallet creation on repeat runs.
3. **Issuer unlinkability:** `y_clear` on `OPRFTokenInvalidated` still lets a note issuer find the spend tx (see anonymous use case).

### Bubble smart-account crypto model (no contract key onboarding)

- Onboard **EOA** only; balances live on Safe/SA address.
- **Insert:** when `tx.origin != it.userAddress`, `GCHandler.ValidateCiphertext` checks `GCACL.isFullInsertPermitted(userAddress, msg.sender)`. `msg.sender` is the app contract (PrivateERC20), **not** the gas-paying relayer. On Arbitrum Sepolia the handler does **not** consult `isContractInsertPermitted`; granting insert to a facilitator EOA is a no-op. The IT owner must call `GCACL.permitFullInsertAccess(privateTokenAddress, expiration)`.
- **View:** Safe grants view to EOA (`GCACL.permit(handle, eoa)` via Safe `execTransaction`, or `permitFullViewAccess`).
- **Decrypt:** `decryptValueViaProxy(handle, eoa, key, proxy, owner=Safe)` — already in `bubbleCryptoTransport.ts` / `decryptHandleForOwnerViaProxy`.
- Reference: bubble `GCHandler.ValidateCiphertext`, `run_private_erc20.py` (soda-contracts examples).

### Anonymous OPRF use case (issuer ↛ spender)

OPRF notes are **bearer instruments**. Anonymity means a chain observer must not see an address edge from the issuer (Safe) to the user (agent). Named on-chain send (`splitTokenForRecipient`) is a different product: it emits `OPRFSplitForRecipient(safe, agent, …)` and **does** link them.

Canonical flow:

1. **Anonymize (issuer):** Safe `shield` + `mintOPRFToken`. Events mention the Safe only. Handles `(x, y, q)` are permitted to the Safe.
2. **Handoff (off-chain):** issuer decrypts plaintext `(x, y, q)` and gives those values to the agent out of band. No `splitTokenForRecipient`, no private `transfer`.
3. **Spend (user + facilitator):** agent encrypts ITs as `userAddress = agent` and grants `GCACL.permitFullInsertAccess(token)`. Facilitator submits `redeemManyToUnderlying` / `burnToken`. `tx.origin` is the facilitator; dest lock pays the agent; remainder is credited to the agent. Events on this tx must not mention the Safe.

What a public observer sees: `OPRFMinted(Safe, handles)` in one tx, later `Unshield(agent)` from a facilitator tx. No shared addresses. Mint `x`/`q` handles are not the spend handles (re-validated ITs).

Residual links (accepted unless a mixer/anonymity set is added):

- **`y_clear`** is still an input and is emitted on `OPRFTokenInvalidated`. Anyone who already knows `y` (the issuer) can find the spend tx, then see the agent as unshield recipient.
- **Amounts / timing** can correlate a mint with a later cash-out.
- Test harness ETH funding from the Safe owner to the agent is **not** part of the protocol.

### Facilitator threat model (prototype)

Bubble insert ACL **does not name a relayer**. After `permitFullInsertAccess(token)`, anyone who holds the agent's ITs can call token functions that `validateCiphertext` those ITs. Relayer identity is therefore not an access-control input.

What still holds:

- **Dest lock:** if `tx.origin != it.userAddress`, `recipient` must be the IT owner. A relayer cannot redirect private/underlying credit.
- **Remainder / decrypt rights:** OPRF remainder is permitted to `it.userAddress`, not `tx.origin`.
- **ERC20 transfer/approve:** still spend `msg.sender`'s balance/allowance, so an agent amount IT cannot drain the agent's private balance via `transfer` / `transferFrom` unless the agent also approved the caller.
- **Safe mint path:** `tx.origin == owner` skips insert ACL; `msg.sender == Safe` keeps remainder credit on the Safe.

What is weaker than a per-facilitator ACL (accepted for this prototype):

- **Anyone** with `(x, y, q)` / amount ITs can redeem/burn/split — not only a chosen facilitator. Possession of the note is spend authority.
- Unsigned ITs are **not bound to a function selector or nonce**. An amount IT built for `redeemManyToUnderlying` can be reused in other `validateCiphertext` entrypoints on the same token until the note is burned.
- A relayer (or mempool copier) can **skip, delay, or force cash-out to the agent**; they cannot steal to themselves.
- Dest lock uses `tx.origin`. If the IT owner is tricked into submitting the redeem themselves, they can choose any `recipient`.

## Related scripts (existing, pre-Safe integration)

| Script | Purpose |
|--------|---------|
| `deploy-upgradable-private-erc20.ts` | Deploy UUPS proxy; transfer ownership to `SAFE_ADDRESS` |
| `transfer-ownership-to-safe.ts` | Move proxy owner to existing Safe |
| `prepare-upgrade.ts` | Print Safe calldata for UUPS upgrade |

## Compiler / integration constraints

- Do **not** import Safe Solidity into Bubble contracts (0.8.26 vs 0.7.6).
- Do **not** copy Safe source files — use npm artifacts + optional sibling symlink.
- Integrate at **transaction/script layer** (`execTransaction`, modules) unless building a new 0.8.x adapter module under `contracts/safe/`.
