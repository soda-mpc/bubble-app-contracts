export interface SafeContractRef {
  address: string;
  blockNumber?: number;
}

export interface SafeInfrastructureDeployment {
  network: string;
  chainId: number;
  deployedAt: string;
  version: "1.4.1";
  source: "local" | "canonical";
  safeL2: SafeContractRef;
  safeProxyFactory: SafeContractRef;
}

export interface SafeWalletDeployment {
  network: string;
  chainId: number;
  deployedAt: string;
  safeAddress: string;
  owners: string[];
  threshold: number;
  saltNonce: string;
  singleton: string;
  factory: string;
}
