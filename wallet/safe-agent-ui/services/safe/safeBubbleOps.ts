import type { Signer } from "ethers";
import { Contract, Interface, Wallet } from "ethers";
import { GCACL_ABI, getAppContractsConfig } from "~~/config/contracts";
import { buildItUint256 } from "../bubble/crypto";
import {
  assertInformedApprove,
  assertInformedEncryptedTransfer,
  assertInformedPermitContractView,
  assertInformedShield,
  encodeApprove,
  encodeEncryptedTransfer,
  encodePermitContractView,
  encodeShield,
} from "./informedSign";
import { getDemoCoOwners } from "./multisigKeys";
import {
  encodeContractCall,
  execSafeTransaction,
  execSafeTransactions,
  type SafeExecOptions,
  type SafeMetaTransaction,
  type SafeSignature,
} from "./safeTx";

const ERC20_WRITE_ABI = new Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
]);

const PRIVATE_TOKEN_ABI = new Interface([
  "function shield(uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
  "function transfer(address to, tuple(address userAddress, tuple(uint256 ciphertextHigh, uint256 ciphertextLow) ciphertext) it) returns (bool)",
  "function mintOPRFToken(tuple(address userAddress, tuple(uint256 ciphertextHigh, uint256 ciphertextLow) ciphertext) quantity)",
  "event OPRFMinted(address indexed user, uint256 x, uint256 y, uint256 q)",
]);

const GCACL_IFACE = new Interface([...GCACL_ABI]);
const VIEW_TTL_SECONDS = 365n * 24n * 60n * 60n;

export async function readPrivateBalanceHandle(
  provider: { call: (tx: { to: string; data: string }) => Promise<string> } | Signer,
  privateToken: string,
  account: string
): Promise<bigint> {
  const contract = new Contract(privateToken, PRIVATE_TOKEN_ABI, provider as Signer);
  return BigInt(await contract["balanceOf(address)"](account));
}

/** Attach local demo co-owner wallets so threshold > 1 can execute in one browser. */
export function withDemoCoSigners(
  safeAddress: string,
  signer: Signer,
  options?: SafeExecOptions
): SafeExecOptions {
  const provider = signer.provider;
  const demo = getDemoCoOwners(safeAddress);
  if (!provider || demo.length === 0) {
    return options || {};
  }
  const extraSigners = demo.map((co) => new Wallet(co.privateKey, provider));
  return {
    ...options,
    extraSigners: [...(options?.extraSigners || []), ...extraSigners],
  };
}

export async function execSafeApprove(
  safeAddress: string,
  signer: Signer,
  tokenAddress: string,
  spender: string,
  amount: bigint,
  options?: SafeExecOptions
) {
  const data = encodeContractCall(ERC20_WRITE_ABI, "approve", [spender, amount]);
  return execSafeTransaction(
    safeAddress,
    signer,
    { to: tokenAddress, data },
    withDemoCoSigners(safeAddress, signer, options)
  );
}

export async function execSafeShield(
  safeAddress: string,
  signer: Signer,
  privateToken: string,
  amount: bigint,
  options?: SafeExecOptions
) {
  const data = encodeContractCall(PRIVATE_TOKEN_ABI, "shield", [amount]);
  return execSafeTransaction(
    safeAddress,
    signer,
    { to: privateToken, data },
    withDemoCoSigners(safeAddress, signer, options)
  );
}

/**
 * One MultiSend: approve + shield + permitContractViewAccess for every Safe owner.
 * Co-signers only approve one threshold round for the whole bootstrap.
 */
export async function shieldAndGrantViewToOwners(params: {
  safeAddress: string;
  signer: Signer;
  underlying: string;
  privateToken: string;
  amount: bigint;
  owners: string[];
  extraSignatures?: SafeSignature[];
  ttlSeconds?: bigint;
}) {
  const {
    safeAddress,
    signer,
    underlying,
    privateToken,
    amount,
    owners,
    extraSignatures,
    ttlSeconds = VIEW_TTL_SECONDS,
  } = params;
  const config = getAppContractsConfig();
  const gcAcl = config.gcAcl;
  if (!gcAcl) throw new Error("GCACL address not configured");

  const expiration = BigInt(Math.floor(Date.now() / 1000)) + ttlSeconds;
  const approveData = encodeApprove(privateToken, amount);
  assertInformedApprove(approveData, privateToken, amount);
  const shieldData = encodeShield(amount);
  assertInformedShield(shieldData, amount);

  const calls: SafeMetaTransaction[] = [
    { to: underlying, data: approveData },
    { to: privateToken, data: shieldData },
  ];
  for (const owner of owners) {
    const data = encodePermitContractView(owner, privateToken, expiration);
    assertInformedPermitContractView(data, owner, privateToken);
    calls.push({ to: gcAcl, data });
  }

  return execSafeTransactions(
    safeAddress,
    signer,
    calls,
    withDemoCoSigners(safeAddress, signer, { extraSignatures })
  );
}

/** Approve then shield (two Safe txs). Prefer shieldAndGrantViewToOwners for multisig. */
export async function shieldFromSafe(params: {
  safeAddress: string;
  signer: Signer;
  underlying: string;
  privateToken: string;
  amount: bigint;
  extraSignatures?: SafeSignature[];
}) {
  const { safeAddress, signer, underlying, privateToken, amount, extraSignatures } = params;
  await execSafeApprove(safeAddress, signer, underlying, privateToken, amount, { extraSignatures });
  return execSafeShield(safeAddress, signer, privateToken, amount, { extraSignatures });
}

export async function encryptedTransferFromSafe(params: {
  safeAddress: string;
  signer: Signer;
  ownerAddress: string;
  privateToken: string;
  recipient: string;
  amount: bigint;
  sharedAesKeyHex: string;
  extraSignatures?: SafeSignature[];
}) {
  const {
    safeAddress,
    signer,
    ownerAddress,
    privateToken,
    recipient,
    amount,
    sharedAesKeyHex,
    extraSignatures,
  } = params;

  const it = buildItUint256({
    value: amount,
    userAddress: ownerAddress,
    userAesKeyHex: sharedAesKeyHex,
    contractAddress: privateToken,
  });
  const data = encodeEncryptedTransfer(recipient, it);
  assertInformedEncryptedTransfer({
    data,
    sharedAesKey: sharedAesKeyHex,
    expectedRecipient: recipient,
    expectedAmount: amount,
    expectedUserAddress: ownerAddress,
  });

  return execSafeTransaction(
    safeAddress,
    signer,
    { to: privateToken, data },
    withDemoCoSigners(safeAddress, signer, { extraSignatures })
  );
}

export async function execSafePermitHandleView(params: {
  safeAddress: string;
  signer: Signer;
  viewer: string;
  handle: bigint;
  gcAcl?: string;
  extraSignatures?: SafeSignature[];
}) {
  const config = getAppContractsConfig();
  const gcAcl = params.gcAcl || config.gcAcl;
  if (!gcAcl) throw new Error("GCACL address not configured");
  const data = encodeContractCall(GCACL_IFACE, "permit", [params.handle, params.viewer]);
  return execSafeTransaction(
    params.safeAddress,
    params.signer,
    { to: gcAcl, data },
    withDemoCoSigners(params.safeAddress, params.signer, {
      extraSignatures: params.extraSignatures,
    })
  );
}

export async function execSafePermitContractView(params: {
  safeAddress: string;
  signer: Signer;
  viewer: string;
  privateToken: string;
  gcAcl?: string;
  ttlSeconds?: bigint;
  extraSignatures?: SafeSignature[];
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
  return execSafeTransaction(
    params.safeAddress,
    params.signer,
    { to: gcAcl, data },
    withDemoCoSigners(params.safeAddress, params.signer, {
      extraSignatures: params.extraSignatures,
    })
  );
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
 * Prefer contract view (owner=Safe decrypt). Falls back to handle permit for 1-of-1 demos.
 */
export async function ensureSafeViewerAccess(params: {
  safeAddress: string;
  signer: Signer;
  viewer: string;
  privateToken: string;
  handle?: bigint;
  preferContractView?: boolean;
  extraSignatures?: SafeSignature[];
}): Promise<{ granted: boolean; txHash?: string; mode: "none" | "handle" | "contract" }> {
  const {
    safeAddress,
    signer,
    viewer,
    privateToken,
    handle,
    preferContractView = true,
    extraSignatures,
  } = params;

  if (preferContractView) {
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
      extraSignatures,
    });
    return { granted: true, txHash: tx.hash, mode: "contract" };
  }

  if (handle !== undefined && handle !== 0n) {
    const handleOk = await isHandlePermitted(signer, handle, viewer);
    if (handleOk) return { granted: false, mode: "none" };

    const tx = await execSafePermitHandleView({
      safeAddress,
      signer,
      viewer,
      handle,
      extraSignatures,
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
    extraSignatures,
  });
  return { granted: true, txHash: tx.hash, mode: "contract" };
}

export async function ensureSafeViewerAccessForHandles(params: {
  safeAddress: string;
  signer: Signer;
  viewer: string;
  handles: bigint[];
  gcAcl?: string;
  extraSignatures?: SafeSignature[];
}): Promise<{ txHash?: string; permittedCount: number }> {
  const config = getAppContractsConfig();
  const gcAcl = params.gcAcl || config.gcAcl;
  if (!gcAcl) throw new Error("GCACL address not configured");

  const needPermit: bigint[] = [];
  for (const handle of params.handles) {
    if (handle === 0n) continue;
    const ok = await isHandlePermitted(params.signer, handle, params.viewer, gcAcl);
    if (!ok) needPermit.push(handle);
  }
  if (needPermit.length === 0) {
    return { permittedCount: 0 };
  }

  const calls = needPermit.map((handle) => ({
    to: gcAcl,
    data: encodeContractCall(GCACL_IFACE, "permit", [handle, params.viewer]),
  }));
  const result = await execSafeTransactions(
    params.safeAddress,
    params.signer,
    calls,
    withDemoCoSigners(params.safeAddress, params.signer, {
      extraSignatures: params.extraSignatures,
    })
  );
  return { txHash: result.hash, permittedCount: needPermit.length };
}

export async function mintOprfFromSafe(params: {
  safeAddress: string;
  signer: Signer;
  ownerAddress: string;
  privateToken: string;
  quantity: bigint;
  ownerAesKeyHex: string;
  extraSignatures?: SafeSignature[];
}) {
  const { safeAddress, signer, ownerAddress, privateToken, quantity, ownerAesKeyHex, extraSignatures } =
    params;
  const quantityIt = buildItUint256({
    value: quantity,
    userAddress: ownerAddress,
    userAesKeyHex: ownerAesKeyHex,
    contractAddress: privateToken,
  });
  const data = encodeContractCall(PRIVATE_TOKEN_ABI, "mintOPRFToken", [quantityIt]);
  const result = await execSafeTransaction(
    safeAddress,
    signer,
    { to: privateToken, data },
    withDemoCoSigners(safeAddress, signer, { extraSignatures })
  );

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
