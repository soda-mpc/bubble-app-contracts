# Hardhat tasks

## sync-gc-addresses

Syncs per-chain GC contract addresses into the root contract folder so that **compile** uses the correct addresses for the selected network. Address constants are baked into bytecode at compile time, so you must sync before compiling when targeting a live network.

### Per-chain layout

Store addresses for each chain under:

**`lib/onchain/contracts/<CHAIN>/`**

Example for Sepolia:

- `lib/onchain/contracts/SEPOLIA/GCDecryptionVerifierAddress.sol`
- `lib/onchain/contracts/SEPOLIA/GCACLAddress.sol`
- `lib/onchain/contracts/SEPOLIA/GCHandlerAddress.sol`

The task maps the **Hardhat network** (set with `--network <name>`) to the **chain folder** and overwrites the root files:

| Chain folder file                    | Root file (overwritten)                |
|--------------------------------------|----------------------------------------|
| `<CHAIN>/GCDecryptionVerifierAddress.sol` | `lib/onchain/contracts/GCDecryptionVerifierAddress.sol` |
| `<CHAIN>/GCACLAddress.sol`           | `lib/onchain/contracts/GCACLAddress.sol` |
| `<CHAIN>/GCHandlerAddress.sol`       | `lib/onchain/contracts/GCHandlerAddress.sol` |

### Network → chain folder mapping

Defined in `tasks/sync-gc-addresses.ts`:

| Hardhat `--network` | Chain folder   |
|--------------------|----------------|
| `sepolia`          | `SEPOLIA`      |
| `sepolia-base`     | `BASE-SEPOLIA` |
| `ethereum`         | `ETHEREUM`     |
| `kurtosis`         | `KURTOSIS`     |
| `sepolia-arbitrum` | `SEPOLIA-ARBITRUM` |
| `arbitrum`         | `ARBITRUM`     |
| `polygon`          | `POLYGON`      |
| …                  | (add more as needed) |

Use Hardhat’s **`--network`** flag; do not add a custom `network` param.

### When to use

- **Live networks:** Run sync (or `compile-for-network`) before compile when running tests or deploying to a network (e.g. Sepolia, Base Sepolia, Kurtosis).
- **Local Hardhat network:** Optional; if a chain folder is missing, placeholders are used where defined.

### Setting addresses

1. **Chain folder (recommended)**  
   Add the three address files under `lib/onchain/contracts/<CHAIN>/` for each chain. Then run:
   ```bash
   npx hardhat sync-gc-addresses --network sepolia
   npx hardhat compile
   ```

2. **Environment variables (override)**  
   If set, these override the chain folder for that file:
   - `GCDECRYPTION_VERIFIER_ADDRESS=0x...`
   - `GCACL_ADDRESS=0x...`
   - `GCHANDLER_ADDRESS=0x...`

### GCHandlerAddress.sol

Chain folders should define `GCHandlerAddress`. The task ensures the root file has `GCHandlerAddress` with a single SPDX/pragma block so compilation succeeds.

### Examples

```bash
# Sepolia: sync then compile then test
npx hardhat sync-gc-addresses --network sepolia
npx hardhat compile
npx hardhat test test/privateERC20Contract256.test.ts --network sepolia

# One-step sync + compile
npx hardhat compile-for-network --network sepolia
npx hardhat test test/privateERC20Contract256.test.ts --network sepolia

# Base Sepolia
npx hardhat compile-for-network --network sepolia-base
npx hardhat test test/privateERC20Contract256.test.ts --network sepolia-base

# Optional: override via env
GCDECRYPTION_VERIFIER_ADDRESS=0x... npx hardhat sync-gc-addresses --network sepolia
npx hardhat compile
```

### NPM scripts

- `npm run compile:sepolia-base` — sync + compile for Base Sepolia
- `npm run compile:kurtosis` — sync + compile for Kurtosis

Add more in `package.json` using the same pattern (e.g. `compile:sepolia`).

---

## compile-for-network

Runs **sync-gc-addresses** then **compile**. Use before tests or deploy on a live network.

```bash
npx hardhat compile-for-network --network sepolia
```

The network is taken from Hardhat’s `--network` flag only.
