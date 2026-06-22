/**
 * Verify contracts deployed by setup-environment.ts on block explorers (Etherscan, etc.).
 *
 * Usage:
 *   npx hardhat run scripts/verify-contracts.ts --network <network> [deployment.json]
 *
 * If no file is given, reads from scripts/deployments/<network>.json.
 *
 * Prerequisites (from VERIFICATION.md):
 *   - GCACLAddress.sol and GCHandlerAddress.sol use correct addresses for the network
 *   - npx hardhat compile
 */

import * as fs from "fs";
import { ethers, run } from "hardhat";
import { DeploymentResult } from "./deployment-types";
import { loadDeploymentResult, resolveDeploymentPath } from "./deployment-io";

function parseDeploymentPathArg(): string | undefined {
  const maybePath = process.argv.slice(2).find((arg) => !arg.startsWith("-"));
  return maybePath;
}

function assertAddress(value: string, field: string): void {
  if (!ethers.isAddress(value)) {
    throw new Error(`Invalid address for ${field}: ${value}`);
  }
}

function validateDeployment(json: DeploymentResult, networkName: string): void {
  if (!json?.testToken?.address || !json?.privateERC20WithRestrictionList?.implementation) {
    throw new Error("Invalid deployment JSON: missing testToken or privateERC20WithRestrictionList");
  }

  assertAddress(json.testToken.address, "testToken.address");
  assertAddress(json.privateERC20WithRestrictionList.implementation, "privateERC20WithRestrictionList.implementation");
  assertAddress(json.privateERC20WithRestrictionList.factory, "privateERC20WithRestrictionList.factory");
  assertAddress(json.restrictionListRegistryFactory.address, "restrictionListRegistryFactory.address");
  assertAddress(json.privateToken.address, "privateToken.address");
  assertAddress(json.privateToken.underlying, "privateToken.underlying");

  if (
    json.privateToken.address.toLowerCase() ===
    json.privateERC20WithRestrictionList.implementation.toLowerCase()
  ) {
    throw new Error(
      "Deployment JSON looks corrupted: privateToken.address equals implementation address. Re-run setup-environment.ts for this network."
    );
  }

  if (json.network && json.network !== networkName) {
    console.warn(
      `Warning: deployment file network (${json.network}) does not match --network (${networkName}).`
    );
  }
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
  const networkName = process.env.HARDHAT_NETWORK ?? "unknown";
  const jsonPath = resolveDeploymentPath(parseDeploymentPathArg(), networkName);

  if (!fs.existsSync(jsonPath)) {
    console.error("Usage: npx hardhat run scripts/verify-contracts.ts --network <network> [deployment.json]");
    console.error("       (optional) DEPLOYMENT_JSON=/path/to/deployment.json if no positional arg");
    console.error("Missing deployment file:", jsonPath);
    console.error("Run setup-environment.ts for this network first. It writes scripts/deployments/<network>.json.");
    return 1;
  }

  const deployment = loadDeploymentResult(jsonPath);
  validateDeployment(deployment, networkName);

  const { chainId } = await ethers.provider.getNetwork();
  if (deployment.chainId && Number(chainId) !== deployment.chainId) {
    throw new Error(
      `Deployment file chainId (${deployment.chainId}) does not match connected network (${chainId}).`
    );
  }

  console.log("\n=== Contract Verification ===\n");
  console.log(`Network: ${networkName}`);
  console.log(`Deployment file: ${jsonPath}`);
  if (deployment.deployedAt) {
    console.log(`Deployed at: ${deployment.deployedAt}`);
  }
  console.log("");

  const targets: Array<{ name: string; address: string; constructorArguments?: unknown[]; contract?: string }> = [
    {
      name: "TUSDC (Test Token)",
      address: deployment.testToken.address,
      constructorArguments: [deployment.testToken.name, deployment.testToken.symbol],
      contract: "contracts/TUSDC.sol:TUSDC",
    },
    {
      name: "PrivateERC20WithRestrictionList256 (Implementation)",
      address: deployment.privateERC20WithRestrictionList.implementation,
      constructorArguments: [],
      contract: "contracts/with-restrictions/PrivateERC20WithRestrictionList256.sol:PrivateERC20WithRestrictionList256",
    },
    {
      name: "PrivateERC20WithRestrictionListFactory256 (Factory)",
      address: deployment.privateERC20WithRestrictionList.factory,
      constructorArguments: [deployment.privateERC20WithRestrictionList.implementation],
      contract:
        "contracts/with-restrictions/PrivateERC20WithRestrictionListFactory256.sol:PrivateERC20WithRestrictionListFactory256",
    },
    {
      name: "RestrictionListRegistryFactory",
      address: deployment.restrictionListRegistryFactory.address,
      constructorArguments: [],
      contract: "contracts/with-restrictions/RestrictionListRegistryFactory.sol:RestrictionListRegistryFactory",
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

main()
  .catch((err) => {
    console.error(err);
    process.exit(1);
  })
  .then((code) => {
    if (typeof code === "number") {
      process.exit(code);
    }
  });
