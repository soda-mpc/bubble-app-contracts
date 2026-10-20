/**
 * Deploy the gasless private-token stack on the selected network:
 *   PrivateOPRFNotes library, PrivateERC20Contract256Gasless implementation, PrivateERC20GaslessFactory.
 *
 * Records them under `gaslessFactory` in scripts/deployments/<network>.json, keeping the file's other sections.
 *
 * Example:
 *   npx hardhat run scripts/deploy-private-erc20-gasless-factory.ts --network sepolia-arbitrum
 *
 * To deploy only a new factory for an implementation that is already live, set both
 *   GASLESS_LIBRARY=<PrivateOPRFNotes> GASLESS_IMPLEMENTATION=<PrivateERC20Contract256Gasless>
 * The script checks that the implementation links that library.
 */

import hre from "hardhat";
import {
  PRIVATE_ERC20_256_GASLESS_FQN,
  PRIVATE_OPRF_NOTES_FQN,
  deployPrivateOPRFNotesLibrary,
  waitForDeploymentConfirmation,
} from "../test/helpers/testHelpers";
import { saveDeploymentRecord } from "./deployment-io";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const networkName = hre.network.name;

  console.log("Network:", networkName, "chainId:", chainId);
  console.log("Deployer:", deployer.address);
  console.log("Balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());

  const reuseLibrary = process.env.GASLESS_LIBRARY?.trim();
  const reuseImplementation = process.env.GASLESS_IMPLEMENTATION?.trim();
  let libraryAddress: string;
  let implementationAddress: string;
  if (reuseLibrary || reuseImplementation) {
    if (!reuseLibrary || !reuseImplementation) {
      throw new Error("Set both GASLESS_LIBRARY and GASLESS_IMPLEMENTATION, or neither");
    }
    libraryAddress = hre.ethers.getAddress(reuseLibrary);
    implementationAddress = hre.ethers.getAddress(reuseImplementation);
    const code = (await hre.ethers.provider.getCode(implementationAddress)).toLowerCase();
    if (!code.includes(libraryAddress.slice(2).toLowerCase())) {
      throw new Error(`Implementation ${implementationAddress} does not link PrivateOPRFNotes ${libraryAddress}`);
    }
    console.log("Reusing PrivateOPRFNotes:", libraryAddress);
    console.log("Reusing PrivateERC20Contract256Gasless:", implementationAddress);
  } else {
    libraryAddress = await deployPrivateOPRFNotesLibrary(hre, deployer);
    console.log("PrivateOPRFNotes:", libraryAddress);

    const Implementation = await hre.ethers.getContractFactory(PRIVATE_ERC20_256_GASLESS_FQN, {
      signer: deployer,
      libraries: { [PRIVATE_OPRF_NOTES_FQN]: libraryAddress },
    });
    const implementation = await Implementation.deploy();
    await implementation.waitForDeployment();
    await waitForDeploymentConfirmation(implementation, hre);
    implementationAddress = await implementation.getAddress();
    console.log("PrivateERC20Contract256Gasless:", implementationAddress);
  }

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

  const deploymentPath = saveDeploymentRecord(
    {
      network: networkName,
      chainId,
      gaslessFactory: {
        library: libraryAddress,
        implementation: implementationAddress,
        factory: factoryAddress,
        blockNumber,
        deployedAt: new Date().toISOString(),
      },
    },
    networkName
  );
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
