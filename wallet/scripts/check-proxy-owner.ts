/**
 * Check the owner of an upgradable PrivateERC20Contract256 proxy.
 *
 * Required env:
 *   PROXY_ADDRESS – proxy (token) address
 *
 * Optional env:
 *   SAFE_ADDRESS  – expected owner; if set, script verifies owner === SAFE_ADDRESS
 *
 * Example:
 *   PROXY_ADDRESS=0x... npx hardhat run scripts/check-proxy-owner.ts --network sepolia
 *   PROXY_ADDRESS=0x... SAFE_ADDRESS=0x... npx hardhat run scripts/check-proxy-owner.ts --network sepolia
 */

import { ethers } from "hardhat";

async function main() {
  const proxyAddress = process.env.PROXY_ADDRESS;
  const expectedOwner = process.env.SAFE_ADDRESS;

  if (!ethers.isAddress(proxyAddress || "")) {
    throw new Error("Set PROXY_ADDRESS (proxy/token address) in the environment");
  }

  const PrivateERC20Contract256 = await ethers.getContractFactory("PrivateERC20Contract256");
  const proxy = PrivateERC20Contract256.attach(proxyAddress!) as any;
  const owner = await proxy.owner();

  console.log("Proxy:", proxyAddress);
  console.log("Owner:", owner);

  if (expectedOwner && ethers.isAddress(expectedOwner)) {
    const match = owner.toLowerCase() === expectedOwner.toLowerCase();
    if (match) {
      console.log("\n✅ Ownership verified: owner is the Safe.", expectedOwner);
    } else {
      console.log("\n❌ Owner is not the Safe. Expected:", expectedOwner);
      process.exit(1);
    }
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
