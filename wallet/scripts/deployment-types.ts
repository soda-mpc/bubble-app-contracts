export interface DeploymentResult {
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
