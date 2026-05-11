# Contract verification

Before verifying: ensure **GCACLAddress.sol** and **GCHandlerAddress.sol** use the correct addresses for the target network.

## Verify contracts from setup-environment deployment

After running `setup-environment.ts`, save the JSON output to `deployment.json` (in the repo root, e.g. `bubble/` when run from `bubble/`), then run:

```bash
npx hardhat compile
npx hardhat run scripts/verify-contracts.ts --network sepolia-arbitrum
```

Optional: use a custom path via env:

```bash
DEPLOYMENT_JSON=./my-deployment.json npx hardhat run scripts/verify-contracts.ts --network sepolia-arbitrum
```

The script verifies:

- TUSDC (test token)
- PrivateERC20WithRestrictionList256 (implementation)
- PrivateERC20WithRestrictionListFactory256 (factory)
- RestrictionListRegistryFactory

The private token (proxy) is an ERC1967Proxy; the implementation is verified by the script. The proxy can be verified separately with constructor args `(implementation, initData)` if needed.

## Manual verification (single contract)

```bash
npx hardhat compile
npx hardhat verify --network "sepolia-arbitrum" <CONTRACT_ADDRESS>

# With constructor arguments (use arguments.js for complex args):
npx hardhat verify --network sepolia-arbitrum --constructor-args arguments.js <CONTRACT_ADDRESS>
```

# working example
# DEPLOYMENT_JSON=./scripts/deployment.json  npx hardhat run scripts/verify-contracts.ts --network polygon