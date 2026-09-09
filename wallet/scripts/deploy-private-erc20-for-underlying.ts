/**
 * Deploy current PrivateERC20Contract256 (UUPS via ERC1967Proxy) for an existing underlying.
 *
 * Default network target: Arbitrum Sepolia + TestUSDC from scripts/deployments/sepolia-arbitrum.json
 *
 * Env:
 *   UNDERLYING_ADDRESS  – default from deployment JSON testToken / privateToken.underlying
 *   TOKEN_NAME          – default "Private TUSDC v2"
 *   TOKEN_SYMBOL        – default "pTUSDC2"
 *   MASTER_ADDRESS      – default deployer
 *   OWNER_ADDRESS       – default deployer
 *   GASLESS=1           – deploy PrivateERC20Contract256Gasless instead
 *
 * Example:
 *   npx hardhat run scripts/deploy-private-erc20-for-underlying.ts --network sepolia-arbitrum
 */

import * as fs from "fs";
import hre from "hardhat";
import {
  deployPrivateToken,
  deployPrivateTokenGasless,
} from "../test/helpers/testHelpers";
import { getDeploymentFilePath, loadDeploymentResult } from "./deployment-io";

async function main() {
  const [deployer] = await hre.ethers.getSigners();
  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);
  const networkName = hre.network.name;

  const deploymentPath = getDeploymentFilePath(networkName);
  let existingUnderlying: string | undefined;
  let existingJson: Record<string, unknown> | undefined;
  if (fs.existsSync(deploymentPath)) {
    existingJson = loadDeploymentResult(deploymentPath) as unknown as Record<string, unknown>;
    const pt = existingJson.privateToken as { underlying?: string } | undefined;
    const tt = existingJson.testToken as { address?: string } | undefined;
    existingUnderlying = pt?.underlying || tt?.address;
  }

  const underlying =
    process.env.UNDERLYING_ADDRESS ||
    existingUnderlying ||
    "0x15DF3e9761cEc63234c53b8aa576479219d6f789";
  const tokenName = process.env.TOKEN_NAME || "Private TUSDC v2";
  const tokenSymbol = process.env.TOKEN_SYMBOL || "pTUSDC2";
  const ownerAddress = process.env.OWNER_ADDRESS || deployer.address;
  const masterAddress = process.env.MASTER_ADDRESS || deployer.address;
  const gasless = process.env.GASLESS === "1" || process.env.GASLESS === "true";

  console.log("Network:", networkName, "chainId:", chainId);
  console.log("Deployer:", deployer.address);
  console.log("Balance:", (await hre.ethers.provider.getBalance(deployer.address)).toString());
  console.log("Underlying:", underlying);
  console.log("Variant:", gasless ? "PrivateERC20Contract256Gasless" : "PrivateERC20Contract256");
  console.log("Token:", tokenName, tokenSymbol);
  console.log("Owner:", ownerAddress);
  console.log("Master:", masterAddress);

  const deployFn = gasless ? deployPrivateTokenGasless : deployPrivateToken;
  const privateToken = await deployFn(hre, deployer, {
    underlyingAddress: underlying,
    ownerAddress,
    masterAddress,
    name: tokenName,
    symbol: tokenSymbol,
    underlyingIsWrappedNative: false,
  });

  const proxyAddress = await privateToken.getAddress();
  const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
  const implRaw = await hre.ethers.provider.getStorage(proxyAddress, implSlot);
  const implAddress = hre.ethers.getAddress("0x" + implRaw.slice(-40));
  const blockNumber = await hre.ethers.provider.getBlockNumber();

  // Confirm redeemManyToUnderlying is present on the new impl
  const implCode = await hre.ethers.provider.getCode(implAddress);
  const redeemSel = hre.ethers.id(
    "redeemManyToUnderlying(((address,uint256),(address,(uint256,uint256)),uint128)[],(address,(uint256,uint256)),address,bool)"
  ).slice(2, 10);
  const hasRedeem = implCode.toLowerCase().includes(redeemSel.toLowerCase());
  console.log("\nProxy:", proxyAddress);
  console.log("Implementation:", implAddress);
  console.log("redeemManyToUnderlying selector present:", hasRedeem);
  if (!hasRedeem) {
    throw new Error("Deployed implementation is missing redeemManyToUnderlying — aborting");
  }

  const onChainUnderlying = await privateToken.underlying();
  const onChainName = await privateToken.name();
  const onChainSymbol = await privateToken.symbol();
  console.log("on-chain name/symbol/underlying:", onChainName, onChainSymbol, onChainUnderlying);

  // Persist: keep legacy token, add/replace privateToken with the new one
  const next = {
    ...(existingJson || {
      network: networkName,
      chainId,
      testToken: {
        address: underlying,
        name: "Test USDC",
        symbol: "TUSDC",
        decimals: 18,
        blockNumber,
      },
    }),
    deployedAt: new Date().toISOString(),
    chainId,
    network: networkName,
    privateTokenLegacy: (existingJson as any)?.privateToken,
    privateToken: {
      address: proxyAddress,
      implementation: implAddress,
      name: onChainName,
      symbol: onChainSymbol,
      underlying: onChainUnderlying,
      variant: gasless ? "PrivateERC20Contract256Gasless" : "PrivateERC20Contract256",
      blockNumber,
      hasRedeemManyToUnderlying: true,
    },
  };

  fs.mkdirSync(require("path").dirname(deploymentPath), { recursive: true });
  fs.writeFileSync(deploymentPath, `${JSON.stringify(next, null, 2)}\n`, "utf-8");
  console.log("\nWrote", deploymentPath);

  console.log("\n=== Set in safe-agent-ui/.env.local ===");
  console.log(`NEXT_PUBLIC_UNDERLYING=${onChainUnderlying}`);
  console.log(`NEXT_PUBLIC_PRIVATE_ERC20=${proxyAddress}`);
  console.log("\nThen remint notes against the new private token (old notes are bound to the old contract).");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
