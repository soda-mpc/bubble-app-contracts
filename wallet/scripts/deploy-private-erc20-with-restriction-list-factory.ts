import { ethers } from "hardhat";

async function main() {
  // Get the deployer account
  const [deployer] = await ethers.getSigners();
  console.log(`Deploying with account: ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Account balance: ${ethers.formatEther(balance)} ETH`);

  // Deploy the factory contract
  const Factory = await ethers.getContractFactory("PrivateERC20WithRestrictionListFactory256");
  const factory = await Factory.deploy();
  
  // Get deployment transaction to retrieve block number
  const deployTx = factory.deploymentTransaction();
  if (deployTx) {
    const receipt = await deployTx.wait();
    const factoryAddress = await factory.getAddress();
    console.log(`✅ PrivateERC20WithRestrictionListFactory256 deployed at: ${factoryAddress}`);
    console.log(`📦 Deployment block number: ${receipt.blockNumber}`);
  } else {
    await factory.waitForDeployment();
    const factoryAddress = await factory.getAddress();
    console.log(`✅ PrivateERC20WithRestrictionListFactory256 deployed at: ${factoryAddress}`);
    console.log(`⚠️  Could not retrieve deployment block number (transaction not available)`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Deployment failed:", error);
    process.exit(1);
  }); 