import type { Signer } from "ethers";
import { Contract, Interface } from "ethers";
import { GCACL_ABI, getAppContractsConfig } from "~~/config/contracts";
import { buildItUint256 } from "../bubble/crypto";
import { encodeContractCall, execSafeTransaction } from "./safeTx";

const ERC20_WRITE_ABI = new Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const PRIVATE_TOKEN_ABI = new Interface([
  "function shield(uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function mintOPRFToken(tuple(address userAddress, tuple(uint256 ciphertextHigh, uint256 ciphertextLow) ciphertext) quantity)",
  "event OPRFMinted(address indexed user, uint256 x, uint256 y, uint256 q)",
]);

const GCACL_IFACE = new Interface([...GCACL_ABI]);

export async function readPrivateBalanceHandle(
  provider: { call: (tx: { to: string; data: string }) => Promise<string> } | Signer,
  privateToken: string,
  account: string
): Promise<bigint> {
  const contract = new Contract(privateToken, PRIVATE_TOKEN_ABI, provider as Signer);
  return BigInt(await contract["balanceOf(address)"](account));
}

export async function execSafeApprove(
  safeAddress: string,
  signer: Signer,
  tokenAddress: string,
  spender: string,
  amount: bigint
) {
  const data = encodeContractCall(ERC20_WRITE_ABI, "approve", [spender, amount]);
  return execSafeTransaction(safeAddress, signer, { to: tokenAddress, data });
}

export async function execSafeShield(
  safeAddress: string,
  signer: Signer,
  privateToken: string,
  amount: bigint
) {
  const data = encodeContractCall(PRIVATE_TOKEN_ABI, "shield", [amount]);
  return execSafeTransaction(safeAddress, signer, { to: privateToken, data });
}

/** Approve max needed then shield clear → private on the Safe. */
export async function shieldFromSafe(params: {
  safeAddress: string;
  signer: Signer;
  underlying: string;
  privateToken: string;
  amount: bigint;
}) {
  const { safeAddress, signer, underlying, privateToken, amount } = params;
  await execSafeApprove(safeAddress, signer, underlying, privateToken, amount);
  return execSafeShield(safeAddress, signer, privateToken, amount);
}

const VIEW_TTL_SECONDS = 365n * 24n * 60n * 60n;

export async function execSafePermitHandleView(params: {
  safeAddress: string;
  signer: Signer;
  viewer: string;
  handle: bigint;
  gcAcl?: string;
}) {
  const config = getAppContractsConfig();
  const gcAcl = params.gcAcl || config.gcAcl;
  if (!gcAcl) throw new Error("GCACL address not configured");
  const data = encodeContractCall(GCACL_IFACE, "permit", [params.handle, params.viewer]);
  return execSafeTransaction(params.safeAddress, params.signer, { to: gcAcl, data });
}

/** One-time Safe → EOA view on all handles from a private token (sodawallet-like decrypt UX). */
export async function execSafePermitContractView(params: {
  safeAddress: string;
  signer: Signer;
  viewer: string;
  privateToken: string;
  gcAcl?: string;
  ttlSeconds?: bigint;
}) {
  const config = getAppContractsConfig();
  const gcAcl = params.gcAcl || config.gcAcl;
  if (!gcAcl) throw new Error("GCACL address not configured");
  const expiration = BigInt(Math.floor(Date.now() / 1000)) + (params.ttlSeconds ?? VIEW_TTL_SECONDS);
  const data = encodeContractCall(GCACL_IFACE, "permitContractViewAccess", [
    params.viewer,
    params.privateToken,
    expiration,
  ]);
  return execSafeTransaction(params.safeAddress, params.signer, { to: gcAcl, data });
}

export async function isHandlePermitted(
  provider: Signer,
  handle: bigint,
  account: string,
  gcAcl?: string
): Promise<boolean> {
  const config = getAppContractsConfig();
  const address = gcAcl || config.gcAcl;
  if (!address) return false;
  const acl = new Contract(address, GCACL_ABI, provider);
  return Boolean(await acl.isPermitted(handle, account));
}

export async function isSafeContractViewPermitted(params: {
  provider: Signer;
  safeAddress: string;
  viewer: string;
  privateToken: string;
  gcAcl?: string;
}): Promise<boolean> {
  const config = getAppContractsConfig();
  const address = params.gcAcl || config.gcAcl;
  if (!address) return false;
  const acl = new Contract(address, GCACL_ABI, params.provider);
  return Boolean(
    await acl.isContractViewPermitted(params.safeAddress, params.viewer, params.privateToken)
  );
}

/**
 * Ensure the connected EOA can decrypt Safe-owned handles without (or with minimal) signing.
 *
 * Unsigned sodawallet-style decrypt needs `GCACL.permit(handle, eoa)` (handle-level).
 * Contract view alone only unlocks signed on-behalf decrypt (`owner=Safe`).
 */
export async function ensureSafeViewerAccess(params: {
  safeAddress: string;
  signer: Signer;
  viewer: string;
  privateToken: string;
  handle?: bigint;
}): Promise<{ granted: boolean; txHash?: string; mode: "none" | "handle" | "contract" }> {
  const { safeAddress, signer, viewer, privateToken, handle } = params;

  if (handle !== undefined && handle !== 0n) {
    const handleOk = await isHandlePermitted(signer, handle, viewer);
    if (handleOk) return { granted: false, mode: "none" };

    const tx = await execSafePermitHandleView({
      safeAddress,
      signer,
      viewer,
      handle,
    });
    return { granted: true, txHash: tx.hash, mode: "handle" };
  }

  const contractOk = await isSafeContractViewPermitted({
    provider: signer,
    safeAddress,
    viewer,
    privateToken,
  });
  if (contractOk) return { granted: false, mode: "none" };

  const tx = await execSafePermitContractView({
    safeAddress,
    signer,
    viewer,
    privateToken,
  });
  return { granted: true, txHash: tx.hash, mode: "contract" };
}

/** Batch: one Safe permit per missing handle (skips already-permitted). */
export async function ensureSafeViewerAccessForHandles(params: {
  safeAddress: string;
  signer: Signer;
  viewer: string;
  handles: bigint[];
}): Promise<{ txHashes: string[] }> {
  const txHashes: string[] = [];
  for (const handle of params.handles) {
    if (handle === 0n) continue;
    const ok = await isHandlePermitted(params.signer, handle, params.viewer);
    if (ok) continue;
    const tx = await execSafePermitHandleView({
      safeAddress: params.safeAddress,
      signer: params.signer,
      viewer: params.viewer,
      handle,
    });
    txHashes.push(tx.hash);
  }
  return { txHashes };
}

export async function mintOprfFromSafe(params: {
  safeAddress: string;
  signer: Signer;
  ownerAddress: string;
  privateToken: string;
  quantity: bigint;
  ownerAesKeyHex: string;
}) {
  const { safeAddress, signer, ownerAddress, privateToken, quantity, ownerAesKeyHex } = params;
  // IT userAddress = owner EOA (tx.origin when Safe executes)
  const quantityIt = buildItUint256({
    value: quantity,
    userAddress: ownerAddress,
    userAesKeyHex: ownerAesKeyHex,
    contractAddress: privateToken,
  });
  const data = encodeContractCall(PRIVATE_TOKEN_ABI, "mintOPRFToken", [quantityIt]);
  const result = await execSafeTransaction(safeAddress, signer, { to: privateToken, data });

  const iface = PRIVATE_TOKEN_ABI;
  const minted = (result.receipt.logs || [])
    .map((log) => {
      try {
        return iface.parseLog(log);
      } catch {
        return null;
      }
    })
    .find((parsed) => parsed?.name === "OPRFMinted");

  if (!minted) {
    throw new Error("OPRFMinted event not found in receipt");
  }

  return {
    ...result,
    user: minted.args[0] as string,
    xHandle: BigInt(minted.args[1]),
    yHandle: BigInt(minted.args[2]),
    qHandle: BigInt(minted.args[3]),
  };
}
