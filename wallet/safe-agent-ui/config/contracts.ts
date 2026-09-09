export const ARBITRUM_SEPOLIA_CHAIN_ID = 421614;

/** GCACL on Arbitrum Sepolia (from bubble-core-contracts / wallet tests). */
export const GCACL_ADDRESSES: Record<number, `0x${string}`> = {
  [ARBITRUM_SEPOLIA_CHAIN_ID]: "0x78F7Aa55A2c86D90dd9FDf8F9affE786672a23b6",
};

export const BUBBLE_PROXY_URL =
  process.env.NEXT_PUBLIC_BUBBLE_PROXY_URL || "https://proxy.bubble.sodalabs.net";

export const FACILITATOR_URL = process.env.NEXT_PUBLIC_FACILITATOR_URL || "";

export type AppContractsConfig = {
  chainId: number;
  safeAddress: `0x${string}` | "";
  privateErc20: `0x${string}` | "";
  underlying: `0x${string}` | "";
  gcAcl: `0x${string}` | "";
  bubbleProxyUrl: string;
  facilitatorUrl: string;
};

function asAddress(value: string | undefined): `0x${string}` | "" {
  const trimmed = value?.trim();
  if (!trimmed) return "";
  if (!/^0x[a-fA-F0-9]{40}$/.test(trimmed)) return "";
  return trimmed as `0x${string}`;
}

export function getAppContractsConfig(): AppContractsConfig {
  const chainId = Number(process.env.NEXT_PUBLIC_CHAIN_ID || ARBITRUM_SEPOLIA_CHAIN_ID);
  return {
    chainId,
    safeAddress: asAddress(process.env.NEXT_PUBLIC_SAFE_ADDRESS),
    privateErc20: asAddress(process.env.NEXT_PUBLIC_PRIVATE_ERC20),
    underlying: asAddress(process.env.NEXT_PUBLIC_UNDERLYING),
    gcAcl: asAddress(process.env.NEXT_PUBLIC_GCACL) || GCACL_ADDRESSES[chainId] || "",
    bubbleProxyUrl: process.env.NEXT_PUBLIC_BUBBLE_PROXY_URL || BUBBLE_PROXY_URL,
    facilitatorUrl: process.env.NEXT_PUBLIC_FACILITATOR_URL || FACILITATOR_URL,
  };
}

export const SAFE_ABI = [
  "function getOwners() view returns (address[])",
  "function getThreshold() view returns (uint256)",
  "function VERSION() view returns (string)",
  "function nonce() view returns (uint256)",
  "function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool success)",
] as const;

export const SAFE_PROXY_FACTORY_ABI = [
  "function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)",
] as const;

export const ERC20_ABI = [
  {
    type: "function",
    name: "name",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "symbol",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "string" }],
  },
  {
    type: "function",
    name: "decimals",
    stateMutability: "view",
    inputs: [],
    outputs: [{ name: "", type: "uint8" }],
  },
  {
    type: "function",
    name: "balanceOf",
    stateMutability: "view",
    inputs: [{ name: "account", type: "address" }],
    outputs: [{ name: "", type: "uint256" }],
  },
  {
    type: "function",
    name: "approve",
    stateMutability: "nonpayable",
    inputs: [
      { name: "spender", type: "address" },
      { name: "amount", type: "uint256" },
    ],
    outputs: [{ name: "", type: "bool" }],
  },
  {
    type: "function",
    name: "allowance",
    stateMutability: "view",
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
    ],
    outputs: [{ name: "", type: "uint256" }],
  },
] as const;

export const GCACL_ABI = [
  "function permit(uint256 handle, address account)",
  "function permitFullInsertAccess(address permittee, uint64 expirationDate)",
  "function permitContractViewAccess(address permittee, address contractAddress, uint64 expirationDate)",
  "function permitFullViewAccess(address permittee, uint64 expirationDate)",
  "function isFullInsertPermitted(address permitter, address permittee) view returns (bool)",
  "function isPermitted(uint256 handle, address account) view returns (bool)",
  "function isPermittedToView(address permitter, address permittee, uint256 handle) view returns (bool)",
  "function isContractViewPermitted(address permitter, address permittee, address contractAddress) view returns (bool)",
  "function isFullViewPermitted(address permitter, address permittee) view returns (bool)",
] as const;
