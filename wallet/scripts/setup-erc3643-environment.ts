import { artifacts, ethers } from "hardhat";

interface DeployedContractInfo {
  contract: any;
  address: string;
  blockNumber: number;
}

interface AddressInfo {
  address: string;
  blockNumber: number;
  deployed: boolean;
}

function env(name: string, fallback = ""): string {
  return process.env[name] || fallback;
}

function envBool(name: string, fallback: boolean): boolean {
  const value = process.env[name];
  if (value === undefined || value === "") {
    return fallback;
  }
  return ["1", "true", "yes", "y"].includes(value.toLowerCase());
}

function requireAddress(value: string, label: string): string {
  if (!ethers.isAddress(value)) {
    throw new Error(`${label} must be a valid address`);
  }
  return ethers.getAddress(value);
}

function optionalAddress(value: string, label: string): string {
  if (!value) {
    return ethers.ZeroAddress;
  }
  return requireAddress(value, label);
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

async function deployWithSizeInfo(contractName: string, deployArgs: any[]): Promise<DeployedContractInfo> {
  const sizeInfo = await getContractSizeInfo(contractName);
  console.log(`   Size: init ${sizeInfo.initCodeBytes} bytes, runtime ${sizeInfo.runtimeCodeBytes} bytes`);
  console.log(`   Est. gas: code deposit ${sizeInfo.codeDepositGas}, initcode ${sizeInfo.initCodeGas}`);

  const Factory = await ethers.getContractFactory(contractName);
  const contract = await Factory.deploy(...deployArgs);
  const { address, blockNumber } = await waitForDeploymentAndBlock(contract);
  return { contract, address, blockNumber };
}

async function createTokenViaFactory(params: {
  factory: any;
  name: string;
  symbol: string;
  underlying: string;
  underlyingIsWrappedNative: boolean;
  master: string;
  identityRegistry: string;
  compliance: string;
  onchainID: string;
}): Promise<{ address: string; blockNumber: number }> {
  const {
    factory,
    name,
    symbol,
    underlying,
    underlyingIsWrappedNative,
    master,
    identityRegistry,
    compliance,
    onchainID,
  } = params;

  const tx = await factory[
    "createToken(string,string,address,bool,address,address,address,address)"
  ](
    name,
    symbol,
    underlying,
    underlyingIsWrappedNative,
    master,
    identityRegistry,
    compliance,
    onchainID
  );
  const receipt = await tx.wait(1);

  let tokenAddress = "";
  if (receipt?.logs) {
    for (const log of receipt.logs) {
      try {
        const parsed = factory.interface.parseLog({
          topics: log.topics as string[],
          data: log.data,
        });
        if (parsed?.name === "TokenCreated") {
          tokenAddress = parsed.args.token;
          break;
        }
      } catch {
        // Not the factory event.
      }
    }
  }

  if (!tokenAddress) {
    throw new Error("Failed to extract private token address from TokenCreated event");
  }

  return {
    address: tokenAddress,
    blockNumber: receipt?.blockNumber || 0,
  };
}

async function main() {
  console.log("\n================================================================");
  console.log(" ERC-3643 PRIVATE ERC20 WRAPPER - ENVIRONMENT SETUP");
  console.log("================================================================\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log(`Network: ${network.name} (${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`);

  const tokenName = env("ERC3643_UNDERLYING_NAME", "Test USD");
  const tokenSymbol = env("ERC3643_UNDERLYING_SYMBOL", "TUSD");
  const privateTokenName = env("ERC3643_PRIVATE_TOKEN_NAME", "Private Test USD");
  const privateTokenSymbol = env("ERC3643_PRIVATE_TOKEN_SYMBOL", "pTUSD");
  const underlyingIsWrappedNative = envBool("ERC3643_UNDERLYING_IS_WRAPPED_NATIVE", false);
  const shouldCreateToken = envBool("ERC3643_CREATE_TOKEN", true);

  const configuredUnderlying = env("ERC3643_UNDERLYING_ADDRESS");
  const configuredIdentityRegistry = env("ERC3643_IDENTITY_REGISTRY_ADDRESS");
  const configuredCompliance = env("ERC3643_COMPLIANCE_ADDRESS");
  const configuredMaster = env("ERC3643_MASTER_ADDRESS");
  const configuredOnchainID = env("ERC3643_ONCHAIN_ID_ADDRESS");

  const master = configuredMaster
    ? requireAddress(configuredMaster, "ERC3643_MASTER_ADDRESS")
    : deployer.address;
  const onchainID = optionalAddress(configuredOnchainID, "ERC3643_ONCHAIN_ID_ADDRESS");

  console.log("Configuration:");
  console.log(`  Private token name: ${privateTokenName}`);
  console.log(`  Private token symbol: ${privateTokenSymbol}`);
  console.log(`  Master: ${master}`);
  console.log(`  OnchainID: ${onchainID}`);
  console.log(`  Underlying is wrapped native: ${underlyingIsWrappedNative}`);
  console.log(`  Create token via factory: ${shouldCreateToken}\n`);

  console.log("----------------------------------------------------------------");
  console.log("STEP 1: Underlying token");
  console.log("----------------------------------------------------------------");

  let underlying: AddressInfo;
  if (configuredUnderlying) {
    underlying = {
      address: requireAddress(configuredUnderlying, "ERC3643_UNDERLYING_ADDRESS"),
      blockNumber: 0,
      deployed: false,
    };
    console.log(`   Reusing underlying: ${underlying.address}\n`);
  } else {
    const deployed = await deployWithSizeInfo("TUSDC", [tokenName, tokenSymbol]);
    underlying = {
      address: deployed.address,
      blockNumber: deployed.blockNumber,
      deployed: true,
    };
    console.log(`   Underlying deployed at: ${underlying.address}`);
    console.log(`   Block number: ${underlying.blockNumber}\n`);
  }

  console.log("----------------------------------------------------------------");
  console.log("STEP 2: Identity registry");
  console.log("----------------------------------------------------------------");

  let identityRegistry: AddressInfo;
  if (configuredIdentityRegistry) {
    identityRegistry = {
      address: requireAddress(configuredIdentityRegistry, "ERC3643_IDENTITY_REGISTRY_ADDRESS"),
      blockNumber: 0,
      deployed: false,
    };
    console.log(`   Reusing identity registry: ${identityRegistry.address}\n`);
  } else {
    const deployed = await deployWithSizeInfo("MockPrivateIdentityRegistry", []);
    identityRegistry = {
      address: deployed.address,
      blockNumber: deployed.blockNumber,
      deployed: true,
    };
    console.log(`   Mock identity registry deployed at: ${identityRegistry.address}`);
    console.log(`   Block number: ${identityRegistry.blockNumber}\n`);
  }

  console.log("----------------------------------------------------------------");
  console.log("STEP 3: Modular compliance");
  console.log("----------------------------------------------------------------");

  let compliance: AddressInfo;
  if (configuredCompliance) {
    compliance = {
      address: requireAddress(configuredCompliance, "ERC3643_COMPLIANCE_ADDRESS"),
      blockNumber: 0,
      deployed: false,
    };
    console.log(`   Reusing compliance: ${compliance.address}\n`);
  } else {
    const deployed = await deployWithSizeInfo("MockPrivateModularCompliance", []);
    compliance = {
      address: deployed.address,
      blockNumber: deployed.blockNumber,
      deployed: true,
    };
    console.log(`   Mock compliance deployed at: ${compliance.address}`);
    console.log(`   Block number: ${compliance.blockNumber}\n`);
  }

  console.log("----------------------------------------------------------------");
  console.log("STEP 4: PrivateERC3643ERC20Contract256 implementation");
  console.log("----------------------------------------------------------------");

  const implementation = await deployWithSizeInfo(
    "contracts/erc3643/PrivateERC3643ERC20Contract256.sol:PrivateERC3643ERC20Contract256",
    []
  );
  console.log(`   Implementation deployed at: ${implementation.address}`);
  console.log(`   Block number: ${implementation.blockNumber}\n`);

  console.log("----------------------------------------------------------------");
  console.log("STEP 5: PrivateERC3643ERC20Factory256");
  console.log("----------------------------------------------------------------");

  const factoryDeployment = await deployWithSizeInfo("PrivateERC3643ERC20Factory256", [
    implementation.address,
  ]);
  console.log(`   Factory deployed at: ${factoryDeployment.address}`);
  console.log(`   Block number: ${factoryDeployment.blockNumber}\n`);

  let privateToken: AddressInfo | null = null;
  if (shouldCreateToken) {
    console.log("----------------------------------------------------------------");
    console.log("STEP 6: Create private ERC-3643 wrapper via factory");
    console.log("----------------------------------------------------------------");

    const created = await createTokenViaFactory({
      factory: factoryDeployment.contract,
      name: privateTokenName,
      symbol: privateTokenSymbol,
      underlying: underlying.address,
      underlyingIsWrappedNative,
      master,
      identityRegistry: identityRegistry.address,
      compliance: compliance.address,
      onchainID,
    });

    privateToken = {
      address: created.address,
      blockNumber: created.blockNumber,
      deployed: true,
    };
    console.log(`   Private token created at: ${privateToken.address}`);
    console.log(`   Block number: ${privateToken.blockNumber}\n`);
  } else {
    console.log("STEP 6: Token creation skipped by ERC3643_CREATE_TOKEN=false\n");
  }

  const result = {
    network: {
      name: network.name,
      chainId: network.chainId.toString(),
    },
    deployer: deployer.address,
    underlying: {
      address: underlying.address,
      name: configuredUnderlying ? undefined : tokenName,
      symbol: configuredUnderlying ? undefined : tokenSymbol,
      deployed: underlying.deployed,
      blockNumber: underlying.blockNumber,
    },
    identityRegistry,
    compliance,
    privateERC3643: {
      implementation: implementation.address,
      implementationBlockNumber: implementation.blockNumber,
      factory: factoryDeployment.address,
      factoryBlockNumber: factoryDeployment.blockNumber,
    },
    privateToken: privateToken
      ? {
          address: privateToken.address,
          name: privateTokenName,
          symbol: privateTokenSymbol,
          underlying: underlying.address,
          master,
          identityRegistry: identityRegistry.address,
          compliance: compliance.address,
          onchainID,
          underlyingIsWrappedNative,
          blockNumber: privateToken.blockNumber,
        }
      : null,
  };

  console.log("================================================================");
  console.log("DEPLOYMENT SUMMARY");
  console.log("================================================================");
  console.log(`Underlying:        ${underlying.address}`);
  console.log(`IdentityRegistry: ${identityRegistry.address}`);
  console.log(`Compliance:       ${compliance.address}`);
  console.log(`Implementation:   ${implementation.address}`);
  console.log(`Factory:          ${factoryDeployment.address}`);
  if (privateToken) {
    console.log(`Private token:    ${privateToken.address}`);
  }
  console.log("\nJSON Output:");
  console.log(JSON.stringify(result, null, 2));

  return result;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
