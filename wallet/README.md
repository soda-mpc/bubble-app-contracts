# Bubble wallet contracts

Hardhat project for private ERC20 contracts (UUPS upgradeable proxies) with MPC integration.

## Package manager

This project uses **npm** only (`package-lock.json`). Do not add `yarn.lock`; use `npm install` / `npm ci` in CI.

## Setup

```bash
cd wallet
npm install
# Configure .env (MNEMONIC, RPC keys, etc.)
npm run compile
npm test
```

## Dependency pinning

Packages that affect **compiled bytecode**, **storage layout**, **compiler output**, or the **upgrade toolchain** are **exact-pinned** (no `^` in `package.json`). Everything else uses caret ranges so dev/test tooling can receive patch updates.

| Package | Version | Why pinned |
| --- | --- | --- |
| `@openzeppelin/contracts` | 5.4.0 | Imported Solidity libraries; bytecode and proxy helpers |
| `@openzeppelin/contracts-upgradeable` | 5.4.0 | Upgradeable bases (`UUPSUpgradeable`, `Ownable2Step`, …) |
| `@openzeppelin/hardhat-upgrades` | 3.9.1 | `deployProxy`, `prepareUpgrade`, storage validation |
| `solc` | 0.8.26 | Must match `hardhat.config.ts` `solidity.version` and contract `pragma solidity ^0.8.26` |
| `hardhat` | 2.27.1 | Compile/deploy/test runner |
| `soda-sdk` | (see `package.json`) | MPC/crypto integration used in scripts and tests |
| `@sodalabs/bubble-core-contracts` | git ref `update-contracts-version` | Shared on-chain primitives (commit resolved in lockfile) |
| `@safe-global/safe-contracts` | 1.4.1 | Prebuilt Safe v1.4.1 artifacts for deploy/test helpers |
| `@safe-global/safe-deployments` | 1.37.62 | Canonical Safe addresses on public networks |

When bumping any pinned package, re-run `npm install`, `npm run compile`, and the full test suite. For OpenZeppelin contract bumps, run `prepare-upgrade` / storage checks against live proxy addresses before mainnet Safe transactions.

`@openzeppelin/hardhat-upgrades` 3.x is the OpenZeppelin Contracts **v5** upgrades plugin line; it validates upgrades against the pinned `@openzeppelin/contracts*` versions in this project, not a separate OZ peer dependency.

## Common scripts

| Script | Purpose |
| --- | --- |
| `npm run compile` | Compile contracts |
| `npm test` | Run Hardhat tests |
| `npm run deploy:upgradable:base-sepolia` | Deploy UUPS proxy (Base Sepolia) |
| `npm run prepare-upgrade:base-sepolia` | Print Safe calldata for an upgrade |
| `npm run deploy:safe-infrastructure:kurtosis` | Deploy (or resolve canonical) SafeL2 + factory |
| `npm run deploy:safe-wallet:kurtosis` | Create a Safe proxy wallet on Kurtosis |
| `npm run test:safe` | Safe compile + local wallet integration tests |
| `npm run test:safe:bubble:arbitrum-sepolia` | Safe + PrivateERC20 E2E on Arbitrum Sepolia (live MPC) |
| `npm run test:safe:oprf-facilitator:arbitrum-sepolia` | User + Safe + agent + in-process facilitator OPRF redeem on Arbitrum Sepolia |
| `npm run test:safe:oprf-facilitator-service:arbitrum-sepolia` | Same flow via HTTP facilitator (`FACILITATOR_URL`, default `http://localhost:8002`) |
| `npm run test:gasless:arbitrum-sepolia` | Gasless + original smoke: EIP-712 execute, dest lock, signed redeem, original `msg.sender` mint |
| `npm run test:oprf:arbitrum-sepolia` | Full original `PrivateERC20Contract256` OPRF suite on Arbitrum Sepolia |

Original `PrivateERC20Contract256` is also covered by `privateERC20Contract256.test.ts` and `test:safe:bubble:arbitrum-sepolia`. Gasless facilitator e2e: `test:safe:oprf-facilitator:arbitrum-sepolia`.

## Safe smart account (v1.4.1)

Deploy/test helpers use **prebuilt artifacts** from `@safe-global/safe-contracts@1.4.1` (avoids recompiling Safe with solc 0.7.6 in this project). Canonical addresses on public networks come from `@safe-global/safe-deployments`. For reading or patching Safe source, use the sibling repo [`safe-smart-account`](../../safe-smart-account) (`npm run link:safe` optional).

Deployment records are written to `scripts/deployments/safe/`. On networks with canonical Safe deployments (e.g. Base Sepolia), scripts reuse on-chain addresses; on Kurtosis they deploy fresh infrastructure.

See `package.json` for network-specific deploy, verify, and balance scripts.

Agent UI (other repo): [`docs/FE-AGENT-WORKFLOW.md`](docs/FE-AGENT-WORKFLOW.md).
