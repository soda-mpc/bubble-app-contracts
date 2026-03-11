/**
 * Verify the proxy is running PrivateERC20Contract256V2 by calling getV2Version().
 *
 * Required env:
 *   PROXY_ADDRESS – proxy (token) address
 *
 * Example:
 *   PROXY_ADDRESS=0x... npx hardhat run scripts/check-proxy-version.ts --network sepolia
 */

import { ethers } from "hardhat";

async function main() {
  const proxyAddress = process.env.PROXY_ADDRESS;
  if (!ethers.isAddress(proxyAddress || "")) {
    throw new Error("Set PROXY_ADDRESS (proxy/token address) in the environment");
  }

  const V2 = await ethers.getContractFactory("PrivateERC20Contract256V2");
  const proxy = V2.attach(proxyAddress!) as any;

  try {
    const version = await proxy.getV2Version();
    if (version === "V2.0.0") {
      console.log("Proxy:", proxyAddress);
      console.log("getV2Version():", version);
      console.log("\n✅ Proxy is on V2 (PrivateERC20Contract256V2).");
    } else {
      console.log("Proxy:", proxyAddress);
      console.log("getV2Version():", version);
      console.log("\n⚠️ Unexpected version string.");
    }
  } catch (err: any) {
    console.log("Proxy:", proxyAddress);
    console.log("\n❌ getV2Version() failed (proxy is likely still on V1):", err?.message || err);
    process.exit(1);
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
