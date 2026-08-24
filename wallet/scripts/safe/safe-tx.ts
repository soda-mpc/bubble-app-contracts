import type { ContractRunner, Signer } from "ethers";
import { Contract, Interface, TypedDataEncoder, ZeroAddress } from "ethers";

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
  "function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
] as const;

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

export async function execSafeTransaction(
  safeAddress: string,
  signer: Signer,
  metaTx: SafeMetaTransaction,
  runner?: ContractRunner
): Promise<{ receipt: { status?: number | null }; safeTx: SafeTransaction }> {
  const provider = runner ?? signer.provider;
  if (!provider || !("getNetwork" in provider)) {
    throw new Error("Safe execution requires a provider");
  }

  const network = await (provider as { getNetwork: () => Promise<{ chainId: bigint }> }).getNetwork();
  const safe = new Contract(safeAddress, SAFE_EXEC_ABI, runner ?? signer) as Contract & {
    nonce: () => Promise<bigint>;
    execTransaction: (...args: unknown[]) => Promise<{ wait: () => Promise<{ status?: number | null }> }>;
  };
  const safeTx = await buildSafeTransaction(safe, metaTx);
  const signature = await signSafeTransaction(signer, safeAddress, network.chainId, safeTx);

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
    signature
  );
  const receipt = await tx.wait();
  if (!receipt || receipt.status !== 1) {
    throw new Error(`Safe execTransaction failed for call to ${metaTx.to}`);
  }
  return { receipt, safeTx };
}
