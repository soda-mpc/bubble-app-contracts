/**
 * Create a 1-of-N Safe proxy wallet on the current network.
 *
 * Env:
 *   SAFE_OWNERS      – comma-separated owner addresses (default: first Hardhat signer)
 *   SAFE_THRESHOLD   – confirmation threshold (default: number of owners)
 *   SAFE_SALT_NONCE  – CREATE2 salt nonce (default: 42)
 *   SAFE_WALLET_LABEL – deployment file label (default: default)
 *
 * Example:
 *   SAFE_OWNERS=0xabc...,0xdef... SAFE_THRESHOLD=1 \
 *     npx hardhat run scripts/safe/create-wallet.ts --network kurtosis
 */
import hre from "hardhat";
import { deploySafeWallet, getOrDeploySafeInfrastructure } from "./safe-core";
import { saveSafeWallet } from "./deployments-io";

async function main() {
  const [defaultOwner] = await hre.ethers.getSigners();
  const ownersFromEnv = process.env.SAFE_OWNERS?.split(",").map((value) => value.trim()).filter(Boolean);
  const owners = ownersFromEnv?.length ? ownersFromEnv : [defaultOwner.address];
  const threshold = process.env.SAFE_THRESHOLD ? Number(process.env.SAFE_THRESHOLD) : owners.length;
  const saltNonce = process.env.SAFE_SALT_NONCE ? BigInt(process.env.SAFE_SALT_NONCE) : 42n;
  const label = process.env.SAFE_WALLET_LABEL || "default";

  const infrastructure = await getOrDeploySafeInfrastructure(hre);
  const deployed = await deploySafeWallet(hre, owners, threshold, saltNonce);
  const network = await hre.ethers.provider.getNetwork();

  const outputPath = saveSafeWallet(
    {
      network: hre.network.name,
      chainId: Number(network.chainId),
      deployedAt: new Date().toISOString(),
      safeAddress: deployed.safeAddress,
      owners,
      threshold,
      saltNonce: saltNonce.toString(),
      singleton: infrastructure.safeL2Address,
      factory: infrastructure.factoryAddress,
    },
    hre.network.name,
    label
  );

  console.log("Safe wallet created");
  console.log("  address:   ", deployed.safeAddress);
  console.log("  owners:    ", owners.join(", "));
  console.log("  threshold: ", threshold);
  console.log("  singleton: ", infrastructure.safeL2Address);
  console.log("  factory:   ", infrastructure.factoryAddress);
  console.log("  saved to:  ", outputPath);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
