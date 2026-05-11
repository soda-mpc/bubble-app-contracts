/**
 * Prepare upgrade to PrivateERC20Contract256V2 and print Safe transaction data.
 * UUPS: upgrade is executed by calling the proxy's upgradeToAndCall(newImpl, data).
 * The Safe must be the owner of the proxy.
 *
 * Required env:
 *   PROXY_ADDRESS – address of the proxy (token)
 *
 * Example:
 *   PROXY_ADDRESS=0x... npx hardhat run scripts/prepare-upgrade.ts --network sepolia-base
 *
 * Then in Safe UI: create transaction with Target = proxy address, Value = 0, Data = printed calldata.
 */

import { ethers, upgrades } from "hardhat";

async function main() {
  const proxyAddress = process.env.PROXY_ADDRESS;
  if (!ethers.isAddress(proxyAddress || "")) {
    throw new Error("Set PROXY_ADDRESS (proxy/token address) in the environment");
  }

  console.log("Preparing upgrade for proxy:", proxyAddress);

  const PrivateERC20Contract256V2 = await ethers.getContractFactory("PrivateERC20Contract256V2");
  const newImplAddress = await upgrades.prepareUpgrade(proxyAddress!, PrivateERC20Contract256V2);

  console.log("New implementation deployed at:", newImplAddress);

  const proxy = new ethers.Interface([
    "function upgradeToAndCall(address newImplementation, bytes memory data)",
  ]);
  const upgradeCalldata = proxy.encodeFunctionData("upgradeToAndCall", [
    newImplAddress,
    "0x",
  ]);

  console.log("\n=== SAFE TRANSACTION (UUPS) ===");
  console.log("Target (Proxy/Token):", proxyAddress);
  console.log("Value: 0");
  console.log("Data:", upgradeCalldata);
  console.log("\nSubmit this transaction from the Safe. After execution, the proxy will use V2.");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
