# Contract verification

Before verifying: ensure **GCACLAddress.sol** and **GCHandlerAddress.sol** use the correct addresses for the target network.

## Verify contracts from setup-environment deployment

`setup-environment.ts` writes one file per network:

```text
scripts/deployments/<network>.json
```

Example:

```bash
npx hardhat compile
npx hardhat run scripts/setup-environment.ts --network polygon
npx hardhat run scripts/verify-contracts.ts --network polygon
```

Optional overrides:

```bash
DEPLOYMENT_JSON=./my-deployment.json npx hardhat run scripts/verify-contracts.ts --network polygon
DEPLOYMENT_OUT_PATH=./custom/path.json npx hardhat run scripts/setup-environment.ts --network ethereum
```

The verify script checks:

- TUSDC (test token)
- PrivateERC20WithRestrictionList256 (implementation)
- PrivateERC20WithRestrictionListFactory256 (factory)
- RestrictionListRegistryFactory

The private token (proxy) is an ERC1967Proxy; verify the implementation first. The proxy can be verified separately with constructor args `(implementation, initData)` if needed.

## Manual verification (single contract)

```bash
npx hardhat compile
npx hardhat verify --network polygon <CONTRACT_ADDRESS>
```
