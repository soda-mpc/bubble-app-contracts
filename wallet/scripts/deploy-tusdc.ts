import { ethers } from "hardhat";

async function main() {
  // Get deployment parameters from command line arguments or use defaults
  const args = process.argv.slice(2);
  
  let tokenName = "Test USDC";
  let tokenSymbol = "USDC";
  let decimals = 18;

  // Parse command line arguments
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--name" && i + 1 < args.length) {
      tokenName = args[i + 1];
      i++;
    } else if (args[i] === "--symbol" && i + 1 < args.length) {
      tokenSymbol = args[i + 1];
      i++;
    } else if (args[i] === "--decimals" && i + 1 < args.length) {
      decimals = parseInt(args[i + 1]);
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
    deploymentBlockNumber = receipt.blockNumber;
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
    }
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

// Run the deployment
main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  }); 