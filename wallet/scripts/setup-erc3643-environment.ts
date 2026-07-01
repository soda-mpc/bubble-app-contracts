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

function envUint8(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }

  const parsed = Number(raw);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 255) {
    throw new Error(`${name} must be an integer between 0 and 255`);
  }
  return parsed;
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

async function createSecurityTokenViaFactory(params: {
  factory: any;
  name: string;
  symbol: string;
  decimals: number;
  identityRegistry: string;
  compliance: string;
  onchainID: string;
}): Promise<{ address: string; blockNumber: number }> {
  const { factory, name, symbol, decimals, identityRegistry, compliance, onchainID } = params;

  const receipt = await (await factory.createToken(
    name,
    symbol,
    decimals,
    identityRegistry,
    compliance,
    onchainID
  )).wait(1);

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
    throw new Error("Failed to extract security token address from TokenCreated event");
  }

  return {
    address: tokenAddress,
    blockNumber: receipt?.blockNumber || 0,
  };
}

async function main() {
  console.log("\n================================================================");
  console.log(" ERC-3643 PRIVATE SECURITY TOKEN - ENVIRONMENT SETUP");
  console.log("================================================================\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log(`Network: ${network.name} (${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`);

  const tokenName = env("ERC3643_SECURITY_TOKEN_NAME", env("ERC3643_PRIVATE_TOKEN_NAME", "Private Security Token"));
  const tokenSymbol = env("ERC3643_SECURITY_TOKEN_SYMBOL", env("ERC3643_PRIVATE_TOKEN_SYMBOL", "pSEC"));
  const tokenDecimals = envUint8("ERC3643_SECURITY_TOKEN_DECIMALS", 18);
  const shouldCreateToken = envBool("ERC3643_CREATE_TOKEN", true);

  const configuredIdentityRegistry = env("ERC3643_IDENTITY_REGISTRY_ADDRESS");
  const configuredCompliance = env("ERC3643_COMPLIANCE_ADDRESS");
  const configuredOnchainID = env("ERC3643_ONCHAIN_ID_ADDRESS");

  const onchainID = optionalAddress(configuredOnchainID, "ERC3643_ONCHAIN_ID_ADDRESS");

  console.log("Configuration:");
  console.log(`  Security token name: ${tokenName}`);
  console.log(`  Security token symbol: ${tokenSymbol}`);
  console.log(`  Security token decimals: ${tokenDecimals}`);
  console.log(`  OnchainID: ${onchainID}`);
  console.log(`  Create token via factory: ${shouldCreateToken}\n`);

  console.log("----------------------------------------------------------------");
  console.log("STEP 1: Identity registry");
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
  console.log("STEP 2: Security token compliance");
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
    const deployed = await deployWithSizeInfo("MockPrivateSecurityTokenCompliance", []);
    compliance = {
      address: deployed.address,
      blockNumber: deployed.blockNumber,
      deployed: true,
    };
    console.log(`   Mock security token compliance deployed at: ${compliance.address}`);
    console.log(`   Block number: ${compliance.blockNumber}\n`);
  }

  console.log("----------------------------------------------------------------");
  console.log("STEP 3: PrivateERC3643SecurityToken256 implementation");
  console.log("----------------------------------------------------------------");

  const implementation = await deployWithSizeInfo(
    "contracts/erc3643/PrivateERC3643SecurityToken256.sol:PrivateERC3643SecurityToken256",
    []
  );
  console.log(`   Implementation deployed at: ${implementation.address}`);
  console.log(`   Block number: ${implementation.blockNumber}\n`);

  console.log("----------------------------------------------------------------");
  console.log("STEP 4: PrivateERC3643SecurityTokenFactory256");
  console.log("----------------------------------------------------------------");

  const factoryDeployment = await deployWithSizeInfo("PrivateERC3643SecurityTokenFactory256", [
    implementation.address,
  ]);
  console.log(`   Factory deployed at: ${factoryDeployment.address}`);
  console.log(`   Block number: ${factoryDeployment.blockNumber}\n`);

  let privateToken: AddressInfo | null = null;
  if (shouldCreateToken) {
    console.log("----------------------------------------------------------------");
    console.log("STEP 5: Create private ERC-3643 security token via factory");
    console.log("----------------------------------------------------------------");

    const created = await createSecurityTokenViaFactory({
      factory: factoryDeployment.contract,
      name: tokenName,
      symbol: tokenSymbol,
      decimals: tokenDecimals,
      identityRegistry: identityRegistry.address,
      compliance: compliance.address,
      onchainID,
    });

    privateToken = {
      address: created.address,
      blockNumber: created.blockNumber,
      deployed: true,
    };
    console.log(`   Security token created at: ${privateToken.address}`);
    console.log(`   Block number: ${privateToken.blockNumber}\n`);
  } else {
    console.log("STEP 5: Token creation skipped by ERC3643_CREATE_TOKEN=false\n");
  }

  const result = {
    network: {
      name: network.name,
      chainId: network.chainId.toString(),
    },
    deployer: deployer.address,
    identityRegistry,
    compliance,
    privateERC3643SecurityToken: {
      implementation: implementation.address,
      implementationBlockNumber: implementation.blockNumber,
      factory: factoryDeployment.address,
      factoryBlockNumber: factoryDeployment.blockNumber,
    },
    privateToken: privateToken
      ? {
          address: privateToken.address,
          name: tokenName,
          symbol: tokenSymbol,
          decimals: tokenDecimals,
          identityRegistry: identityRegistry.address,
          compliance: compliance.address,
          onchainID,
          blockNumber: privateToken.blockNumber,
        }
      : null,
  };

  console.log("================================================================");
  console.log("DEPLOYMENT SUMMARY");
  console.log("================================================================");
  console.log(`IdentityRegistry: ${identityRegistry.address}`);
  console.log(`Compliance:       ${compliance.address}`);
  console.log(`Implementation:   ${implementation.address}`);
  console.log(`Factory:          ${factoryDeployment.address}`);
  if (privateToken) {
    console.log(`Security token:   ${privateToken.address}`);
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
