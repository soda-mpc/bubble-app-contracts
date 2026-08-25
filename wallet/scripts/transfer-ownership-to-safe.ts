/**
 * Transfer ownership of an existing PrivateERC20Contract256 proxy to the Safe.
 * Use when the proxy was deployed with a different owner and you want Safe to be upgrade authority.
 *
 * Required env:
 *   PROXY_ADDRESS  – address of the proxy (token)
 *   SAFE_ADDRESS   – Safe multisig address (new owner)
 *
 * Example:
 *   PROXY_ADDRESS=0x... SAFE_ADDRESS=0x... npx hardhat run scripts/transfer-ownership-to-safe.ts --network sepolia
 */

import { ethers } from "hardhat";

async function main() {
  const proxyAddress = process.env.PROXY_ADDRESS;
  const safeAddress = process.env.SAFE_ADDRESS;

  if (!ethers.isAddress(proxyAddress || "")) {
    throw new Error("Set PROXY_ADDRESS (proxy/token address) in the environment");
  }
  if (!ethers.isAddress(safeAddress || "")) {
    throw new Error("Set SAFE_ADDRESS (Safe multisig address) in the environment");
  }

  const [deployer] = await ethers.getSigners();
  const PrivateERC20Contract256 = await ethers.getContractFactory("PrivateERC20Contract256");
  const proxy = PrivateERC20Contract256.attach(proxyAddress!) as any;

  const currentOwner = await proxy.owner();
  if (currentOwner.toLowerCase() === safeAddress!.toLowerCase()) {
    console.log("Owner is already the Safe:", safeAddress);
    return;
  }
  if (currentOwner.toLowerCase() !== deployer.address.toLowerCase()) {
    throw new Error(`Current owner is ${currentOwner}. Only the owner can transfer ownership.`);
  }

  console.log("Transferring ownership to Safe:", safeAddress);
  const tx = await proxy.transferOwnership(safeAddress!);
  await tx.wait();
  console.log("Ownership transferred. New owner:", await proxy.owner());
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
