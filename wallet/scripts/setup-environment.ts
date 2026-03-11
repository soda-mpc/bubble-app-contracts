import { artifacts, ethers, network } from "hardhat";

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

function getKurtosisDeployOverrides(
  sizeInfo: Awaited<ReturnType<typeof getContractSizeInfo>>,
  minGas: number = 3_000_000
) {
  if (network.name !== "kurtosis") {
    return {};
  }

  const baseGas = sizeInfo.codeDepositGas + sizeInfo.initCodeGas;
  const gasLimit = Math.max(minGas, baseGas + 500_000);
  return { gasLimit };
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

  const tusdcSize = await getContractSizeInfo("TUSDC");
  console.log(
    `   📏 Size: init ${tusdcSize.initCodeBytes} bytes, runtime ${tusdcSize.runtimeCodeBytes} bytes`
  );
  console.log(
    `   ⛽ Est. gas: code deposit ${tusdcSize.codeDepositGas}, initcode ${tusdcSize.initCodeGas}`
  );
  const tusdcDeployOverrides = getKurtosisDeployOverrides(tusdcSize);
  if ("gasLimit" in tusdcDeployOverrides) {
    console.log(`   ⛽ Using gasLimit: ${tusdcDeployOverrides.gasLimit}`);
  }

  const TUSDC = await ethers.getContractFactory("TUSDC");
  const tusdc = await TUSDC.deploy(tokenName, tokenSymbol, tusdcDeployOverrides);
  
  const tusdcDeployTx = tusdc.deploymentTransaction();
  let tusdcBlockNumber = 0;
  if (tusdcDeployTx) {
    const receipt = await tusdcDeployTx.wait(1);
    tusdcBlockNumber = receipt?.blockNumber || 0;
  } else {
    await tusdc.waitForDeployment();
    const blockNumber = await ethers.provider.getBlockNumber();
    tusdcBlockNumber = blockNumber;
  }
  
  const tusdcAddress = await tusdc.getAddress();
  console.log(`   ✅ TUSDC deployed at: ${tusdcAddress}`);
  console.log(`   📦 Block number: ${tusdcBlockNumber}\n`);

  // ═══════════════════════════════════════════════════════════════
  // STEP 2: Deploy PrivateERC20WithRestrictionList256 Implementation
  // ═══════════════════════════════════════════════════════════════
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📦 STEP 2: Deploying PrivateERC20WithRestrictionList256 Implementation...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const privateImplSize = await getContractSizeInfo("PrivateERC20WithRestrictionList256");
  console.log(
    `   📏 Size: init ${privateImplSize.initCodeBytes} bytes, runtime ${privateImplSize.runtimeCodeBytes} bytes`
  );
  console.log(
    `   ⛽ Est. gas: code deposit ${privateImplSize.codeDepositGas}, initcode ${privateImplSize.initCodeGas}`
  );
  const privateImplDeployOverrides = getKurtosisDeployOverrides(privateImplSize);
  if ("gasLimit" in privateImplDeployOverrides) {
    console.log(`   ⛽ Using gasLimit: ${privateImplDeployOverrides.gasLimit}`);
  }

  const PrivateERC20Impl = await ethers.getContractFactory("PrivateERC20WithRestrictionList256");
  const privateERC20Impl = await PrivateERC20Impl.deploy(privateImplDeployOverrides);
  
  const privateERC20ImplTx = privateERC20Impl.deploymentTransaction();
  let privateERC20ImplBlockNumber = 0;
  if (privateERC20ImplTx) {
    const receipt = await privateERC20ImplTx.wait(1);
    privateERC20ImplBlockNumber = receipt?.blockNumber || 0;
  } else {
    await privateERC20Impl.waitForDeployment();
    const blockNumber = await ethers.provider.getBlockNumber();
    privateERC20ImplBlockNumber = blockNumber;
  }
  
  const privateERC20ImplAddress = await privateERC20Impl.getAddress();
  console.log(`   ✅ Implementation deployed at: ${privateERC20ImplAddress}`);
  console.log(`   📦 Block number: ${privateERC20ImplBlockNumber}\n`);

  // ═══════════════════════════════════════════════════════════════
  // STEP 3: Deploy PrivateERC20WithRestrictionListFactory256
  // ═══════════════════════════════════════════════════════════════
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📦 STEP 3: Deploying PrivateERC20WithRestrictionListFactory256...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const privateFactorySize = await getContractSizeInfo("PrivateERC20WithRestrictionListFactory256");
  console.log(
    `   📏 Size: init ${privateFactorySize.initCodeBytes} bytes, runtime ${privateFactorySize.runtimeCodeBytes} bytes`
  );
  console.log(
    `   ⛽ Est. gas: code deposit ${privateFactorySize.codeDepositGas}, initcode ${privateFactorySize.initCodeGas}`
  );
  const privateFactoryDeployOverrides = getKurtosisDeployOverrides(privateFactorySize);
  if ("gasLimit" in privateFactoryDeployOverrides) {
    console.log(`   ⛽ Using gasLimit: ${privateFactoryDeployOverrides.gasLimit}`);
  }

  const PrivateERC20Factory = await ethers.getContractFactory("PrivateERC20WithRestrictionListFactory256");
  // @ts-ignore - TypeScript types may be stale after contract changes
  const privateERC20Factory = await PrivateERC20Factory.deploy(privateERC20ImplAddress, privateFactoryDeployOverrides);
  
  const privateERC20FactoryTx = privateERC20Factory.deploymentTransaction();
  let privateERC20FactoryBlockNumber = 0;
  if (privateERC20FactoryTx) {
    const receipt = await privateERC20FactoryTx.wait(1);
    privateERC20FactoryBlockNumber = receipt?.blockNumber || 0;
  } else {
    await privateERC20Factory.waitForDeployment();
    const blockNumber = await ethers.provider.getBlockNumber();
    privateERC20FactoryBlockNumber = blockNumber;
  }
  
  const privateERC20FactoryAddress = await privateERC20Factory.getAddress();
  console.log(`   ✅ Factory deployed at: ${privateERC20FactoryAddress}`);
  console.log(`   📦 Block number: ${privateERC20FactoryBlockNumber}\n`);

  // ═══════════════════════════════════════════════════════════════
  // STEP 4: Deploy RestrictionListRegistryFactory
  // ═══════════════════════════════════════════════════════════════
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");
  console.log("📦 STEP 4: Deploying RestrictionListRegistryFactory...");
  console.log("━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━");

  const restrictionListFactorySize = await getContractSizeInfo("RestrictionListRegistryFactory");
  console.log(
    `   📏 Size: init ${restrictionListFactorySize.initCodeBytes} bytes, runtime ${restrictionListFactorySize.runtimeCodeBytes} bytes`
  );
  console.log(
    `   ⛽ Est. gas: code deposit ${restrictionListFactorySize.codeDepositGas}, initcode ${restrictionListFactorySize.initCodeGas}`
  );
  const restrictionListFactoryDeployOverrides = getKurtosisDeployOverrides(restrictionListFactorySize);
  if ("gasLimit" in restrictionListFactoryDeployOverrides) {
    console.log(`   ⛽ Using gasLimit: ${restrictionListFactoryDeployOverrides.gasLimit}`);
  }

  const RestrictionListFactory = await ethers.getContractFactory("RestrictionListRegistryFactory");
  const restrictionListFactory = await RestrictionListFactory.deploy(restrictionListFactoryDeployOverrides);
  
  const restrictionListFactoryTx = restrictionListFactory.deploymentTransaction();
  let restrictionListFactoryBlockNumber = 0;
  if (restrictionListFactoryTx) {
    const receipt = await restrictionListFactoryTx.wait(1);
    restrictionListFactoryBlockNumber = receipt?.blockNumber || 0;
  } else {
    await restrictionListFactory.waitForDeployment();
    const blockNumber = await ethers.provider.getBlockNumber();
    restrictionListFactoryBlockNumber = blockNumber;
  }
  
  const restrictionListFactoryAddress = await restrictionListFactory.getAddress();
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
  const createTokenOverrides = network.name === "kurtosis" ? { gasLimit: 8_000_000 } : {};
  if ("gasLimit" in createTokenOverrides) {
    console.log(`   ⛽ Using gasLimit: ${createTokenOverrides.gasLimit}`);
  }

  // @ts-ignore - TypeScript types may be stale
  const createTokenTx = await privateERC20Factory.createToken(
    privateTokenName,
    privateTokenSymbol,
    tusdcAddress,
    emptyRestrictionLists,
    createTokenOverrides
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
