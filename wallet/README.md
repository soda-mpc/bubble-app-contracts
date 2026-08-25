# Bubble wallet contracts

Hardhat project for private ERC20 contracts (UUPS upgradeable proxies) with MPC integration.

## Package manager

This project uses **npm** only (`package-lock.json`). Do not add `yarn.lock`; use `npm install` / `npm ci` in CI.

## Setup

```bash
cd wallet
npm install
npm run compile
npm test
```

`npm test` runs the unit tests against the local Hardhat network. The integration suites are
skipped there, because they need Bubble host contracts on the connected chain and a funded
account — the local network has no Bubble deployment.

## Try it end to end

```bash
MNEMONIC="..." npm run demo:live
```

Deploys a private ERC20, shields underlying tokens, transfers an amount that never appears in
calldata, and reads both balances back — each with its owner's own key. Defaults to Sepolia; for
another network use `npx hardhat run scripts/run-private-erc20-live.ts --network <name>`.

## Running the integration tests

They need two things:

- `MNEMONIC` — a funded account on the target chain, in `.env`
- a chain with a Bubble deployment: Ethereum (`1`), Polygon (`137`), Arbitrum (`42161`),
  Sepolia (`11155111`), Arbitrum Sepolia (`421614`)

```bash
MNEMONIC="..." npx hardhat test --network sepolia
```

The supported-chain list is read from the installed `BubbleAddresses.sol`, so it stays in step
with the Solidity library. On any other chain the integration suites report why they skipped.

## RPC endpoints

Public networks default to Alchemy and need `ALCHEMY_API_KEY`. To use a different endpoint, set
`<NETWORK>_RPC_URL`, where `<NETWORK>` is the Hardhat network name uppercased with hyphens as
underscores — `SEPOLIA_RPC_URL`, `SEPOLIA_ARBITRUM_RPC_URL`, `ARBITRUM_RPC_URL`,
`POLYGON_RPC_URL`, `ETHEREUM_RPC_URL`. That
takes precedence, so no Alchemy account is needed.

## Dependency pinning

Packages that affect **compiled bytecode**, **storage layout**, **compiler output**, or the **upgrade toolchain** are **exact-pinned** (no `^` in `package.json`). Everything else uses caret ranges so dev/test tooling can receive patch updates.

| Package | Version | Why pinned |
| --- | --- | --- |
| `@openzeppelin/contracts` | 5.4.0 | Imported Solidity libraries; bytecode and proxy helpers |
| `@openzeppelin/contracts-upgradeable` | 5.4.0 | Upgradeable bases (`UUPSUpgradeable`, `Ownable2Step`, …) |
| `@openzeppelin/hardhat-upgrades` | 3.9.1 | `deployProxy`, `prepareUpgrade`, storage validation |
| `solc` | 0.8.26 | Must match `hardhat.config.ts` `solidity.version` and contract `pragma solidity ^0.8.26` |
| `hardhat` | 2.27.1 | Compile/deploy/test runner |
| `soda-bubble-sdk` | 0.0.11 | MPC/crypto integration used in scripts and tests |
| `@sodalabs/bubble-core-contracts` | git ref `initial-version` | Shared on-chain primitives (commit resolved in lockfile) |

When bumping any pinned package, re-run `npm install`, `npm run compile`, and the full test suite. For OpenZeppelin contract bumps, run `prepare-upgrade` / storage checks against live proxy addresses before mainnet Safe transactions.

`@openzeppelin/hardhat-upgrades` 3.x is the OpenZeppelin Contracts **v5** upgrades plugin line; it validates upgrades against the pinned `@openzeppelin/contracts*` versions in this project, not a separate OZ peer dependency.

## Common scripts

| Script | Purpose |
| --- | --- |
| `npm run compile` | Compile contracts |
| `npm test` | Run Hardhat tests |

See `package.json` for network-specific deploy, verify, and balance scripts.
