import hre, { ethers } from "hardhat";
import { saveDeploymentRecord } from "./deployment-io";

// RECORD_AS=gaslessTestToken records the token in scripts/deployments/<network>.json under that key, keeping the
// file's other sections. Without it the script only prints the address.
const RECORD_KEYS = ["gaslessTestToken"] as const;

async function main() {
  // Get deployment parameters from command line arguments or use defaults
  const args = process.argv.slice(2);
  
  let tokenName = process.env.TUSDC_NAME || "Test USDC";
  let tokenSymbol = process.env.TUSDC_SYMBOL || "TUSDC";
  let decimals = process.env.TUSDC_DECIMALS ? parseDecimals(process.env.TUSDC_DECIMALS) : 18;

  // Parse command line arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && i + 1 < args.length) {
      tokenName = args[i + 1];
      i++;
    } else if (args[i] === "--symbol" && i + 1 < args.length) {
      tokenSymbol = args[i + 1];
      i++;
    } else if (args[i] === "--decimals" && i + 1 < args.length) {
      decimals = parseDecimals(args[i + 1]);
      i++;
    }
  }

  console.log(`\n=== Deploying TUSDC Token ===`);
  console.log(`Name: ${tokenName}`);
  console.log(`Symbol: ${tokenSymbol}`);
  console.log(`Decimals: ${decimals}`);

  // Get the deployer account
  const [deployer] = await ethers.getSigners();
  console.log(`\nDeploying with account: ${deployer.address}`);

  // Get account balance
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Account balance: ${ethers.formatEther(balance)} ETH`);

  // Get the TUSDC contract factory
  const TUSDC = await ethers.getContractFactory("TUSDC");

  // Deploy the contract
  console.log(`\nDeploying contract...`);
  const tusdc = await TUSDC.deploy(tokenName, tokenSymbol);
  
  // Wait for deployment to complete and be confirmed
  const deployTx = tusdc.deploymentTransaction();
  let deploymentBlockNumber: number | undefined;
  
  if (deployTx) {
    const receipt = await deployTx.wait(2); // Wait for 2 confirmations
    deploymentBlockNumber = receipt?.blockNumber;
  } else {
    await tusdc.waitForDeployment();
  }
  const contractAddress = await tusdc.getAddress();

  console.log(`✅ Contract deployed successfully!`);
  console.log(`Contract address: ${contractAddress}`);
  if (deploymentBlockNumber) {
    console.log(`📦 Deployment block number: ${deploymentBlockNumber}`);
  } else {
    console.log(`⚠️  Could not retrieve deployment block number (transaction not available)`);
  }

  // Set custom decimals if different from default (18)
  if (decimals !== 18) {
    console.log(`\nSetting decimals to ${decimals}...`);
    // Get current gas price and bump it by 20%
    const gasPriceHex = await ethers.provider.send('eth_gasPrice', []);
    const gasPrice = BigInt(gasPriceHex);
    const bumpedGasPrice = gasPrice * 12n / 10n; // +20%
    try {
      const setDecimalsTx = await tusdc.setDecimals(decimals, { gasPrice: bumpedGasPrice });
      await setDecimalsTx.wait(2); // Wait for 2 confirmations
      console.log(`✅ Decimals set to ${decimals}`);
    } catch (err) {
      console.error(`❌ Failed to set decimals:`, err);
      throw err;
    }
  }

  const recordAs = process.env.RECORD_AS?.trim();
  if (recordAs) {
    if (!(RECORD_KEYS as readonly string[]).includes(recordAs)) {
      throw new Error(`RECORD_AS must be one of: ${RECORD_KEYS.join(", ")}`);
    }
    const network = await ethers.provider.getNetwork();
    const blockNumber = deploymentBlockNumber ?? (await ethers.provider.getBlockNumber());
    const written = saveDeploymentRecord(
      {
        network: hre.network.name,
        chainId: Number(network.chainId),
        gaslessTestToken: {
          address: contractAddress,
          name: tokenName,
          symbol: tokenSymbol,
          decimals,
          blockNumber,
          eip2612: true,
          eip3009: true,
          mintWithAuthorization: true,
        },
      },
      hre.network.name
    );
    console.log(`📝 Recorded as ${recordAs} in ${written}`);
  }

  // Display token information
  console.log(`\n=== Token Information ===`);
  console.log(`Name: ${await tusdc.name()}`);
  console.log(`Symbol: ${await tusdc.symbol()}`);
  console.log(`Decimals: ${await tusdc.decimals()}`);
  console.log(`Total Supply: ${ethers.formatUnits(await tusdc.totalSupply(), await tusdc.decimals())}`);
  console.log(`Contract Address: ${contractAddress}`);

  return {
    contract: tusdc,
    address: contractAddress,
    name: tokenName,
    symbol: tokenSymbol,
    decimals: decimals
  };
}

function parseDecimals(raw: string): number {
  const decimals = Number(raw);
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 255) {
    throw new Error(`Invalid TUSDC decimals "${raw}": expected an integer from 0 to 255`);
  }
  return decimals;
}

// Run the deployment
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  }); 