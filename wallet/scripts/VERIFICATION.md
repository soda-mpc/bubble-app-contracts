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

Other scripts add their own sections to the same file and keep the rest:

```bash
npm run deploy:gasless-factory:arbitrum-sepolia                                         # gaslessFactory
RECORD_AS=gaslessTestToken npx hardhat run scripts/deploy-tusdc.ts --network sepolia-arbitrum   # gaslessTestToken
```

The verify script checks each section that is present:

- `testToken`: TUSDC (test token)
- `privateERC20WithRestrictionList`: PrivateERC20WithRestrictionList256 (implementation) and PrivateERC20WithRestrictionListFactory256 (factory)
- `restrictionListRegistryFactory`: RestrictionListRegistryFactory
- `gaslessTestToken`: TUSDC (gasless test token)
- `gaslessFactory`: PrivateOPRFNotes (library), PrivateERC20Contract256Gasless (implementation, verified with `libraries` set to the recorded library address) and PrivateERC20GaslessFactory

The private token (proxy) is an ERC1967Proxy; verify the implementation first. The proxy can be verified separately with constructor args `(implementation, initData)` if needed.

## Manual verification (single contract)

```bash
npx hardhat compile
npx hardhat verify --network polygon <CONTRACT_ADDRESS>
```
