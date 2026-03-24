/**
 * Shared helpers for PrivateERC20-style contract tests (proxy deploy, MPC delays, event queries).
 */
import type { HDNodeWallet, Wallet } from "ethers";
import { decryptBalanceViaProxy, prepareMessageForBubble128, prepareMessageForBubble256 } from "./testUtils";

/** Hardhat runtime (`import hre from "hardhat"`) — typed loosely for reuse across test suites. */
export type HardhatRuntime = {
  ethers: {
    provider: { getBlockNumber: () => Promise<number>; getCode: (address: string) => Promise<string> };
    getContractFactory: (name: string, signer?: any) => Promise<any>;
    getSigners?: () => Promise<any[]>;
  };
};

export const PRIVATE_ERC20_256_FQN = "contracts/PrivateERC20Contract256.sol:PrivateERC20Contract256";
export const ERC1967_PROXY_FQN = "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy";

export const DELAY_SHORT_MS = 2000;
export const DELAY_STANDARD_MS = 3000;
export const DELAY_BALANCE_SYNC_MS = 5000;
export const DELAY_MPC_PROCESSING_MS = 10000;
export const DELAY_MPC_DECRYPTION_MS = 15000;
/** Long settle waits (transferOPRF / redeemMany against live MPC). */
export const DELAY_MPC_EXTENDED_MS = 20000;
export const DELAY_MPC_REDEEM_MS = 30000;

export async function delay(ms: number): Promise<void> {
  await new Promise(resolve => setTimeout(resolve, ms));
}

export async function waitForContractCode(
  address: string,
  hre: HardhatRuntime,
  timeoutMs = 5000,
  pollIntervalMs = 500
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const code = await hre.ethers.provider.getCode(address);
    if (code && code !== "0x") {
      return code;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Contract at ${address} still has no code after ${timeoutMs}ms`);
}

/**
 * After deployment, wait for the deployment tx (if present), then poll until `getCode` is non-empty
 * (helps with RPC propagation). Same pattern as restriction-list integration tests.
 */
export async function waitForDeploymentConfirmation(
  contract: {
    deploymentTransaction?: () => { wait?: () => Promise<unknown> } | null | undefined;
    getAddress: () => Promise<string>;
  },
  hre: HardhatRuntime,
  options?: { pollIntervalMs?: number; maxAttempts?: number }
): Promise<void> {
  const tx = typeof contract.deploymentTransaction === "function" ? contract.deploymentTransaction() : null;
  if (tx && typeof tx.wait === "function") {
    await tx.wait();
  }
  const address = await contract.getAddress();
  const { pollIntervalMs = 2000, maxAttempts = 10 } = options ?? {};
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    const code = await hre.ethers.provider.getCode(address);
    if (code && code !== "0x") {
      return;
    }
    await delay(pollIntervalMs);
  }
  throw new Error(`Contract code not available at ${address} after waiting`);
}

export async function retryWithDelay<T>(
  operation: () => Promise<T>,
  attempts: number = 3,
  baseDelayMs: number = 1000
): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      if (attempt === attempts - 1) {
        throw lastError;
      }
      const backoff = baseDelayMs * Math.pow(2, attempt);
      console.warn(
        `Operation failed (attempt ${attempt + 1}/${attempts}): ${lastError.message}. Retrying in ${backoff}ms...`
      );
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }
  throw lastError!;
}

export async function deployPrivateToken(
  hre: HardhatRuntime,
  defaultSigner: any,
  params: {
    underlyingAddress: string;
    ownerAddress: string;
    masterAddress: string;
    name?: string;
    symbol?: string;
  }
): Promise<any> {
  const { underlyingAddress, ownerAddress, masterAddress, name = "BubbleToken", symbol = "BUB" } = params;

  const ImplementationFactory = await hre.ethers.getContractFactory(PRIVATE_ERC20_256_FQN, defaultSigner);
  const implementation = await ImplementationFactory.deploy();
  await implementation.waitForDeployment();
  const implementationAddress = await implementation.getAddress();

  const initData = ImplementationFactory.interface.encodeFunctionData("initialize", [
    name,
    symbol,
    underlyingAddress,
    ownerAddress,
    masterAddress,
  ]);

  const ProxyFactory = await hre.ethers.getContractFactory(ERC1967_PROXY_FQN, defaultSigner);
  const proxy = await ProxyFactory.deploy(implementationAddress, initData);
  await proxy.waitForDeployment();

  return ImplementationFactory.attach(await proxy.getAddress()) as any;
}

export async function deployPrivateTokenImplementation(
  hre: HardhatRuntime,
  defaultSigner: any
): Promise<any> {
  const ImplementationFactory = await hre.ethers.getContractFactory(PRIVATE_ERC20_256_FQN, defaultSigner);
  const implementation = await ImplementationFactory.deploy();
  await implementation.waitForDeployment();
  return implementation;
}

export async function mintAndApprove(params: {
  mockToken: { mint: (to: string, amount: bigint) => Promise<{ wait: () => Promise<unknown> }> };
  privateToken: { getAddress: () => Promise<string> };
  userAddress: string;
  amount: bigint;
  delayAfterApproveMs?: number;
}): Promise<void> {
  const { mockToken, privateToken, userAddress, amount, delayAfterApproveMs = DELAY_STANDARD_MS } = params;
  await (await mockToken.mint(userAddress, amount)).wait();
  await (await mockToken.approve(await privateToken.getAddress(), amount)).wait();
  await delay(delayAfterApproveMs);
}

/**
 * Mint underlying to `recipient`, approve the private token, and shield.
 * Prefer this over `mockToken.transfer(recipient, amount)` when `recipient` is the test signer:
 * self-transfers are a no-op and do not add balance, so long test runs can run out of underlying
 * for `shield` while isolated tests still pass.
 */
export async function mintApproveAndShield(params: {
  mockToken: {
    mint: (to: string, amount: bigint) => Promise<{ wait: () => Promise<unknown> }>;
    approve: (spender: string, amount: bigint) => Promise<{ wait: () => Promise<unknown> }>;
  };
  privateToken: {
    getAddress: () => Promise<string>;
    shield: (amount: bigint) => Promise<{ wait: () => Promise<unknown> }>;
  };
  recipient: string;
  amount: bigint;
}): Promise<void> {
  const { mockToken, privateToken, recipient, amount } = params;
  await (await mockToken.mint(recipient, amount)).wait();
  await (await mockToken.approve(await privateToken.getAddress(), amount)).wait();
  await (await privateToken.shield(amount)).wait();
}

export async function getPrivateTokenBalance(params: {
  privateToken: { ["balanceOf(address)"](address: string): Promise<bigint> };
  address: string;
  signer: Wallet | HDNodeWallet;
  aesKey: Buffer;
  proxyUrl: string;
}): Promise<bigint> {
  const { privateToken, address, signer, aesKey, proxyUrl } = params;
  const balanceHandle = await privateToken["balanceOf(address)"](address);
  if (balanceHandle === 0n) {
    return 0n;
  }
  return decryptBalanceViaProxy(balanceHandle, signer, aesKey, proxyUrl);
}

export async function findEventsFromStartBlock(
  privateToken: { queryFilter: (filter: any, from: number, to: number) => Promise<any[]> },
  filter: any,
  hre: HardhatRuntime,
  startBlock: number,
  maxBlockRange: number = 1000
): Promise<{ events: any[]; endBlock: number }> {
  const currentBlock = await hre.ethers.provider.getBlockNumber();
  const endBlock = Math.min(startBlock + maxBlockRange, currentBlock);
  const events = await privateToken.queryFilter(filter, startBlock, endBlock);
  return { events, endBlock };
}

/**
 * Resolve an ethers `contract.filters.<EventName>` by name.
 * If the filter is a function (typical), it is called with no args, or with `indexedArgs` when provided.
 */
export function getEventFilterByName(contract: any, eventName: string, indexedArgs?: unknown[]): any {
  const entry = contract.filters?.[eventName];
  if (entry == null) {
    throw new Error(`Contract has no filters.${eventName}`);
  }
  if (typeof entry === "function") {
    return indexedArgs !== undefined && indexedArgs.length > 0 ? entry(...indexedArgs) : entry();
  }
  return entry;
}

/**
 * Query logs for a named event from `startBlock` up to `min(startBlock + maxBlockRange, chain head)`.
 * @param eventName — e.g. `"Shield"`, `"UnshieldRequested"`
 * @param options.indexedArgs — passed to `filters[eventName](...)` when the event has indexed parameters
 */
export async function findEventsFromStartBlockByName(
  contract: any,
  hre: HardhatRuntime,
  eventName: string,
  startBlock: number,
  options?: { maxBlockRange?: number; indexedArgs?: unknown[] }
): Promise<{ events: any[]; endBlock: number }> {
  const { maxBlockRange = 1000, indexedArgs } = options ?? {};
  const filter = getEventFilterByName(contract, eventName, indexedArgs);
  return findEventsFromStartBlock(contract, filter, hre, startBlock, maxBlockRange);
}

export async function getEventsInReceiptBlock(
  privateToken: { queryFilter: (filter: any, from: number | undefined, to: number | undefined) => Promise<any[]> },
  filter: any,
  receipt: { blockNumber?: number }
): Promise<any[]> {
  return privateToken.queryFilter(filter, receipt?.blockNumber, receipt?.blockNumber);
}

/**
 * First receipt log that parses with `contract.interface` to the given event name.
 */
export function findParsedLogInReceipt(
  receipt: { logs?: readonly any[] } | null | undefined,
  contract: { interface: { parseLog: (log: any) => { name?: string } } },
  eventName: string
): any | undefined {
  return receipt?.logs?.find((log) => {
    try {
      const parsed = contract.interface.parseLog(log);
      return parsed?.name === eventName;
    } catch {
      return false;
    }
  });
}

/** All receipt logs that parse to `eventName` (same parsing rules as `findParsedLogInReceipt`). */
export function findParsedLogsInReceipt(
  receipt: Parameters<typeof findParsedLogInReceipt>[0],
  contract: Parameters<typeof findParsedLogInReceipt>[1],
  eventName: string
): any[] {
  if (!receipt?.logs?.length) return [];
  return receipt.logs.filter((log) => {
    try {
      const parsed = contract.interface.parseLog(log);
      return parsed?.name === eventName;
    } catch {
      return false;
    }
  });
}

/** First receipt log for `eventName` where `predicate` holds on the parsed log (name + args). */
export function findParsedLogInReceiptWhere(
  receipt: Parameters<typeof findParsedLogInReceipt>[0],
  contract: Parameters<typeof findParsedLogInReceipt>[1],
  eventName: string,
  predicate: (parsed: { name?: string; args?: readonly unknown[] }) => boolean
): any | undefined {
  return receipt?.logs?.find((log) => {
    try {
      const parsed = contract.interface.parseLog(log) as { name?: string; args?: readonly unknown[] };
      if (parsed?.name !== eventName) return false;
      return predicate(parsed);
    } catch {
      return false;
    }
  });
}

/** X, Y, Q handles from the first `OPRFMinted` log in a receipt (args[0] is user). */
export function getOprfMintedHandlesFromReceipt(
  receipt: Parameters<typeof findParsedLogInReceipt>[0],
  contract: Parameters<typeof findParsedLogInReceipt>[1]
): { xHandle: bigint; yHandle: bigint; qHandle: bigint } | undefined {
  const mintEvent = findParsedLogInReceipt(receipt, contract, "OPRFMinted");
  if (!mintEvent) return undefined;
  const mintDecoded = contract.interface.parseLog(mintEvent) as unknown as {
    args?: readonly unknown[];
  };
  const args = mintDecoded?.args;
  if (!args || args.length < 4) return undefined;
  return {
    xHandle: args[1] as bigint,
    yHandle: args[2] as bigint,
    qHandle: args[3] as bigint,
  };
}

export async function waitForUnshieldOutcome(
  privateToken: {
    queryFilter: (filter: any, from: number, to: number) => Promise<any[]>;
    filters: { Unshield: any; UnshieldFailed: any };
  },
  hre: HardhatRuntime,
  startBlock: number,
  options: {
    maxBlockRange?: number;
    timeoutMs?: number;
    pollIntervalMs?: number;
  } = {}
): Promise<{ successEvents: any[]; failedEvents: any[] }> {
  const { maxBlockRange = 1000, timeoutMs = 60000, pollIntervalMs = 2000 } = options;
  let successEvents: any[] = [];
  let failedEvents: any[] = [];
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const currentBlock = await hre.ethers.provider.getBlockNumber();
    const endBlock = Math.min(startBlock + maxBlockRange, currentBlock);
    successEvents = await privateToken.queryFilter(privateToken.filters.Unshield, startBlock, endBlock);
    failedEvents = await privateToken.queryFilter(privateToken.filters.UnshieldFailed, startBlock, endBlock);

    if (successEvents.length > 0 || failedEvents.length > 0) {
      break;
    }

    await delay(pollIntervalMs);
  }

  return { successEvents, failedEvents };
}

export async function ensurePrivateBalanceClearedFor(params: {
  privateToken: any;
  signer: Wallet | HDNodeWallet;
  aesKey?: Buffer;
  proxyUrl: string;
  hre: HardhatRuntime;
}): Promise<void> {
  const { privateToken, signer, aesKey, proxyUrl, hre } = params;
  if (!privateToken || !aesKey) {
    return;
  }

  await retryWithDelay(async () => {
    const address = await signer.getAddress();
    const balanceHandle = await privateToken["balanceOf(address)"](address);
    if (balanceHandle === 0n) {
      return;
    }

    const decryptedBalance = await decryptBalanceViaProxy(balanceHandle, signer, aesKey, proxyUrl);
    if (decryptedBalance === 0n) {
      return;
    }

    const startBlock = await hre.ethers.provider.getBlockNumber();
    const tx = await privateToken.connect(signer).unshield(decryptedBalance);
    await tx.wait();

    const { successEvents, failedEvents } = await waitForUnshieldOutcome(privateToken, hre, startBlock);
    if (failedEvents.length > 0 || successEvents.length === 0) {
      throw new Error(`Failed to clear private balance for ${address}`);
    }
  });
}

/** Signed `itUint256`-shaped payload for PrivateERC20 OPRF flows (mint, split, etc.). */
export async function buildSignedItUint256(params: {
  value: bigint;
  userAddress: string;
  userAesKeyHex: string;
  contractAddress: string;
  signer: { signMessage: (msg: string | Uint8Array) => Promise<string> };
}): Promise<{
  userAddress: string;
  ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint };
  signature: string;
}> {
  const { value, userAddress, userAesKeyHex, contractAddress, signer } = params;
  const { encryptedHigh, encryptedLow, messageBytes } = prepareMessageForBubble256(
    value,
    userAddress,
    userAesKeyHex,
    contractAddress
  );
  const signature = await signer.signMessage(messageBytes);
  return {
    userAddress,
    ciphertext: { ciphertextHigh: encryptedHigh, ciphertextLow: encryptedLow },
    signature,
  };
}

/** Unsigned ciphertext-only `itUint256` (some integration paths omit signatures). */
export function buildUnsignedItUint256(params: {
  value: bigint;
  userAddress: string;
  userAesKeyHex: string;
  contractAddress: string;
}): {
  userAddress: string;
  ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint };
} {
  const { value, userAddress, userAesKeyHex, contractAddress } = params;
  const { encryptedHigh, encryptedLow } = prepareMessageForBubble256(value, userAddress, userAesKeyHex, contractAddress);
  return {
    userAddress,
    ciphertext: { ciphertextHigh: encryptedHigh, ciphertextLow: encryptedLow },
  };
}

/** Signed `itUint128`-shaped payload (OPRF x / xr limbs). */
export async function buildSignedItUint128(params: {
  value: bigint;
  userAddress: string;
  userAesKeyHex: string;
  contractAddress: string;
  signer: { signMessage: (msg: string | Uint8Array) => Promise<string> };
}): Promise<{
  userAddress: string;
  ciphertext: bigint;
  signature: string;
}> {
  const { value, userAddress, userAesKeyHex, contractAddress, signer } = params;
  const { encryptedInt, messageBytes } = prepareMessageForBubble128(
    value,
    userAddress,
    userAesKeyHex,
    contractAddress
  );
  const signature = await signer.signMessage(messageBytes);
  return {
    userAddress,
    ciphertext: encryptedInt,
    signature,
  };
}

export function buildUnsignedItUint128(params: {
  value: bigint;
  userAddress: string;
  userAesKeyHex: string;
  contractAddress: string;
}): {
  userAddress: string;
  ciphertext: bigint;
} {
  const { value, userAddress, userAesKeyHex, contractAddress } = params;
  const { encryptedInt } = prepareMessageForBubble128(value, userAddress, userAesKeyHex, contractAddress);
  return {
    userAddress,
    ciphertext: encryptedInt,
  };
}

/** Signed `x`, `q`, and `qSplit` ciphertexts for `splitToken` / `splitTokenForRecipient`. */
export async function buildSignedOprfSplitPayloads(params: {
  decryptedX: bigint;
  decryptedQ: bigint;
  qSplit: bigint;
  userAddress: string;
  userAesKeyHex: string;
  contractAddress: string;
  signer: { signMessage: (msg: string | Uint8Array) => Promise<string> };
}): Promise<{
  xIT: Awaited<ReturnType<typeof buildSignedItUint128>>;
  qIT: Awaited<ReturnType<typeof buildSignedItUint256>>;
  qSplitIT: Awaited<ReturnType<typeof buildSignedItUint256>>;
}> {
  const { decryptedX, decryptedQ, qSplit, userAddress, userAesKeyHex, contractAddress, signer } = params;
  const xIT = await buildSignedItUint128({
    value: decryptedX,
    userAddress,
    userAesKeyHex,
    contractAddress,
    signer,
  });
  const qIT = await buildSignedItUint256({
    value: decryptedQ,
    userAddress,
    userAesKeyHex,
    contractAddress,
    signer,
  });
  const qSplitIT = await buildSignedItUint256({
    value: qSplit,
    userAddress,
    userAesKeyHex,
    contractAddress,
    signer,
  });
  return { xIT, qIT, qSplitIT };
}

/** Signed `x` and `q` for `burnToken`. */
export async function buildSignedOprfBurnPayloads(params: {
  decryptedX: bigint;
  decryptedQ: bigint;
  userAddress: string;
  userAesKeyHex: string;
  contractAddress: string;
  signer: { signMessage: (msg: string | Uint8Array) => Promise<string> };
}): Promise<{
  xIT: Awaited<ReturnType<typeof buildSignedItUint128>>;
  qIT: Awaited<ReturnType<typeof buildSignedItUint256>>;
}> {
  const { decryptedX, decryptedQ, userAddress, userAesKeyHex, contractAddress, signer } = params;
  const xIT = await buildSignedItUint128({
    value: decryptedX,
    userAddress,
    userAesKeyHex,
    contractAddress,
    signer,
  });
  const qIT = await buildSignedItUint256({
    value: decryptedQ,
    userAddress,
    userAesKeyHex,
    contractAddress,
    signer,
  });
  return { xIT, qIT };
}
