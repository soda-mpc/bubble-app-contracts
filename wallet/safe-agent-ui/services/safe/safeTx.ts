import type { Provider, Signer } from "ethers";
import {
  Contract,
  Interface,
  TypedDataEncoder,
  ZeroHash,
  concat,
  getAddress,
  getBytes,
  solidityPacked,
  zeroPadValue,
} from "ethers";
import { getMultiSendCallOnlyDeployment } from "@safe-global/safe-deployments";
import { resolveTxFeeOverrides } from "../web3/txFeeOverrides";
import { SAFE_VERSION } from "./safeService";

export const SafeOperation = {
  Call: 0,
  DelegateCall: 1,
} as const;

export type SafeMetaTransaction = {
  to: string;
  value?: bigint;
  data?: string;
  operation?: number;
};

export type SafeTransaction = {
  to: string;
  value: bigint;
  data: string;
  operation: number;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: string;
  refundReceiver: string;
  nonce: bigint;
};

export type SafeSignature = {
  signer: string;
  data: string;
};

export type SafeExecOptions = {
  /** Already-signed EIP-712 owner signatures (65-byte hex). */
  extraSignatures?: SafeSignature[];
  /** Local demo co-owner wallets that will EIP-712-sign the built SafeTx. */
  extraSigners?: Signer[];
};

const EIP712_SAFE_TX_TYPE = {
  SafeTx: [
    { type: "address", name: "to" },
    { type: "uint256", name: "value" },
    { type: "bytes", name: "data" },
    { type: "uint8", name: "operation" },
    { type: "uint256", name: "safeTxGas" },
    { type: "uint256", name: "baseGas" },
    { type: "uint256", name: "gasPrice" },
    { type: "address", name: "gasToken" },
    { type: "address", name: "refundReceiver" },
    { type: "uint256", name: "nonce" },
  ],
};

const SAFE_EXEC_ABI = [
  "function nonce() view returns (uint256)",
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
] as const;

const MULTISEND_ABI = new Interface(["function multiSend(bytes transactions)"]);

export function encodeContractCall(
  iface: Interface,
  functionName: string,
  args: readonly unknown[] = []
): string {
  return iface.encodeFunctionData(functionName, args);
}

/**
 * Pre-validated signature for when msg.sender is a Safe owner (v=1).
 * Avoids a separate MetaMask EIP-712 popup — only the execTransaction send is needed.
 */
export function buildPrevalidatedSignature(ownerAddress: string): string {
  const owner = getAddress(ownerAddress);
  return concat([zeroPadValue(owner, 32), ZeroHash, "0x01"]);
}

function encodeMultiSendData(txs: SafeMetaTransaction[]): string {
  return (
    "0x" +
    txs
      .map((tx) => {
        const data = getBytes(tx.data ?? "0x");
        return solidityPacked(
          ["uint8", "address", "uint256", "uint256", "bytes"],
          [tx.operation ?? SafeOperation.Call, tx.to, tx.value ?? 0n, data.length, data]
        ).slice(2);
      })
      .join("")
  );
}

function resolveMultiSendCallOnly(chainId: number): string {
  const deployment = getMultiSendCallOnlyDeployment({
    version: SAFE_VERSION,
    network: String(chainId),
    released: true,
  });
  const address = deployment?.networkAddresses?.[String(chainId)];
  if (!address) {
    throw new Error(`No MultiSendCallOnly ${SAFE_VERSION} on chain ${chainId}`);
  }
  return getAddress(address);
}

export async function buildSafeTransaction(
  safe: { nonce: () => Promise<bigint> },
  metaTx: SafeMetaTransaction
): Promise<SafeTransaction> {
  return {
    to: metaTx.to,
    value: metaTx.value ?? 0n,
    data: metaTx.data ?? "0x",
    operation: metaTx.operation ?? SafeOperation.Call,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: "0x0000000000000000000000000000000000000000",
    refundReceiver: "0x0000000000000000000000000000000000000000",
    nonce: await safe.nonce(),
  };
}

function normalizeSafeSignature(signature: string): string {
  if (signature.length !== 132) return signature;
  const v = parseInt(signature.slice(-2), 16);
  if (v === 27 || v === 28) return signature;
  if (v === 0 || v === 1) {
    return signature.slice(0, -2) + (v + 31).toString(16).padStart(2, "0");
  }
  return signature;
}

export async function signSafeTransaction(
  signer: Signer,
  safeAddress: string,
  chainId: bigint | number,
  safeTx: SafeTransaction
): Promise<string> {
  const signature = await signer.signTypedData(
    { chainId, verifyingContract: safeAddress },
    EIP712_SAFE_TX_TYPE,
    {
      to: safeTx.to,
      value: safeTx.value,
      data: safeTx.data,
      operation: safeTx.operation,
      safeTxGas: safeTx.safeTxGas,
      baseGas: safeTx.baseGas,
      gasPrice: safeTx.gasPrice,
      gasToken: safeTx.gasToken,
      refundReceiver: safeTx.refundReceiver,
      nonce: safeTx.nonce,
    }
  );
  return normalizeSafeSignature(signature);
}

/** Concatenate 65-byte signatures in strictly increasing owner-address order (Safe v1.4.1). */
export function packSafeSignatures(signatures: SafeSignature[]): string {
  if (signatures.length === 0) {
    throw new Error("Safe requires at least one signature");
  }
  const sorted = [...signatures].sort((a, b) => {
    const left = getAddress(a.signer).toLowerCase();
    const right = getAddress(b.signer).toLowerCase();
    if (left < right) return -1;
    if (left > right) return 1;
    return 0;
  });
  for (let i = 1; i < sorted.length; i++) {
    if (getAddress(sorted[i].signer) === getAddress(sorted[i - 1].signer)) {
      throw new Error(`Duplicate Safe signer ${sorted[i].signer}`);
    }
  }
  return concat(sorted.map((signature) => signature.data));
}

export function calculateSafeTransactionHash(
  safeAddress: string,
  chainId: bigint | number,
  safeTx: SafeTransaction
): string {
  return TypedDataEncoder.hash(
    { chainId, verifyingContract: safeAddress },
    EIP712_SAFE_TX_TYPE,
    {
      to: safeTx.to,
      value: safeTx.value,
      data: safeTx.data,
      operation: safeTx.operation,
      safeTxGas: safeTx.safeTxGas,
      baseGas: safeTx.baseGas,
      gasPrice: safeTx.gasPrice,
      gasToken: safeTx.gasToken,
      refundReceiver: safeTx.refundReceiver,
      nonce: safeTx.nonce,
    }
  );
}

async function collectSafeSignatures(params: {
  signer: Signer;
  safe: Contract & { getOwners: () => Promise<string[]>; getThreshold: () => Promise<bigint> };
  safeAddress: string;
  chainId: bigint | number;
  safeTx: SafeTransaction;
  extraSignatures?: SafeSignature[];
  extraSigners?: Signer[];
}): Promise<string> {
  const { signer, safe, safeAddress, chainId, safeTx, extraSignatures, extraSigners } = params;
  const submitter = getAddress(await signer.getAddress());
  const owners = (await safe.getOwners()).map((owner) => getAddress(owner));
  const ownerSet = new Set(owners.map((owner) => owner.toLowerCase()));
  const threshold = Number(await safe.getThreshold());

  if (!ownerSet.has(submitter.toLowerCase())) {
    throw new Error(`Submitter ${submitter} is not a Safe owner`);
  }

  if (threshold === 1) {
    return buildPrevalidatedSignature(submitter);
  }

  const collected: SafeSignature[] = [
    { signer: submitter, data: buildPrevalidatedSignature(submitter) },
  ];
  const have = new Set([submitter.toLowerCase()]);

  for (const extra of extraSignatures || []) {
    const address = getAddress(extra.signer);
    if (have.has(address.toLowerCase())) continue;
    if (!ownerSet.has(address.toLowerCase())) {
      throw new Error(`${address} is not a Safe owner`);
    }
    collected.push({ signer: address, data: normalizeSafeSignature(extra.data) });
    have.add(address.toLowerCase());
  }

  for (const extraSigner of extraSigners || []) {
    if (collected.length >= threshold) break;
    const address = getAddress(await extraSigner.getAddress());
    if (have.has(address.toLowerCase())) continue;
    if (!ownerSet.has(address.toLowerCase())) {
      throw new Error(`${address} is not a Safe owner`);
    }
    collected.push({
      signer: address,
      data: await signSafeTransaction(extraSigner, safeAddress, chainId, safeTx),
    });
    have.add(address.toLowerCase());
  }

  if (collected.length < threshold) {
    throw new Error(
      `Safe threshold is ${threshold}; need ${threshold - collected.length} more owner signature(s). Paste co-signer EIP-712 signatures or generate demo co-owners on the Safe page.`
    );
  }
  return packSafeSignatures(collected);
}

export type ExecResult = {
  receipt: {
    status?: number | null;
    logs?: readonly { topics: readonly string[]; data: string }[];
  };
  safeTx: SafeTransaction;
  hash: string;
};

export async function execSafeTransaction(
  safeAddress: string,
  signer: Signer,
  metaTx: SafeMetaTransaction,
  options?: SafeExecOptions
): Promise<ExecResult> {
  const provider = signer.provider;
  if (!provider) {
    throw new Error("Safe execution requires a provider");
  }

  const network = await provider.getNetwork();
  const safe = new Contract(safeAddress, SAFE_EXEC_ABI, signer) as Contract & {
    nonce: () => Promise<bigint>;
    getOwners: () => Promise<string[]>;
    getThreshold: () => Promise<bigint>;
    execTransaction: (
      ...args: unknown[]
    ) => Promise<{
      wait: () => Promise<{
        status?: number | null;
        logs?: readonly { topics: readonly string[]; data: string }[];
        hash?: string;
      }>;
      hash: string;
    }>;
  };
  const safeTx = await buildSafeTransaction(safe, metaTx);
  const signatures = await collectSafeSignatures({
    signer,
    safe,
    safeAddress,
    chainId: network.chainId,
    safeTx,
    extraSignatures: options?.extraSignatures,
    extraSigners: options?.extraSigners,
  });
  const feeOverrides = await resolveTxFeeOverrides(provider as Provider);

  const tx = await safe.execTransaction(
    safeTx.to,
    safeTx.value,
    safeTx.data,
    safeTx.operation,
    safeTx.safeTxGas,
    safeTx.baseGas,
    safeTx.gasPrice,
    safeTx.gasToken,
    safeTx.refundReceiver,
    signatures,
    feeOverrides
  );
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Safe execTransaction failed for call to ${metaTx.to}`);
  }
  return { receipt, safeTx, hash: tx.hash };
}

/** Batch Calls into one Safe tx via MultiSendCallOnly. */
export async function execSafeTransactions(
  safeAddress: string,
  signer: Signer,
  metaTxs: SafeMetaTransaction[],
  options?: SafeExecOptions
): Promise<ExecResult> {
  if (metaTxs.length === 0) {
    throw new Error("execSafeTransactions requires at least one call");
  }
  if (metaTxs.length === 1) {
    return execSafeTransaction(safeAddress, signer, metaTxs[0], options);
  }

  const provider = signer.provider;
  if (!provider) throw new Error("Safe execution requires a provider");
  const network = await provider.getNetwork();
  const multiSendAddress = resolveMultiSendCallOnly(Number(network.chainId));
  const packed = encodeMultiSendData(
    metaTxs.map((tx) => ({
      ...tx,
      operation: tx.operation ?? SafeOperation.Call,
    }))
  );
  const data = MULTISEND_ABI.encodeFunctionData("multiSend", [packed]);

  return execSafeTransaction(
    safeAddress,
    signer,
    {
      to: multiSendAddress,
      data,
      operation: SafeOperation.DelegateCall,
    },
    options
  );
}

/** Preview a Safe tx (for co-signers) without executing. */
export async function previewSafeTransaction(
  safeAddress: string,
  signer: Signer,
  metaTx: SafeMetaTransaction
): Promise<{ safeTx: SafeTransaction; hash: string; chainId: number }> {
  const provider = signer.provider;
  if (!provider) throw new Error("Safe preview requires a provider");
  const network = await provider.getNetwork();
  const safe = new Contract(safeAddress, SAFE_EXEC_ABI, signer) as Contract & {
    nonce: () => Promise<bigint>;
  };
  const safeTx = await buildSafeTransaction(safe, metaTx);
  const hash = calculateSafeTransactionHash(safeAddress, network.chainId, safeTx);
  return { safeTx, hash, chainId: Number(network.chainId) };
}
