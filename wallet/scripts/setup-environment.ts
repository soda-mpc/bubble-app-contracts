import { ethers } from "hardhat";
import { deployContractWithSizeInfo } from "./deploy-utils";
import { DeploymentResult } from "./deployment-types";
import { getDeploymentFilePath, saveDeploymentResult } from "./deployment-io";

async function main(): Promise<DeploymentResult> {
  console.log("\n╔════════════════════════════════════════════════════════════╗");
  console.log("║          ENVIRONMENT SETUP - FULL DEPLOYMENT               ║");
  console.log("╚════════════════════════════════════════════════════════════╝\n");

  // Get the deployer account
  const [deployer] = await ethers.getSigners();
  console.log(`🔑 Deployer: ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`💰 Balance: ${ethers.formatEther(balance)} ETH\n`);

  // ═══════════════════════════════════════════════════════════════
  // STEP 1: Deploy Test Token (TUSDC)
  // ═══════════════════════════════════════════════════════════════
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📦 STEP 1: Deploying Test Token (TUSDC)...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const tokenName = "Test USDC";
  const tokenSymbol = "TUSDC";
  const tokenDecimals = 18;

  const configuredTusdcAddress = process.env.TUSDC_ADDRESS?.trim();
  let tusdcAddress: string;
  let tusdcBlockNumber: number;

  if (configuredTusdcAddress) {
    tusdcAddress = configuredTusdcAddress;
    tusdcBlockNumber = 0;
    console.log(`   ⏭️  Using existing TUSDC at: ${tusdcAddress}\n`);
  } else {
    const deployedTusdc = await deployContractWithSizeInfo("TUSDC", [tokenName, tokenSymbol]);
    tusdcAddress = deployedTusdc.address;
    tusdcBlockNumber = deployedTusdc.blockNumber;
    console.log(`   ✅ TUSDC deployed at: ${tusdcAddress}`);
    console.log(`   📦 Block number: ${tusdcBlockNumber}\n`);
  }

  // ═══════════════════════════════════════════════════════════════
  // STEP 2: Deploy PrivateERC20WithRestrictionList256 Implementation
  // ═══════════════════════════════════════════════════════════════
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📦 STEP 2: Deploying PrivateERC20WithRestrictionList256 Implementation...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const { address: privateERC20ImplAddress, blockNumber: privateERC20ImplBlockNumber } =
    await deployContractWithSizeInfo("PrivateERC20WithRestrictionList256", []);
  console.log(`   ✅ Implementation deployed at: ${privateERC20ImplAddress}`);
  console.log(`   📦 Block number: ${privateERC20ImplBlockNumber}\n`);

  // ═══════════════════════════════════════════════════════════════
  // STEP 3: Deploy PrivateERC20WithRestrictionListFactory256
  // ═══════════════════════════════════════════════════════════════
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📦 STEP 3: Deploying PrivateERC20WithRestrictionListFactory256...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const {
    contract: privateERC20Factory,
    address: privateERC20FactoryAddress,
    blockNumber: privateERC20FactoryBlockNumber,
  } = await deployContractWithSizeInfo(
    "PrivateERC20WithRestrictionListFactory256",
    [privateERC20ImplAddress]
  );
  console.log(`   ✅ Factory deployed at: ${privateERC20FactoryAddress}`);
  console.log(`   📦 Block number: ${privateERC20FactoryBlockNumber}\n`);

  // ═══════════════════════════════════════════════════════════════
  // STEP 4: Deploy RestrictionListRegistryFactory
  // ═══════════════════════════════════════════════════════════════
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📦 STEP 4: Deploying RestrictionListRegistryFactory...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const {
    address: restrictionListFactoryAddress,
    blockNumber: restrictionListFactoryBlockNumber,
  } = await deployContractWithSizeInfo("RestrictionListRegistryFactory", []);
  console.log(`   ✅ Factory deployed at: ${restrictionListFactoryAddress}`);
  console.log(`   📦 Block number: ${restrictionListFactoryBlockNumber}\n`);

  // ═══════════════════════════════════════════════════════════════
  // STEP 5: Create Private Token via Factory
  // ═══════════════════════════════════════════════════════════════
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📦 STEP 5: Creating Private Token via Factory...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const privateTokenName = "Private TUSDC";
  const privateTokenSymbol = "pTUSDC";
  const emptyRestrictionLists: string[] = []; // No restriction lists for now

  // @ts-ignore - TypeScript types may be stale
  const createTokenTx = await privateERC20Factory.createToken(
    privateTokenName,
    privateTokenSymbol,
    tusdcAddress,
    emptyRestrictionLists
  );
  const createTokenReceipt = await createTokenTx.wait(1);
  const privateTokenBlockNumber = createTokenReceipt?.blockNumber || 0;
  
  // Extract the token address from the TokenCreated event
  let privateTokenAddress = "";
  if (createTokenReceipt?.logs) {
    for (const log of createTokenReceipt.logs) {
      try {
        const parsed = privateERC20Factory.interface.parseLog({
          topics: log.topics as string[],
          data: log.data
        });
        if (parsed?.name === "TokenCreated") {
          privateTokenAddress = String(parsed.args.token);
          break;
        }
      } catch {
        // Not our event, continue
      }
    }
  }
  
  if (!privateTokenAddress) {
    throw new Error("Failed to extract private token address from event");
  }

  if (privateTokenAddress.toLowerCase() === privateERC20ImplAddress.toLowerCase()) {
    throw new Error(
      "Private token address matches implementation address; TokenCreated event parsing failed"
    );
  }
  
  console.log(`   ✅ Private Token created at: ${privateTokenAddress}`);
  console.log(`   📋 Name: ${privateTokenName}`);
  console.log(`   📋 Symbol: ${privateTokenSymbol}`);
  console.log(`   📋 Underlying: ${tusdcAddress}`);
  console.log(`   📦 Block number: ${privateTokenBlockNumber}\n`);

  // ═══════════════════════════════════════════════════════════════
  // SUMMARY
  // ═══════════════════════════════════════════════════════════════
  console.log("\n╔════════════════════════════════════════════════════════════════════╗");
  console.log("║                       DEPLOYMENT SUMMARY                            ║");
  console.log("╠════════════════════════════════════════════════════════════════════╣");
  console.log("║ Test Token (TUSDC):                                                ║");
  console.log(`║   ${tusdcAddress}                      ║`);
  console.log(`║   Block: ${tusdcBlockNumber}                                                    ║`);
  console.log("╠════════════════════════════════════════════════════════════════════╣");
  console.log("║ PrivateERC20WithRestrictionList256:                                ║");
  console.log(`║   Implementation: ${privateERC20ImplAddress}      ║`);
  console.log(`║   Implementation Block: ${privateERC20ImplBlockNumber}                              ║`);
  console.log(`║   Factory:        ${privateERC20FactoryAddress}      ║`);
  console.log(`║   Factory Block:  ${privateERC20FactoryBlockNumber}                              ║`);
  console.log("╠════════════════════════════════════════════════════════════════════╣");
  console.log("║ RestrictionListRegistryFactory:                                    ║");
  console.log(`║   ${restrictionListFactoryAddress}                      ║`);
  console.log(`║   Block: ${restrictionListFactoryBlockNumber}                                                    ║`);
  console.log("╠════════════════════════════════════════════════════════════════════╣");
  console.log("║ Private Token (pTUSDC):                                            ║");
  console.log(`║   ${privateTokenAddress}                      ║`);
  console.log(`║   Block: ${privateTokenBlockNumber}                                                    ║`);
  console.log("╚════════════════════════════════════════════════════════════════════╝\n");

  const network = await ethers.provider.getNetwork();
  const networkName = process.env.HARDHAT_NETWORK ?? "unknown";

  // Print as JSON for easy copy-paste
  console.log("📋 JSON Output (for configuration):");
  const result: DeploymentResult = {
    network: networkName,
    chainId: Number(network.chainId),
    deployedAt: new Date().toISOString(),
    testToken: {
      address: tusdcAddress,
      name: tokenName,
      symbol: tokenSymbol,
      decimals: tokenDecimals,
      blockNumber: tusdcBlockNumber,
    },
    privateERC20WithRestrictionList: {
      implementation: privateERC20ImplAddress,
      implementationBlockNumber: privateERC20ImplBlockNumber,
      factory: privateERC20FactoryAddress,
      factoryBlockNumber: privateERC20FactoryBlockNumber,
    },
    restrictionListRegistryFactory: {
      address: restrictionListFactoryAddress,
      blockNumber: restrictionListFactoryBlockNumber,
    },
    privateToken: {
      address: privateTokenAddress,
      name: privateTokenName,
      symbol: privateTokenSymbol,
      underlying: tusdcAddress,
      blockNumber: privateTokenBlockNumber,
    },
  };
  console.log(JSON.stringify(result, null, 2));

  const outputPath =
    process.env.DEPLOYMENT_OUT_PATH?.trim() || getDeploymentFilePath(networkName);
  saveDeploymentResult(result, networkName, outputPath);
  console.log(`\n💾 Deployment saved to: ${outputPath}`);
  console.log("   Each network writes its own file and no longer overwrites other chains.\n");

  return result;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  });
