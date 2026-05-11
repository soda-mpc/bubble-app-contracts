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
import { ethers, run } from "hardhat";
import { DeploymentResult } from "./deployment-types";

function parseDeploymentPathArg(): string | undefined {
  const maybePath = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  return maybePath;
}

function assertAddress(value: string, field: string): void {
  if (!ethers.isAddress(value)) {
    throw new Error(`Invalid address for ${field}: ${value}`);
  }
}

function validateDeployment(json: DeploymentResult): void {
  if (!json?.testToken?.address || !json?.privateERC20WithRestrictionList?.implementation) {
    throw new Error("Invalid deployment JSON: missing testToken or privateERC20WithRestrictionList");
  }

  assertAddress(json.testToken.address, "testToken.address");
  assertAddress(json.privateERC20WithRestrictionList.implementation, "privateERC20WithRestrictionList.implementation");
  assertAddress(json.privateERC20WithRestrictionList.factory, "privateERC20WithRestrictionList.factory");
  assertAddress(json.restrictionListRegistryFactory.address, "restrictionListRegistryFactory.address");
  assertAddress(json.privateToken.address, "privateToken.address");
  assertAddress(json.privateToken.underlying, "privateToken.underlying");
}

function loadDeployment(filePath: string): DeploymentResult {
  const resolved = path.isAbsolute(filePath) ? filePath : path.resolve(process.cwd(), filePath);
  const raw = fs.readFileSync(resolved, "utf-8");
  const json = JSON.parse(raw) as DeploymentResult;
  validateDeployment(json);
  return json;
}

async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries = 2,
  baseDelayMs = 1500
): Promise<T> {
  let lastError: unknown;
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (attempt === maxRetries) break;
      const delay = baseDelayMs * 2 ** attempt;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  throw lastError;
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
    await retryWithBackoff(() => run("verify:verify", params));
    console.log(`   ${name} verified: ${address}`);
    return true;
  } catch (e: unknown) {
    const err = e as { message?: string };
    if (err.message?.includes("Already Verified")) {
      console.log(`   ${name} already verified: ${address}`);
      return true;
    }
    console.error(`   ${name} failed: ${address}`);
    console.error(`      ${err.message ?? e}`);
    return false;
  }
}

async function main(): Promise<number> {
  // Hardhat run can pass extra args after script path; support env or positional arg.
  const pathArg = parseDeploymentPathArg();
  const jsonPath =
    pathArg ||
    process.env.DEPLOYMENT_JSON ||
    path.join(process.cwd(), "deployment.json");

  if (!fs.existsSync(jsonPath)) {
    console.error("Usage: npx hardhat run scripts/verify-contracts.ts --network <network> [deployment.json]");
    console.error("       (optional) DEPLOYMENT_JSON=/path/to/deployment.json if no positional arg");
    console.error("Missing deployment file:", jsonPath);
    console.error("Run setup-environment.ts, save the JSON output to deployment.json (or set DEPLOYMENT_JSON), then re-run.");
    return 1;
  }

  const deployment = loadDeployment(jsonPath);
  const networkName = process.env.HARDHAT_NETWORK ?? "unknown";

  console.log("\n=== Contract Verification ===\n");
  console.log(`Network: ${networkName}`);
  console.log(`Deployment file: ${jsonPath}\n`);

  const targets: Array<{ name: string; address: string; constructorArguments?: unknown[]; contract?: string }> = [
    {
      name: "TUSDC (Test Token)",
      address: deployment.testToken.address,
      constructorArguments: [deployment.testToken.name, deployment.testToken.symbol],
    },
    {
      name: "PrivateERC20WithRestrictionList256 (Implementation)",
      address: deployment.privateERC20WithRestrictionList.implementation,
      constructorArguments: [],
    },
    {
      name: "PrivateERC20WithRestrictionListFactory256 (Factory)",
      address: deployment.privateERC20WithRestrictionList.factory,
      constructorArguments: [deployment.privateERC20WithRestrictionList.implementation],
    },
    {
      name: "RestrictionListRegistryFactory",
      address: deployment.restrictionListRegistryFactory.address,
      constructorArguments: [],
    },
  ];

  let ok = 0;
  let fail = 0;
  for (const target of targets) {
    const result = await verify(target.name, target.address, target.constructorArguments ?? [], target.contract);
    result ? ok++ : fail++;
  }

  console.log("\n--- Summary ---");
  console.log(`Verified or already verified: ${ok}`);
  if (fail > 0) console.log(`Failed: ${fail}`);
  console.log("\nNote: The private token (proxy) at", deployment.privateToken.address, "is an ERC1967Proxy.");
  console.log("      Verify the implementation above; the proxy can be verified separately with constructor args (implementation, initData) if needed.\n");

  return fail > 0 ? 1 : 0;
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
}).then((code) => {
  if (typeof code === "number") {
    process.exit(code);
  }
});
