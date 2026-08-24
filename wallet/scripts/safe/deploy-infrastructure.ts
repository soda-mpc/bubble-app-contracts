/**
 * Deploy SafeL2 singleton + SafeProxyFactory on the current network.
 * Uses canonical addresses when already deployed (e.g. Base Sepolia); otherwise deploys locally.
 *
 * Example:
 *   npx hardhat run scripts/safe/deploy-infrastructure.ts --network kurtosis
 */
import hre from "hardhat";
import { getOrDeploySafeInfrastructure, toInfrastructureRecord } from "./safe-core";
import { saveSafeInfrastructure } from "./deployments-io";

async function main() {
  const network = await hre.ethers.provider.getNetwork();
  const infrastructure = await getOrDeploySafeInfrastructure(hre);
  const record = toInfrastructureRecord(hre.network.name, Number(network.chainId), infrastructure);
  const outputPath = saveSafeInfrastructure(record, hre.network.name);

  console.log("Safe infrastructure ready");
  console.log("  source:           ", infrastructure.source);
  console.log("  SafeL2 singleton: ", infrastructure.safeL2Address);
  console.log("  SafeProxyFactory: ", infrastructure.factoryAddress);
  console.log("  saved to:         ", outputPath);
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
