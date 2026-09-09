import { defineChain } from "viem";

export type ScaffoldConfig = {
  targetNetworks: readonly [ReturnType<typeof defineChain>, ...ReturnType<typeof defineChain>[]];
  pollingInterval: number;
  walletConnectProjectId: string;
};

const rpcUrl =
  process.env.NEXT_PUBLIC_RPC_URL ||
  process.env.NEXT_PUBLIC_ARBITRUM_SEPOLIA_RPC_URL ||
  "https://sepolia-rollup.arbitrum.io/rpc";

export const arbitrumSepolia = defineChain({
  id: 421614,
  name: "Arbitrum Sepolia",
  nativeCurrency: { name: "Ether", symbol: "ETH", decimals: 18 },
  rpcUrls: {
    default: { http: [rpcUrl] },
  },
  blockExplorers: {
    default: { name: "Arbiscan", url: "https://sepolia.arbiscan.io" },
  },
  contracts: {
    multicall3: {
      address: "0xca11bde05977b3631167028862be2a173976ca11",
      blockCreated: 81930,
    },
  },
});

const scaffoldConfig = {
  targetNetworks: [arbitrumSepolia],
  pollingInterval: process.env.NEXT_PUBLIC_POLLING_INTERVAL
    ? parseInt(process.env.NEXT_PUBLIC_POLLING_INTERVAL, 10)
    : 30000,
  walletConnectProjectId:
    process.env.NEXT_PUBLIC_WALLET_CONNECT_PROJECT_ID || "3a8170812b534d0ff9d794f19a901d64",
} as const satisfies ScaffoldConfig;

export default scaffoldConfig;
