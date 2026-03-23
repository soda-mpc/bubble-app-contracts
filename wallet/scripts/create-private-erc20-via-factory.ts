import { ethers } from "hardhat";
import { PrivateERC20Factory } from "../typechain-types";

async function main() {
  // Parse command line arguments
  const args = process.argv.slice(2);
  let factoryAddress = "0xd92bdeFFD4E7A4dA4532aa84Cac980B1155a2cA7";
  let tokenName = "Private tUSDC";
  let tokenSymbol = "PTUSDC";
  let underlying = "0xAC00f90Ed73b8a3d8eA4dd3FF9A22D5156A7d60D";



  if (!factoryAddress) {
    throw new Error("--factory <address> is required");
  }
  if (underlying === ethers.ZeroAddress) {
    console.warn("[WARNING] Underlying address is zero. Please provide a valid ERC20 address with --underlying <address>.");
  }

  // Attach to the factory
  const Factory = await ethers.getContractFactory("PrivateERC20Factory");
  const factory = Factory.attach(factoryAddress) as unknown as PrivateERC20Factory;

  // Call createToken
  console.log(`\nCalling createToken on factory ${factoryAddress}...`);
  const tx = await factory.createToken(tokenName, tokenSymbol, underlying);
    console.log(`Transaction hash: ${tx.hash}`);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error("❌ Script failed:", error);
    process.exit(1);
  }); 