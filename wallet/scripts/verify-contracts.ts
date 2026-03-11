/**
 * Verify contracts deployed by setup-environment.ts on block explorers (Etherscan, etc.).
 *
 * Usage:
 *   npx hardhat run scripts/verify-contracts.ts --network <network> [deployment.json]
 *
 * If no file is given, reads from deployment.json in the script directory.
 * You can save the JSON output from setup-environment.ts to a file and pass it:
 *
 *   npx hardhat run scripts/setup-environment.ts --network sepolia-arbitrum | tee deployment.json
 *   # Edit deployment.json to keep only the JSON object, then:
 *   npx hardhat run scripts/verify-contracts.ts --network sepolia-arbitrum deployment.json
 *
 * Prerequisites (from VERIFICATION.md):
 *   - GCACLAddress.sol and GCHandlerAddress.sol use correct addresses for the network
 *   - npx hardhat compile
 */

import * as fs from "fs";
import * as path from "path";
import { run } from "hardhat";

interface DeploymentResult {
  testToken: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    blockNumber: number;
  };
  privateERC20WithRestrictionList: {
    implementation: string;
    implementationBlockNumber: number;
    factory: string;
    factoryBlockNumber: number;
  };
  restrictionListRegistryFactory: {
    address: string;
    blockNumber: number;
  };
  privateToken: {
    address: string;
    name: string;
    symbol: string;
    underlying: string;
    blockNumber: number;
  };
}

function loadDeployment(filePath: string): DeploymentResult {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(resolved, "utf-8");
  const json = JSON.parse(raw) as DeploymentResult;
  if (!json?.testToken?.address || !json?.privateERC20WithRestrictionList?.implementation) {
    throw new Error("Invalid deployment JSON: missing testToken or privateERC20WithRestrictionList");
  }
  return json;
}

async function verify(
  name: string,
  address: string,
  constructorArguments: unknown[] = [],
  contract?: string
): Promise<boolean> {
  try {
    const params: { address: string; constructorArguments: unknown[]; contract?: string } = {
      address,
      constructorArguments,
    };
    if (contract) params.contract = contract;
    await run("verify:verify", params);
    console.log(`   ✅ ${name} verified: ${address}`);
    return true;
  } catch (e: unknown) {
    const err = e as { message?: string };
    if (err.message?.includes("Already Verified")) {
      console.log(`   ⏭️  ${name} already verified: ${address}`);
      return true;
    }
    console.error(`   ❌ ${name} failed: ${address}`);
    console.error(`      ${err.message ?? e}`);
    return false;
  }
}

async function main() {
  // Hardhat run doesn't pass extra args to scripts; use DEPLOYMENT_JSON env or default path
  const jsonPath =
    process.env.DEPLOYMENT_JSON ||
    path.join(process.cwd(), "deployment.json");

  if (!fs.existsSync(jsonPath)) {
    console.error("Usage: npx hardhat run scripts/verify-contracts.ts --network <network>");
    console.error("       (optional) DEPLOYMENT_JSON=/path/to/deployment.json");
    console.error("Missing deployment file:", jsonPath);
    console.error("Run setup-environment.ts, save the JSON output to deployment.json (or set DEPLOYMENT_JSON), then re-run.");
    process.exit(1);
  }

  const deployment = loadDeployment(jsonPath);
  const network = process.env.HARDHAT_NETWORK ?? "unknown";

  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║          CONTRACT VERIFICATION                             ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");
  console.log(`Network: ${network}`);
  console.log(`Deployment file: ${jsonPath}\n`);

  let ok = 0;
  let fail = 0;

  // 1. TUSDC — constructor(string name, string symbol)
  const r1 = await verify(
    "TUSDC (Test Token)",
    deployment.testToken.address,
    [deployment.testToken.name, deployment.testToken.symbol]
  );
  r1 ? ok++ : fail++;

  // 2. PrivateERC20WithRestrictionList256 implementation — no args
  const r2 = await verify(
    "PrivateERC20WithRestrictionList256 (Implementation)",
    deployment.privateERC20WithRestrictionList.implementation,
    []
  );
  r2 ? ok++ : fail++;

  // 3. PrivateERC20WithRestrictionListFactory256 — constructor(address implementation_)
  const r3 = await verify(
    "PrivateERC20WithRestrictionListFactory256 (Factory)",
    deployment.privateERC20WithRestrictionList.factory,
    [deployment.privateERC20WithRestrictionList.implementation]
  );
  r3 ? ok++ : fail++;

  // 4. RestrictionListRegistryFactory — no constructor args
  const r4 = await verify(
    "RestrictionListRegistryFactory",
    deployment.restrictionListRegistryFactory.address,
    []
  );
  r4 ? ok++ : fail++;

  console.log("\n--- Summary ---");
  console.log(`Verified or already verified: ${ok}`);
  if (fail > 0) console.log(`Failed: ${fail}`);
  console.log("\nNote: The private token (proxy) at", deployment.privateToken.address, "is an ERC1967Proxy.");
  console.log("      Verify the implementation above; the proxy can be verified separately with constructor args (implementation, initData) if needed.\n");

  process.exit(fail > 0 ? 1 : 0);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
