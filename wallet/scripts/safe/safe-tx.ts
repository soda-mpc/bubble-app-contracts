import type { ContractRunner, Signer } from "ethers";
import {
  Contract,
  Interface,
  TypedDataEncoder,
  ZeroAddress,
  ZeroHash,
  concat,
  getAddress,
  getBytes,
  solidityPacked,
  zeroPadValue,
} from "ethers";
import { getMultiSendCallOnlyDeployment } from "@safe-global/safe-deployments";
import { SAFE_VERSION } from "./safe-core";

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
  runner?: ContractRunner;
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
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
] as const;

const MULTISEND_ABI = new Interface(["function multiSend(bytes transactions)"]);

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

export function encodeContractCall(
  iface: Interface,
  functionName: string,
  args: readonly unknown[] = []
): string {
  return iface.encodeFunctionData(functionName, args);
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
    gasToken: ZeroAddress,
    refundReceiver: ZeroAddress,
    nonce: await safe.nonce(),
  };
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

/**
 * Pre-validated signature for when msg.sender is a Safe owner (v=1).
 * Counts as that owner's vote without a separate EIP-712 signature.
 */
export function buildPrevalidatedSignature(ownerAddress: string): string {
  const owner = getAddress(ownerAddress);
  return concat([zeroPadValue(owner, 32), ZeroHash, "0x01"]);
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

/** Safe expects sorted signatures; for 1-of-1 this is a single 65-byte signature. */
function normalizeSafeSignature(signature: string): string {
  if (signature.length !== 132) {
    return signature;
  }
  const v = parseInt(signature.slice(-2), 16);
  if (v === 27 || v === 28) {
    return signature;
  }
  if (v === 0 || v === 1) {
    return signature.slice(0, -2) + (v + 31).toString(16).padStart(2, "0");
  }
  return signature;
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
  extraSigners: Signer[] | undefined;
  safe: Contract & { getOwners: () => Promise<string[]>; getThreshold: () => Promise<bigint> };
  safeAddress: string;
  chainId: bigint | number;
  safeTx: SafeTransaction;
}): Promise<string> {
  const { signer, extraSigners, safe, safeAddress, chainId, safeTx } = params;
  const submitter = getAddress(await signer.getAddress());

  if (!extraSigners?.length) {
    return signSafeTransaction(signer, safeAddress, chainId, safeTx);
  }

  const owners = (await safe.getOwners()).map((owner) => getAddress(owner));
  const ownerSet = new Set(owners.map((owner) => owner.toLowerCase()));
  if (!ownerSet.has(submitter.toLowerCase())) {
    throw new Error(`Submitter ${submitter} is not a Safe owner`);
  }

  const collected: SafeSignature[] = [
    { signer: submitter, data: buildPrevalidatedSignature(submitter) },
  ];
  for (const extraSigner of extraSigners) {
    const address = getAddress(await extraSigner.getAddress());
    if (address.toLowerCase() === submitter.toLowerCase()) {
      continue;
    }
    if (!ownerSet.has(address.toLowerCase())) {
      throw new Error(`${address} is not a Safe owner`);
    }
    collected.push({
      signer: address,
      data: await signSafeTransaction(extraSigner, safeAddress, chainId, safeTx),
    });
  }

  const threshold = Number(await safe.getThreshold());
  if (collected.length < threshold) {
    throw new Error(`Safe threshold is ${threshold}, collected ${collected.length} signature(s)`);
  }
  return packSafeSignatures(collected);
}

export async function execSafeTransaction(
  safeAddress: string,
  signer: Signer,
  metaTx: SafeMetaTransaction,
  options?: SafeExecOptions
): Promise<{ receipt: { status?: number | null }; safeTx: SafeTransaction }> {
  const runner = options?.runner ?? signer;
  const provider = options?.runner ?? signer.provider;
  if (!provider || !("getNetwork" in provider)) {
    throw new Error("Safe execution requires a provider");
  }

  const network = await (provider as { getNetwork: () => Promise<{ chainId: bigint }> }).getNetwork();
  const safe = new Contract(safeAddress, SAFE_EXEC_ABI, runner) as Contract & {
    nonce: () => Promise<bigint>;
    getOwners: () => Promise<string[]>;
    getThreshold: () => Promise<bigint>;
    execTransaction: (...args: unknown[]) => Promise<{ wait: () => Promise<{ status?: number | null }> }>;
  };
  const safeTx = await buildSafeTransaction(safe, metaTx);
  const signatures = await collectSafeSignatures({
    signer,
    extraSigners: options?.extraSigners,
    safe,
    safeAddress,
    chainId: network.chainId,
    safeTx,
  });

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
    signatures
  );
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Safe execTransaction failed for call to ${metaTx.to}`);
  }
  return { receipt, safeTx };
}

/** Batch Calls into one Safe tx via MultiSendCallOnly (one threshold of signatures). */
export async function execSafeTransactions(
  safeAddress: string,
  signer: Signer,
  metaTxs: SafeMetaTransaction[],
  options?: SafeExecOptions
): Promise<{ receipt: { status?: number | null }; safeTx: SafeTransaction }> {
  if (metaTxs.length === 0) {
    throw new Error("execSafeTransactions requires at least one call");
  }
  if (metaTxs.length === 1) {
    return execSafeTransaction(safeAddress, signer, metaTxs[0], options);
  }

  const provider = options?.runner ?? signer.provider;
  if (!provider || !("getNetwork" in provider)) {
    throw new Error("Safe execution requires a provider");
  }
  const network = await (provider as { getNetwork: () => Promise<{ chainId: bigint }> }).getNetwork();
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
