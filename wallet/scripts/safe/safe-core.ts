import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { Interface, ZeroAddress } from "ethers";
import {
  getProxyFactoryDeployment,
  getSafeL2SingletonDeployment,
} from "@safe-global/safe-deployments";
import type { SafeInfrastructureDeployment } from "./types";
import { getSafeL2Factory, getSafeProxyFactoryFactory } from "./safe-artifacts";

export const SAFE_VERSION = "1.4.1";

export type SafeInfrastructure = {
  safeL2Address: string;
  factoryAddress: string;
  source: "local" | "canonical";
};

export type DeployedSafe = {
  safeAddress: string;
  safe: Awaited<ReturnType<HardhatRuntimeEnvironment["ethers"]["getContractAt"]>>;
  singleton: string;
  factory: string;
  saltNonce: bigint;
};

async function hasBytecode(
  provider: { getCode: (address: string) => Promise<string> },
  address: string
): Promise<boolean> {
  const code = await provider.getCode(address);
  return code !== "0x" && code.length > 2;
}

function resolveCanonicalAddresses(chainId: number): SafeInfrastructure | undefined {
  const network = String(chainId);
  const singletonDeployment = getSafeL2SingletonDeployment({
    network,
    version: SAFE_VERSION,
    released: true,
  });
  const factoryDeployment = getProxyFactoryDeployment({
    network,
    version: SAFE_VERSION,
    released: true,
  });

  const singletonAddress = singletonDeployment?.networkAddresses?.[network];
  const factoryAddress = factoryDeployment?.networkAddresses?.[network];

  if (!singletonAddress || !factoryAddress) {
    return undefined;
  }

  return {
    safeL2Address: singletonAddress,
    factoryAddress,
    source: "canonical",
  };
}

export async function getOrDeploySafeInfrastructure(
  hre: HardhatRuntimeEnvironment
): Promise<SafeInfrastructure> {
  const network = await hre.ethers.provider.getNetwork();
  const chainId = Number(network.chainId);

  const canonical = resolveCanonicalAddresses(chainId);
  if (
    canonical &&
    (await hasBytecode(hre.ethers.provider, canonical.safeL2Address)) &&
    (await hasBytecode(hre.ethers.provider, canonical.factoryAddress))
  ) {
    return canonical;
  }

  const SafeL2 = await getSafeL2Factory(hre);
  const SafeProxyFactory = await getSafeProxyFactoryFactory(hre);

  const safeL2 = await SafeL2.deploy();
  await safeL2.waitForDeployment();

  const factory = await SafeProxyFactory.deploy();
  await factory.waitForDeployment();

  return {
    safeL2Address: await safeL2.getAddress(),
    factoryAddress: await factory.getAddress(),
    source: "local",
  };
}

export function encodeSafeSetup(
  owners: string[],
  threshold: number,
  fallbackHandler = ZeroAddress
): string {
  const setupInterface = new Interface([
    "function setup(address[] _owners,uint256 _threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address payable paymentReceiver)",
  ]);
  return setupInterface.encodeFunctionData("setup", [
    owners,
    threshold,
    ZeroAddress,
    "0x",
    fallbackHandler,
    ZeroAddress,
    0,
    ZeroAddress,
  ]);
}

export async function deploySafeWallet(
  hre: HardhatRuntimeEnvironment,
  owners: string[],
  threshold = owners.length,
  saltNonce = 42n
): Promise<DeployedSafe> {
  if (owners.length === 0) {
    throw new Error("Safe requires at least one owner");
  }
  if (threshold <= 0 || threshold > owners.length) {
    throw new Error("Invalid Safe threshold");
  }

  const infrastructure = await getOrDeploySafeInfrastructure(hre);
  const factory = await hre.ethers.getContractAt(
    [
      "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
    ],
    infrastructure.factoryAddress
  );

  const initializer = encodeSafeSetup(owners, threshold);
  const safeAddress = await factory.createProxyWithNonce.staticCall(
    infrastructure.safeL2Address,
    initializer,
    saltNonce
  );
  await (await factory.createProxyWithNonce(infrastructure.safeL2Address, initializer, saltNonce)).wait();

  const safe = await hre.ethers.getContractAt(
    [
      "function getOwners() view returns (address[])",
      "function getThreshold() view returns (uint256)",
      "function nonce() view returns (uint256)",
      "function VERSION() view returns (string)",
      "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
    ],
    safeAddress
  );

  return {
    safeAddress,
    safe,
    singleton: infrastructure.safeL2Address,
    factory: infrastructure.factoryAddress,
    saltNonce,
  };
}

export function toInfrastructureRecord(
  hreNetworkName: string,
  chainId: number,
  infrastructure: SafeInfrastructure
): SafeInfrastructureDeployment {
  return {
    network: hreNetworkName,
    chainId,
    deployedAt: new Date().toISOString(),
    version: SAFE_VERSION,
    source: infrastructure.source,
    safeL2: { address: infrastructure.safeL2Address },
    safeProxyFactory: { address: infrastructure.factoryAddress },
  };
}
