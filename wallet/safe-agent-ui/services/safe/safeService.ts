import {
  BrowserProvider,
  Contract,
  Interface,
  JsonRpcSigner,
  ZeroAddress,
  getAddress,
  isAddress,
} from "ethers";
import {
  getProxyFactoryDeployment,
  getSafeL2SingletonDeployment,
} from "@safe-global/safe-deployments";
import { SAFE_ABI, SAFE_PROXY_FACTORY_ABI } from "~~/config/contracts";
import { readJson, storageKeys, writeJson } from "../storage/localStore";
import { resolveTxFeeOverrides } from "../web3/txFeeOverrides";

export const SAFE_VERSION = "1.4.1";

export type ActiveSafe = {
  address: `0x${string}`;
  source: "import" | "deploy" | "env";
  owners: string[];
  threshold: number;
  version?: string;
};

export function getStoredSafe(): ActiveSafe | null {
  return readJson<ActiveSafe | null>(storageKeys.safe, null);
}

export function setStoredSafe(safe: ActiveSafe | null) {
  writeJson(storageKeys.safe, safe);
}

function getSignerProvider(signer: JsonRpcSigner | BrowserProvider) {
  if ("provider" in signer && signer.provider) return signer.provider;
  return signer as BrowserProvider;
}

export async function readSafeInfo(
  provider: BrowserProvider,
  safeAddress: string
): Promise<{ owners: string[]; threshold: number; version: string; nonce: bigint }> {
  if (!isAddress(safeAddress)) {
    throw new Error("Invalid Safe address");
  }
  const safe = new Contract(getAddress(safeAddress), SAFE_ABI, provider);
  const [owners, threshold, version, nonce] = await Promise.all([
    safe.getOwners() as Promise<string[]>,
    safe.getThreshold() as Promise<bigint>,
    safe.VERSION() as Promise<string>,
    safe.nonce() as Promise<bigint>,
  ]);
  return {
    owners,
    threshold: Number(threshold),
    version,
    nonce,
  };
}

export async function importSafeForOwner(
  provider: BrowserProvider,
  safeAddress: string,
  ownerAddress: string
): Promise<ActiveSafe> {
  const info = await readSafeInfo(provider, safeAddress);
  const isOwner = info.owners.some((o) => o.toLowerCase() === ownerAddress.toLowerCase());
  if (!isOwner) {
    throw new Error(`Connected account is not an owner of ${safeAddress}`);
  }
  const active: ActiveSafe = {
    address: getAddress(safeAddress) as `0x${string}`,
    source: "import",
    owners: info.owners,
    threshold: info.threshold,
    version: info.version,
  };
  setStoredSafe(active);
  return active;
}

function encodeSafeSetup(owners: string[], threshold: number): string {
  const setupInterface = new Interface([
    "function setup(address[] _owners,uint256 _threshold,address to,bytes data,address fallbackHandler,address paymentToken,uint256 payment,address payable paymentReceiver)",
  ]);
  return setupInterface.encodeFunctionData("setup", [
    owners,
    threshold,
    ZeroAddress,
    "0x",
    ZeroAddress,
    ZeroAddress,
    0,
    ZeroAddress,
  ]);
}

function resolveCanonicalSafeAddresses(chainId: number): { singleton: string; factory: string } {
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
  const singleton = singletonDeployment?.networkAddresses?.[network];
  const factory = factoryDeployment?.networkAddresses?.[network];
  if (!singleton || !factory) {
    throw new Error(`No canonical Safe ${SAFE_VERSION} deployments for chain ${chainId}`);
  }
  return { singleton, factory };
}

export async function deployOneOfOneSafe(
  signer: JsonRpcSigner,
  ownerAddress: string,
  saltNonce = BigInt(Date.now())
): Promise<ActiveSafe & { deployTxHash: string }> {
  return deploySafeWallet(signer, [ownerAddress], 1, saltNonce);
}

export async function deploySafeWallet(
  signer: JsonRpcSigner,
  owners: string[],
  threshold: number,
  saltNonce = BigInt(Date.now())
): Promise<ActiveSafe & { deployTxHash: string }> {
  const normalizedOwners = owners.map((o) => getAddress(o));
  if (normalizedOwners.length === 0) {
    throw new Error("Safe requires at least one owner");
  }
  if (threshold < 1 || threshold > normalizedOwners.length) {
    throw new Error(`Invalid threshold ${threshold} for ${normalizedOwners.length} owners`);
  }
  const unique = new Set(normalizedOwners.map((o) => o.toLowerCase()));
  if (unique.size !== normalizedOwners.length) {
    throw new Error("Duplicate owners are not allowed");
  }

  const provider = getSignerProvider(signer);
  const network = await provider.getNetwork();
  const { singleton, factory: factoryAddress } = resolveCanonicalSafeAddresses(Number(network.chainId));

  const factory = new Contract(factoryAddress, SAFE_PROXY_FACTORY_ABI, signer);
  const initializer = encodeSafeSetup(normalizedOwners, threshold);
  const predicted: string = await factory.createProxyWithNonce.staticCall(
    singleton,
    initializer,
    saltNonce
  );
  const feeOverrides = await resolveTxFeeOverrides(provider as BrowserProvider);
  const tx = await factory.createProxyWithNonce(singleton, initializer, saltNonce, feeOverrides);
  await tx.wait();

  const info = await readSafeInfo(provider as BrowserProvider, predicted);
  const active: ActiveSafe & { deployTxHash: string } = {
    address: getAddress(predicted) as `0x${string}`,
    source: "deploy",
    owners: info.owners,
    threshold: info.threshold,
    version: info.version,
    deployTxHash: tx.hash as string,
  };
  setStoredSafe({
    address: active.address,
    source: active.source,
    owners: active.owners,
    threshold: active.threshold,
    version: active.version,
  });
  return active;
}
