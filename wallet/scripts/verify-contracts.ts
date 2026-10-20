/**
 * Verify recorded contracts on block explorers (Etherscan, etc.): the setup-environment.ts sections, and the gasless
 * sections from deploy-private-erc20-gasless-factory.ts and `RECORD_AS=gaslessTestToken` deploy-tusdc.ts. Only the
 * sections present in the file are checked.
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
import { DeploymentRecord } from "./deployment-types";
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

function validateDeployment(json: DeploymentRecord, networkName: string): void {
  const base = json.testToken || json.privateERC20WithRestrictionList || json.restrictionListRegistryFactory;
  if (!base && !json.gaslessFactory && !json.gaslessTestToken) {
    throw new Error("Invalid deployment JSON: no recorded contracts");
  }

  if (json.testToken) assertAddress(json.testToken.address, "testToken.address");
  if (json.privateERC20WithRestrictionList) {
    assertAddress(json.privateERC20WithRestrictionList.implementation, "privateERC20WithRestrictionList.implementation");
    assertAddress(json.privateERC20WithRestrictionList.factory, "privateERC20WithRestrictionList.factory");
  }
  if (json.restrictionListRegistryFactory) {
    assertAddress(json.restrictionListRegistryFactory.address, "restrictionListRegistryFactory.address");
  }
  if (json.privateToken) {
    assertAddress(json.privateToken.address, "privateToken.address");
    assertAddress(json.privateToken.underlying, "privateToken.underlying");
    if (
      json.privateERC20WithRestrictionList &&
      json.privateToken.address.toLowerCase() === json.privateERC20WithRestrictionList.implementation.toLowerCase()
    ) {
      throw new Error(
        "Deployment JSON looks corrupted: privateToken.address equals implementation address. Re-run setup-environment.ts for this network."
      );
    }
  }
  if (json.gaslessFactory) {
    assertAddress(json.gaslessFactory.library, "gaslessFactory.library");
    assertAddress(json.gaslessFactory.implementation, "gaslessFactory.implementation");
    assertAddress(json.gaslessFactory.factory, "gaslessFactory.factory");
  }
  if (json.gaslessTestToken) assertAddress(json.gaslessTestToken.address, "gaslessTestToken.address");

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
  contract?: string,
  libraries?: Record<string, string>
): Promise<boolean> {
  try {
    const params: {
      address: string;
      constructorArguments: unknown[];
      contract?: string;
      libraries?: Record<string, string>;
    } = {
      address,
      constructorArguments,
    };
    if (contract) params.contract = contract;
    if (libraries) params.libraries = libraries;
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

  const targets: Array<{
    name: string;
    address: string;
    constructorArguments?: unknown[];
    contract?: string;
    libraries?: Record<string, string>;
  }> = [];
  if (deployment.testToken) {
    targets.push({
      name: "TUSDC (Test Token)",
      address: deployment.testToken.address,
      constructorArguments: [deployment.testToken.name, deployment.testToken.symbol],
      contract: "contracts/TUSDC.sol:TUSDC",
    });
  }
  if (deployment.privateERC20WithRestrictionList) {
    targets.push(
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
      }
    );
  }
  if (deployment.restrictionListRegistryFactory) {
    targets.push({
      name: "RestrictionListRegistryFactory",
      address: deployment.restrictionListRegistryFactory.address,
      constructorArguments: [],
      contract: "contracts/with-restrictions/RestrictionListRegistryFactory.sol:RestrictionListRegistryFactory",
    });
  }

  if (deployment.gaslessTestToken) {
    targets.push({
      name: "TUSDC (gasless test token)",
      address: deployment.gaslessTestToken.address,
      constructorArguments: [deployment.gaslessTestToken.name, deployment.gaslessTestToken.symbol],
      contract: "contracts/TUSDC.sol:TUSDC",
    });
  }
  if (deployment.gaslessFactory) {
    targets.push(
      {
        name: "PrivateOPRFNotes (Library)",
        address: deployment.gaslessFactory.library,
        constructorArguments: [],
        contract: "contracts/libraries/PrivateOPRFNotes.sol:PrivateOPRFNotes",
      },
      {
        name: "PrivateERC20Contract256Gasless (Implementation)",
        address: deployment.gaslessFactory.implementation,
        constructorArguments: [],
        contract: "contracts/PrivateERC20Contract256Gasless.sol:PrivateERC20Contract256Gasless",
        libraries: {
          "contracts/libraries/PrivateOPRFNotes.sol:PrivateOPRFNotes": deployment.gaslessFactory.library,
        },
      },
      {
        name: "PrivateERC20GaslessFactory",
        address: deployment.gaslessFactory.factory,
        constructorArguments: [deployment.gaslessFactory.implementation],
        contract: "contracts/PrivateERC20GaslessFactory.sol:PrivateERC20GaslessFactory",
      }
    );
  }

  let ok = 0;
  let fail = 0;
  for (const target of targets) {
    const result = await verify(
      target.name,
      target.address,
      target.constructorArguments ?? [],
      target.contract,
      target.libraries
    );
    result ? ok++ : fail++;
  }

  console.log("\n--- Summary ---");
  console.log(`Verified or already verified: ${ok}`);
  if (fail > 0) console.log(`Failed: ${fail}`);
  if (deployment.privateToken) {
    console.log("\nNote: The private token (proxy) at", deployment.privateToken.address, "is an ERC1967Proxy.");
    console.log("      Verify the implementation above; the proxy can be verified separately with constructor args (implementation, initData) if needed.\n");
  }

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
