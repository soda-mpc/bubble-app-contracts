import { artifacts, ethers } from "hardhat";
import { DeploymentResult } from "./deployment-types";

interface DeployedContractInfo {
  contract: any;
  address: string;
  blockNumber: number;
}

async function getContractSizeInfo(contractName: string) {
  const artifact = await artifacts.readArtifact(contractName);
  const initCodeBytes = Math.max(0, (artifact.bytecode.length - 2) / 2);
  const runtimeCodeBytes = Math.max(0, (artifact.deployedBytecode.length - 2) / 2);
  const codeDepositGas = runtimeCodeBytes * 200;
  const initCodeGas = Math.ceil(initCodeBytes / 32) * 2;

  return {
    initCodeBytes,
    runtimeCodeBytes,
    codeDepositGas,
    initCodeGas,
  };
}

async function waitForDeploymentAndBlock(contract: any): Promise<{ address: string; blockNumber: number }> {
  const deployTx = contract.deploymentTransaction();
  if (deployTx) {
    const receipt = await deployTx.wait(1);
    return {
      address: await contract.getAddress(),
      blockNumber: receipt?.blockNumber || 0,
    };
  }

  await contract.waitForDeployment();
  return {
    address: await contract.getAddress(),
    blockNumber: await ethers.provider.getBlockNumber(),
  };
}

async function deployWithSizeInfo(
  contractName: string,
  deployArgs: any[]
): Promise<DeployedContractInfo> {
  const sizeInfo = await getContractSizeInfo(contractName);
  console.log(
    `   Size: init ${sizeInfo.initCodeBytes} bytes, runtime ${sizeInfo.runtimeCodeBytes} bytes`
  );
  console.log(
    `   Est. gas: code deposit ${sizeInfo.codeDepositGas}, initcode ${sizeInfo.initCodeGas}`
  );

  const Factory = await ethers.getContractFactory(contractName);
  const contract = await Factory.deploy(...deployArgs);
  const { address, blockNumber } = await waitForDeploymentAndBlock(contract);
  return { contract, address, blockNumber };
}

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

  const { address: tusdcAddress, blockNumber: tusdcBlockNumber } = await deployWithSizeInfo(
    "TUSDC",
    [tokenName, tokenSymbol]
  );
  console.log(`   ✅ TUSDC deployed at: ${tusdcAddress}`);
  console.log(`   📦 Block number: ${tusdcBlockNumber}\n`);

  // ═══════════════════════════════════════════════════════════════
  // STEP 2: Deploy PrivateERC20WithRestrictionList256 Implementation
  // ═══════════════════════════════════════════════════════════════
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📦 STEP 2: Deploying PrivateERC20WithRestrictionList256 Implementation...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const { address: privateERC20ImplAddress, blockNumber: privateERC20ImplBlockNumber } =
    await deployWithSizeInfo("PrivateERC20WithRestrictionList256", []);
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
  } = await deployWithSizeInfo(
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
  } = await deployWithSizeInfo("RestrictionListRegistryFactory", []);
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
          privateTokenAddress = parsed.args[0]; // First arg is token address
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

  // Print as JSON for easy copy-paste
  console.log("📋 JSON Output (for configuration):");
  const result: DeploymentResult = {
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

  return result;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  });
