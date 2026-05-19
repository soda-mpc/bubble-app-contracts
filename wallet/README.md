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
| `@sodalabs/bubble-core-contracts` | git ref `initial-version` | Shared on-chain primitives (commit resolved in lockfile) |

When bumping any pinned package, re-run `npm install`, `npm run compile`, and the full test suite. For OpenZeppelin contract bumps, run `prepare-upgrade` / storage checks against live proxy addresses before mainnet Safe transactions.

`@openzeppelin/hardhat-upgrades` 3.x is the OpenZeppelin Contracts **v5** upgrades plugin line; it validates upgrades against the pinned `@openzeppelin/contracts*` versions in this project, not a separate OZ peer dependency.

## Common scripts

| Script | Purpose |
| --- | --- |
| `npm run compile` | Compile contracts |
| `npm test` | Run Hardhat tests |
| `npm run deploy:upgradable:base-sepolia` | Deploy UUPS proxy (Base Sepolia) |
| `npm run prepare-upgrade:base-sepolia` | Print Safe calldata for an upgrade |

See `package.json` for network-specific deploy, verify, and balance scripts.
