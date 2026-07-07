import hre from "hardhat";
import fs from "fs";
import path from "path";

const { artifacts, ethers } = hre as any;

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

async function requireContract(address: string, label: string): Promise<void> {
  const code = await ethers.provider.getCode(address);
  if (!code || code === "0x") {
    throw new Error(`${label} has no contract code on the selected network: ${address}`);
  }
}

async function assertERC20Metadata(address: string, label: string): Promise<void> {
  await requireContract(address, label);
  const token = new ethers.Contract(address, [
    "function totalSupply() view returns (uint256)",
    "function decimals() view returns (uint8)",
  ], ethers.provider);

  try {
    await token.totalSupply();
    await token.decimals();
  } catch (error: any) {
    throw new Error(`${label} must be an ERC20 with totalSupply() and decimals(): ${address}`);
  }
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
  defaultSendAllowed: boolean;
  defaultReceiveAllowed: boolean;
}): Promise<{ address: string; blockNumber: number }> {
  const {
    factory,
    name,
    symbol,
    underlying,
    underlyingIsWrappedNative,
    master,
    defaultSendAllowed,
    defaultReceiveAllowed,
  } = params;

  const tx = await factory[
    "createToken(string,string,address,bool,address,bool,bool)"
  ](
    name,
    symbol,
    underlying,
    underlyingIsWrappedNative,
    master,
    defaultSendAllowed,
    defaultReceiveAllowed
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
  console.log(" ERC-7943 PRIVATE ERC20 WRAPPER - ENVIRONMENT SETUP");
  console.log("================================================================\n");

  const [deployer] = await ethers.getSigners();
  const network = await ethers.provider.getNetwork();
  console.log(`Network: ${network.name} (${network.chainId})`);
  console.log(`Deployer: ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Balance: ${ethers.formatEther(balance)} ETH\n`);

  const tokenName = env("ERC7943_UNDERLYING_NAME", "Test USD");
  const tokenSymbol = env("ERC7943_UNDERLYING_SYMBOL", "TUSD");
  const privateTokenName = env("ERC7943_PRIVATE_TOKEN_NAME", "Private Test USD 7943");
  const privateTokenSymbol = env("ERC7943_PRIVATE_TOKEN_SYMBOL", "pTUSD7943");
  const underlyingIsWrappedNative = envBool("ERC7943_UNDERLYING_IS_WRAPPED_NATIVE", false);
  const defaultSendAllowed = envBool("ERC7943_DEFAULT_SEND_ALLOWED", false);
  const defaultReceiveAllowed = envBool("ERC7943_DEFAULT_RECEIVE_ALLOWED", false);
  const shouldCreateToken = envBool("ERC7943_CREATE_TOKEN", true);
  const deploymentJsonPath = env(
    "ERC7943_DEPLOYMENT_JSON",
    path.join(process.cwd(), "scripts", "deployments", "erc7943", `${network.name}.json`)
  );

  const configuredUnderlying = env("ERC7943_UNDERLYING_ADDRESS");
  if (underlyingIsWrappedNative && !configuredUnderlying) {
    throw new Error(
      "ERC7943_UNDERLYING_IS_WRAPPED_NATIVE=true requires ERC7943_UNDERLYING_ADDRESS to point to a wrapped native token"
    );
  }

  const configuredMaster = env("ERC7943_MASTER_ADDRESS");
  const master = configuredMaster
    ? requireAddress(configuredMaster, "ERC7943_MASTER_ADDRESS")
    : deployer.address;

  console.log("Configuration:");
  console.log(`  Private token name: ${privateTokenName}`);
  console.log(`  Private token symbol: ${privateTokenSymbol}`);
  console.log(`  Master: ${master}`);
  console.log(`  Underlying is wrapped native: ${underlyingIsWrappedNative}`);
  console.log(`  Default send allowed: ${defaultSendAllowed}`);
  console.log(`  Default receive allowed: ${defaultReceiveAllowed}`);
  console.log(`  Create token via factory: ${shouldCreateToken}\n`);
  console.log(`  Deployment JSON: ${deploymentJsonPath}\n`);

  console.log("----------------------------------------------------------------");
  console.log("STEP 1: Underlying token");
  console.log("----------------------------------------------------------------");

  let underlying: AddressInfo;
  if (configuredUnderlying) {
    const underlyingAddress = requireAddress(configuredUnderlying, "ERC7943_UNDERLYING_ADDRESS");
    await assertERC20Metadata(underlyingAddress, "ERC7943_UNDERLYING_ADDRESS");
    underlying = {
      address: underlyingAddress,
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
  console.log("STEP 2: PrivateERC7943ERC20Contract256 implementation");
  console.log("----------------------------------------------------------------");

  const implementation = await deployWithSizeInfo(
    "contracts/erc7943/PrivateERC7943ERC20Contract256.sol:PrivateERC7943ERC20Contract256",
    []
  );
  console.log(`   Implementation deployed at: ${implementation.address}`);
  console.log(`   Block number: ${implementation.blockNumber}\n`);

  console.log("----------------------------------------------------------------");
  console.log("STEP 3: PrivateERC7943ERC20Factory256");
  console.log("----------------------------------------------------------------");

  const factoryDeployment = await deployWithSizeInfo("PrivateERC7943ERC20Factory256", [
    implementation.address,
  ]);
  console.log(`   Factory deployed at: ${factoryDeployment.address}`);
  console.log(`   Block number: ${factoryDeployment.blockNumber}\n`);

  let privateToken: AddressInfo | null = null;
  if (shouldCreateToken) {
    console.log("----------------------------------------------------------------");
    console.log("STEP 4: Create private ERC-7943 wrapper via factory");
    console.log("----------------------------------------------------------------");

    const created = await createTokenViaFactory({
      factory: factoryDeployment.contract,
      name: privateTokenName,
      symbol: privateTokenSymbol,
      underlying: underlying.address,
      underlyingIsWrappedNative,
      master,
      defaultSendAllowed,
      defaultReceiveAllowed,
    });

    privateToken = {
      address: created.address,
      blockNumber: created.blockNumber,
      deployed: true,
    };
    console.log(`   Private token created at: ${privateToken.address}`);
    console.log(`   Block number: ${privateToken.blockNumber}\n`);
  } else {
    console.log("STEP 4: Token creation skipped by ERC7943_CREATE_TOKEN=false\n");
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
    privateERC7943: {
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
          underlyingIsWrappedNative,
          defaultSendAllowed,
          defaultReceiveAllowed,
          blockNumber: privateToken.blockNumber,
        }
      : null,
  };

  console.log("================================================================");
  console.log("DEPLOYMENT SUMMARY");
  console.log("================================================================");
  console.log(`Underlying:      ${underlying.address}`);
  console.log(`Implementation: ${implementation.address}`);
  console.log(`Factory:        ${factoryDeployment.address}`);
  if (privateToken) {
    console.log(`Private token:  ${privateToken.address}`);
  }
  console.log("\nJSON Output:");
  console.log(JSON.stringify(result, null, 2));
  fs.mkdirSync(path.dirname(deploymentJsonPath), { recursive: true });
  fs.writeFileSync(deploymentJsonPath, `${JSON.stringify(result, null, 2)}\n`);
  console.log(`\nSaved deployment JSON to: ${deploymentJsonPath}`);

  return result;
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("Deployment failed:", error);
    process.exit(1);
  });
