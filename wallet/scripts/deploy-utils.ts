import { artifacts, ethers } from "hardhat";
import type { Contract, ContractFactory, Signer, TransactionReceipt, TransactionRequest } from "ethers";

export interface DeployedContractInfo {
  contract: Contract;
  address: string;
  blockNumber: number;
  transactionHash: string;
}

export interface ContractSizeInfo {
  initCodeBytes: number;
  runtimeCodeBytes: number;
  codeDepositGas: number;
  initCodeGas: number;
}

function toRpcQuantity(value: bigint | number): string {
  return ethers.toQuantity(value);
}

/**
 * Build an RPC transaction payload for eth_sendTransaction.
 * Contract-creation txs must omit `to` entirely — some providers return `to: ""`
 * from eth_getTransactionByHash, which breaks ethers v6 when polling pending deploys.
 */
function buildRpcTransaction(tx: TransactionRequest): Record<string, string> {
  const rpc: Record<string, string> = {
    from: tx.from as string,
  };

  if (tx.data) {
    rpc.data = tx.data as string;
  }

  if (tx.to) {
    rpc.to = tx.to as string;
  }

  if (tx.gasLimit !== undefined && tx.gasLimit !== null) {
    rpc.gas = toRpcQuantity(tx.gasLimit as bigint);
  }

  if (tx.nonce !== undefined && tx.nonce !== null) {
    rpc.nonce = toRpcQuantity(tx.nonce as number);
  }

  if (tx.chainId !== undefined && tx.chainId !== null) {
    rpc.chainId = toRpcQuantity(tx.chainId as bigint);
  }

  if (tx.type !== undefined && tx.type !== null) {
    rpc.type = toRpcQuantity(tx.type as number);
  }

  if (tx.maxFeePerGas !== undefined && tx.maxFeePerGas !== null) {
    rpc.maxFeePerGas = toRpcQuantity(tx.maxFeePerGas as bigint);
  }

  if (tx.maxPriorityFeePerGas !== undefined && tx.maxPriorityFeePerGas !== null) {
    rpc.maxPriorityFeePerGas = toRpcQuantity(tx.maxPriorityFeePerGas as bigint);
  }

  if (tx.gasPrice !== undefined && tx.gasPrice !== null) {
    rpc.gasPrice = toRpcQuantity(tx.gasPrice as bigint);
  }

  return rpc;
}

export async function waitForTransactionReceipt(
  hash: string,
  confirmations = 1,
  timeoutMs = 600_000,
  pollIntervalMs = 2_000
): Promise<TransactionReceipt> {
  const start = Date.now();

  while (Date.now() - start < timeoutMs) {
    const receipt = await ethers.provider.getTransactionReceipt(hash);
    if (receipt?.blockNumber !== undefined && receipt.blockNumber !== null) {
      if (confirmations <= 1) {
        return receipt;
      }

      const latestBlock = await ethers.provider.getBlockNumber();
      if (latestBlock - receipt.blockNumber + 1 >= confirmations) {
        return receipt;
      }
    }

    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Timed out waiting for transaction receipt: ${hash}`);
}

export async function sendTransactionViaReceipt(
  signer: Signer,
  tx: TransactionRequest,
  confirmations = 1
): Promise<TransactionReceipt> {
  const populated = await signer.populateTransaction(tx);
  const hash: string = await ethers.provider.send("eth_sendTransaction", [
    buildRpcTransaction(populated),
  ]);

  const receipt = await waitForTransactionReceipt(hash, confirmations);
  if (receipt.status === 0) {
    throw new Error(`Transaction ${hash} reverted`);
  }

  return receipt;
}

export async function getContractSizeInfo(contractName: string): Promise<ContractSizeInfo> {
  const artifact = await artifacts.readArtifact(contractName);
  const initCodeBytes = Math.max(0, (artifact.bytecode.length - 2) / 2);
  const runtimeCodeBytes = Math.max(0, (artifact.deployedBytecode.length - 2) / 2);
  const codeDepositGas = runtimeCodeBytes * 200;
  const initCodeGas = Math.ceil(initCodeBytes / 32) * 2;

  return {
    initCodeBytes,
    runtimeCodeBytes,
    codeDepositGas,
    initCodeGas,
  };
}

export async function deployContract(
  contractName: string,
  deployArgs: unknown[] = [],
  confirmations = 1
): Promise<DeployedContractInfo> {
  const [deployer] = await ethers.getSigners();
  const factory: ContractFactory = await ethers.getContractFactory(contractName, deployer);
  const deployTx = await factory.getDeployTransaction(...deployArgs);
  const receipt = await sendTransactionViaReceipt(deployer, deployTx, confirmations);

  const address = receipt.contractAddress;
  if (!address) {
    throw new Error(`Deployment transaction ${receipt.hash} did not create a contract`);
  }

  return {
    contract: factory.attach(address) as Contract,
    address,
    blockNumber: receipt.blockNumber ?? 0,
    transactionHash: receipt.hash,
  };
}

export async function deployContractWithSizeInfo(
  contractName: string,
  deployArgs: unknown[] = [],
  confirmations = 1
): Promise<DeployedContractInfo> {
  const sizeInfo = await getContractSizeInfo(contractName);
  console.log(
    `   Size: init ${sizeInfo.initCodeBytes} bytes, runtime ${sizeInfo.runtimeCodeBytes} bytes`
  );
  console.log(
    `   Est. gas: code deposit ${sizeInfo.codeDepositGas}, initcode ${sizeInfo.initCodeGas}`
  );

  const deployed = await deployContract(contractName, deployArgs, confirmations);
  console.log(`   🔗 Deployment tx: ${deployed.transactionHash}`);
  return deployed;
}
