/**
 * Deploy the gasless private-token stack on the selected network:
 *   PrivateOPRFNotes library, PrivateERC20Contract256Gasless implementation, PrivateERC20GaslessFactory.
 *
 * Example:
 *   npx hardhat run scripts/deploy-private-erc20-gasless-factory.ts --network sepolia-arbitrum
 */

import * as fs from "fs";
import hre from "hardhat";
import {
  PRIVATE_ERC20_256_GASLESS_FQN,
  PRIVATE_OPRF_NOTES_FQN,
  deployPrivateOPRFNotesLibrary,
  waitForDeploymentConfirmation,
} from "../test/helpers/testHelpers";
import { getDeploymentFilePath, loadDeploymentResult } from "./deployment-io";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const networkName = hre.network.name;

  console.log("Network:", networkName, "chainId:", chainId);
  console.log("Deployer:", deployer.address);
  console.log("Balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());

  const libraryAddress = await deployPrivateOPRFNotesLibrary(hre, deployer);
  console.log("PrivateOPRFNotes:", libraryAddress);

  const Implementation = await hre.ethers.getContractFactory(PRIVATE_ERC20_256_GASLESS_FQN, {
    signer: deployer,
    libraries: { [PRIVATE_OPRF_NOTES_FQN]: libraryAddress },
  });
  const implementation = await Implementation.deploy();
  await implementation.waitForDeployment();
  await waitForDeploymentConfirmation(implementation, hre);
  const implementationAddress = await implementation.getAddress();
  console.log("PrivateERC20Contract256Gasless:", implementationAddress);

  const Factory = await hre.ethers.getContractFactory("PrivateERC20GaslessFactory", deployer);
  const factory = await Factory.deploy(implementationAddress);
  await factory.waitForDeployment();
  await waitForDeploymentConfirmation(factory, hre);
  const factoryAddress = await factory.getAddress();
  const blockNumber = await hre.ethers.provider.getBlockNumber();
  console.log("PrivateERC20GaslessFactory:", factoryAddress);

  const onChainImplementation = await factory.implementation();
  if (onChainImplementation.toLowerCase() !== implementationAddress.toLowerCase()) {
    throw new Error(
      `Factory implementation mismatch: ${onChainImplementation} != ${implementationAddress}`
    );
  }

  const deploymentPath = getDeploymentFilePath(networkName);
  const existing = fs.existsSync(deploymentPath)
    ? (loadDeploymentResult(deploymentPath) as unknown as Record<string, unknown>)
    : { network: networkName, chainId };

  const next = {
    ...existing,
    network: networkName,
    chainId,
    gaslessFactory: {
      library: libraryAddress,
      implementation: implementationAddress,
      factory: factoryAddress,
      blockNumber,
      deployedAt: new Date().toISOString(),
    },
  };

  fs.mkdirSync(require("path").dirname(deploymentPath), { recursive: true });
  fs.writeFileSync(deploymentPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  console.log("\nWrote", deploymentPath);

  console.log("\n=== Addresses ===");
  console.log("PrivateOPRFNotes:                ", libraryAddress);
  console.log("PrivateERC20Contract256Gasless:  ", implementationAddress);
  console.log("PrivateERC20GaslessFactory:      ", factoryAddress);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
