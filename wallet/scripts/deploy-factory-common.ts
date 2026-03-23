import { ethers } from "hardhat";

export async function deployFactory(contractName: string, label?: string): Promise<void> {
  const displayName = label ?? contractName;

  const [deployer] = await ethers.getSigners();
  console.log(`Deploying with account: ${deployer.address}`);
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log(`Account balance: ${ethers.formatEther(balance)} ETH`);

  const Factory = await ethers.getContractFactory(contractName);
  const factory = await Factory.deploy();

  const deployTx = factory.deploymentTransaction();
  if (deployTx) {
    const receipt = await deployTx.wait();
    const factoryAddress = await factory.getAddress();
    console.log(`${displayName} deployed at: ${factoryAddress}`);
    if (receipt) {
      console.log(`Deployment block number: ${receipt.blockNumber}`);
    } else {
      console.log("Could not retrieve deployment block number (receipt not available)");
    }
    return;
  }

  await factory.waitForDeployment();
  const factoryAddress = await factory.getAddress();
  console.log(`${displayName} deployed at: ${factoryAddress}`);
  console.log("Could not retrieve deployment block number (transaction not available)");
}
