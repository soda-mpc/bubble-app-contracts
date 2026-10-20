export interface DeploymentResult {
  network: string;
  chainId: number;
  deployedAt: string;
  testToken: {
    address: string;
    name: string;
    symbol: string;
    decimals: number;
    blockNumber: number;
  };
  privateERC20WithRestrictionList: {
    implementation: string;
    implementationBlockNumber: number;
    factory: string;
    factoryBlockNumber: number;
  };
  restrictionListRegistryFactory: {
    address: string;
    blockNumber: number;
  };
  privateToken: {
    address: string;
    name: string;
    symbol: string;
    underlying: string;
    blockNumber: number;
  };
}

/** Gasless stack written by deploy-private-erc20-gasless-factory.ts. */
export interface GaslessFactoryDeployment {
  library: string;
  implementation: string;
  factory: string;
  blockNumber: number;
  deployedAt: string;
}

/** Test USDC for the gasless flows, written by `deploy-tusdc.ts` with `RECORD_AS=gaslessTestToken`. */
export interface GaslessTestTokenDeployment {
  address: string;
  name: string;
  symbol: string;
  decimals: number;
  blockNumber: number;
  eip2612: boolean;
  eip3009: boolean;
  mintWithAuthorization: boolean;
}

/**
 * Everything recorded in `scripts/deployments/<network>.json`. Several scripts write sections of the same file and
 * keep the others, so any section may be missing.
 */
export type DeploymentRecord = Partial<DeploymentResult> & {
  network: string;
  chainId: number;
  gaslessFactory?: GaslessFactoryDeployment;
  gaslessTestToken?: GaslessTestTokenDeployment;
};
