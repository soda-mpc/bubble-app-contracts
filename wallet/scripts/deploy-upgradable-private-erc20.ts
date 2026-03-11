/**
 * Deploy upgradable PrivateERC20Contract256 (UUPS proxy) and transfer ownership to Safe.
 * Use Base Sepolia: --network sepolia-base
 *
 * Required env:
 *   SAFE_ADDRESS     – Safe multisig address (new owner and upgrade authority)
 *   UNDERLYING_ADDRESS – ERC20 token address for wrapping (e.g. test token on Base Sepolia)
 *
 * Optional env:
 *   TOKEN_NAME       – default "Bubble Private Token"
 *   TOKEN_SYMBOL     – default "BUB"
 *   MASTER_ADDRESS   – unshield recipient (default: SAFE_ADDRESS)
 *
 * Example:
 *   SAFE_ADDRESS=0x... UNDERLYING_ADDRESS=0x... npx hardhat run scripts/deploy-upgradable-private-erc20.ts --network sepolia-base
 */

import { ethers, upgrades } from "hardhat";

async function main() {
  const safeAddress = process.env.SAFE_ADDRESS;
  const underlyingAddress = process.env.UNDERLYING_ADDRESS;
  const tokenName = process.env.TOKEN_NAME || "Bubble Private Token";
  const tokenSymbol = process.env.TOKEN_SYMBOL || "BUB";
  const masterAddress = process.env.MASTER_ADDRESS || safeAddress;

  if (!ethers.isAddress(safeAddress || "")) {
    throw new Error("Set SAFE_ADDRESS (Safe multisig address) in the environment");
  }
  if (!ethers.isAddress(underlyingAddress || "")) {
    throw new Error("Set UNDERLYING_ADDRESS (ERC20 for wrapping) in the environment");
  }

  const [deployer] = await ethers.getSigners();
  console.log("Deployer:", deployer.address);
  console.log("Safe (new owner):", safeAddress);
  console.log("Underlying token:", underlyingAddress);
  console.log("Token:", tokenName, tokenSymbol);
  console.log("Master (unshield):", masterAddress);

  const PrivateERC20Contract256 = await ethers.getContractFactory("PrivateERC20Contract256");
  const proxy = await upgrades.deployProxy(
    PrivateERC20Contract256,
    [tokenName, tokenSymbol, underlyingAddress, deployer.address, masterAddress],
    { kind: "uups" }
  );

  await proxy.waitForDeployment();
  const proxyAddress = await proxy.getAddress();
  console.log("\nProxy (token) deployed:", proxyAddress);

  const implAddress = await upgrades.erc1967.getImplementationAddress(proxyAddress);
  console.log("Implementation:", implAddress);

  const token = PrivateERC20Contract256.attach(proxyAddress) as Awaited<ReturnType<typeof ethers.getContractFactory>> & {
    owner: () => Promise<string>;
    transferOwnership: (to: string) => Promise<any>;
  };
  const currentOwner = await token.owner();
  if (currentOwner.toLowerCase() !== safeAddress!.toLowerCase()) {
    console.log("\nTransferring ownership to Safe (2-step: Safe must call acceptOwnership)...");
    const tx = await token.transferOwnership(safeAddress!);
    await tx.wait();
    console.log("transferOwnership sent. Safe must now execute acceptOwnership() to complete.");
  } else {
    console.log("\nOwner is already the Safe.");
  }

  console.log("\n=== Summary ===");
  console.log("Proxy (use this as token address):", proxyAddress);
  console.log("Implementation:", implAddress);
  console.log("New owner (after Safe accepts):", safeAddress);
  console.log("\nNext: In Safe UI, create transaction to call acceptOwnership() on the proxy.");
  console.log("Then to upgrade: run prepare-upgrade.ts and execute the printed transaction from the Safe.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
