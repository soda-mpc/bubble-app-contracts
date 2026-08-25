/**
 * Shared test harness: Hardhat deploy, delays, receipt/event helpers, chai-style helpers.
 * Transport + crypto (proxy HTTP, encrypt/decrypt message prep): sibling `bubbleCryptoTransport.ts` in this folder.
 */
import hre from "hardhat";
import fs from "fs";
import type { HDNodeWallet, Wallet } from "ethers";
import {
  decryptBalanceViaProxy,
  prepareMessageForBubble128,
  prepareMessageForBubble256,
  retryWithBackoff,
} from "./bubbleCryptoTransport";

export async function expectReverted(txPromise: Promise<any>): Promise<void> {
  try {
    const tx = await txPromise;
    await tx.wait();
  } catch {
    return;
  }
  throw new Error("Expected transaction to revert, but it succeeded");
}

export async function waitForCondition(
  condition: () => Promise<boolean>,
  timeoutMs = 30000,
  stepMs = 1500
): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) {
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, stepMs));
  }
  throw new Error("Timed out waiting for on-chain condition");
}

/** Hardhat runtime (`import hre from "hardhat"`) — typed loosely for reuse across test suites. */
export type HardhatRuntime = {
  ethers: {
    provider: {
      getBlockNumber: () => Promise<number>;
      getCode: (address: string) => Promise<string>;
      getBalance: (address: string) => Promise<bigint>;
    };
    getContractFactory: (name: string, signer?: any) => Promise<any>;
    getSigners?: () => Promise<any[]>;
    Wallet: {
      createRandom: () => HDNodeWallet;
      fromPhrase?: (phrase: string) => HDNodeWallet;
    };
    parseEther: (value: string) => bigint;
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
  await waitForContractCode(address, hre, maxAttempts * pollIntervalMs, pollIntervalMs);
}

async function deployProxyBackedContract(params: {
  hre: HardhatRuntime;
  signer: any;
  contractFqn: string;
  initData?: (factory: any) => string;
  postDeploy?: (contract: any, factory: any) => Promise<void>;
}): Promise<any> {
  const { hre, signer, contractFqn, initData, postDeploy } = params;
  const ContractFactory = await hre.ethers.getContractFactory(contractFqn, signer);
  const implementation = await ContractFactory.deploy();
  await implementation.waitForDeployment();
  await waitForDeploymentConfirmation(implementation, hre);

  const ProxyFactory = await hre.ethers.getContractFactory(ERC1967_PROXY_FQN, signer);
  const proxy = await ProxyFactory.deploy(
    await implementation.getAddress(),
    initData ? initData(ContractFactory) : "0x"
  );
  await proxy.waitForDeployment();
  await waitForDeploymentConfirmation(proxy, hre);

  const contract = ContractFactory.attach(await proxy.getAddress()) as any;
  if (postDeploy) {
    await postDeploy(contract, ContractFactory);
  }
  return contract;
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
  return deployProxyBackedContract({
    hre,
    signer: defaultSigner,
    contractFqn: PRIVATE_ERC20_256_FQN,
    initData: (factory) => factory.interface.encodeFunctionData("initialize", [
      name,
      symbol,
      underlyingAddress,
      ownerAddress,
      masterAddress,
    ]),
  });
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

export async function deployMockToken(
  hre: HardhatRuntime,
  signer: any,
  name = "Test USDC",
  symbol = "TUSDC"
): Promise<any> {
  const MockTokenFactory = await hre.ethers.getContractFactory("TUSDC", signer);
  const mockToken = await MockTokenFactory.deploy(name, symbol);
  await mockToken.waitForDeployment();
  return mockToken;
}

async function fundRecipients(params: {
  sender: { sendTransaction: (tx: { to: string; value: bigint }) => Promise<{ wait: () => Promise<unknown> }> };
  recipients: string[];
  amountWei: bigint;
}): Promise<void> {
  const { sender, recipients, amountWei } = params;
  for (const recipient of recipients) {
    await (await sender.sendTransaction({ to: recipient, value: amountWei })).wait();
  }
}

export async function fundWalletsForGas(params: {
  sender: { sendTransaction: (tx: { to: string; value: bigint }) => Promise<{ wait: () => Promise<unknown> }> };
  recipients: string[];
  amountWei: bigint;
}): Promise<void> {
  await fundRecipients(params);
}

export async function createRandomWalletsAndFund(params: {
  hre: HardhatRuntime;
  sender: { sendTransaction: (tx: { to: string; value: bigint }) => Promise<{ wait: () => Promise<unknown> }> };
  count: number;
  amountWei: bigint;
}): Promise<HDNodeWallet[]> {
  const { hre, sender, count, amountWei } = params;
  const wallets = Array.from({ length: count }, () => hre.ethers.Wallet.createRandom().connect(hre.ethers.provider as any));
  await fundWalletsForGas({
    sender,
    recipients: wallets.map((wallet) => wallet.address),
    amountWei,
  });
  return wallets;
}

export async function ensureWalletHasGas(params: {
  hre: HardhatRuntime;
  sender: { sendTransaction: (tx: { to: string; value: bigint }) => Promise<{ wait: () => Promise<unknown> }> };
  recipient: string;
  minimumWei: bigint;
  topUpWei: bigint;
}): Promise<void> {
  const { hre, sender, recipient, minimumWei, topUpWei } = params;
  const balance = await hre.ethers.provider.getBalance(recipient);
  if (balance < minimumWei) {
    await fundWalletsForGas({
      sender,
      recipients: [recipient],
      amountWei: topUpWei,
    });
  }
}

export async function deployRestrictionListRegistry(
  hre: HardhatRuntime,
  owner: any,
  name: string
): Promise<any> {
  const RestrictionListRegistryFactory = await hre.ethers.getContractFactory("RestrictionListRegistry", owner);
  const registry = await RestrictionListRegistryFactory.deploy(owner.address, name);
  await registry.waitForDeployment();
  await waitForDeploymentConfirmation(registry, hre);
  return registry;
}

export async function deployPrivateTokenWithRestrictionList(params: {
  hre: HardhatRuntime;
  signer: any;
  underlyingAddress: string;
  ownerAddress: string;
  masterAddress: string;
  name?: string;
  symbol?: string;
}): Promise<any> {
  const {
    hre,
    signer,
    underlyingAddress,
    ownerAddress,
    masterAddress,
    name = "Restricted Private Token",
    symbol = "RPT",
  } = params;

  return deployProxyBackedContract({
    hre,
    signer,
    contractFqn: "PrivateERC20WithRestrictionList256",
    postDeploy: async (privateToken) => {
      await (await privateToken["initialize(string,string,address,address,address)"](
        name,
        symbol,
        underlyingAddress,
        ownerAddress,
        masterAddress
      )).wait();
    },
  });
}

export async function mintAndApprove(params: {
  mockToken: {
    mint: (to: string, amount: bigint) => Promise<{ wait: () => Promise<unknown> }>;
    approve: (spender: string, amount: bigint) => Promise<{ wait: () => Promise<unknown> }>;
  };
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
  await mintAndApprove({
    mockToken,
    privateToken,
    userAddress: recipient,
    amount,
    delayAfterApproveMs: 0,
  });
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

async function findEventsFromStartBlock(
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
function getEventFilterByName(contract: any, eventName: string, indexedArgs?: unknown[]): any {
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

function parseReceiptLogs(
  receipt: { logs?: readonly any[] } | null | undefined,
  contract: { interface: { parseLog: (log: any) => { name?: string; args?: readonly unknown[] } } }
): Array<{ log: any; parsed: { name?: string; args?: readonly unknown[] }; name?: string }> {
  if (!receipt?.logs?.length) return [];
  return receipt.logs.flatMap((log) => {
    try {
      const parsed = contract.interface.parseLog(log) as { name?: string; args?: readonly unknown[] };
      return [{ log, parsed, name: parsed?.name }];
    } catch {
      return [];
    }
  });
}

/**
 * First receipt log that parses with `contract.interface` to the given event name.
 */
export function findParsedLogInReceipt(
  receipt: { logs?: readonly any[] } | null | undefined,
  contract: { interface: { parseLog: (log: any) => { name?: string } } },
  eventName: string
): any | undefined {
  return parseReceiptLogs(receipt, contract).find((entry) => entry.name === eventName)?.log;
}

/** All receipt logs that parse to `eventName` (same parsing rules as `findParsedLogInReceipt`). */
export function findParsedLogsInReceipt(
  receipt: Parameters<typeof findParsedLogInReceipt>[0],
  contract: Parameters<typeof findParsedLogInReceipt>[1],
  eventName: string
): any[] {
  return parseReceiptLogs(receipt, contract)
    .filter((entry) => entry.name === eventName)
    .map((entry) => entry.log);
}

/** First receipt log for `eventName` where `predicate` holds on the parsed log (name + args). */
export function findParsedLogInReceiptWhere(
  receipt: Parameters<typeof findParsedLogInReceipt>[0],
  contract: Parameters<typeof findParsedLogInReceipt>[1],
  eventName: string,
  predicate: (parsed: { name?: string; args?: readonly unknown[] }) => boolean
): any | undefined {
  return parseReceiptLogs(receipt, contract)
    .find((entry) => entry.name === eventName && predicate(entry.parsed))
    ?.log;
}

/** All `OPRFMinted` logs in a receipt decoded to `{ user, x, y, q }` (same arg order as the contract event). */
export function getOprfMintedEventsFromReceipt(
  receipt: Parameters<typeof findParsedLogInReceipt>[0],
  contract: Parameters<typeof findParsedLogInReceipt>[1]
): Array<{ user: string; x: bigint; y: bigint; q: bigint }> {
  return findParsedLogsInReceipt(receipt, contract, "OPRFMinted").map((log) => {
    const decoded = contract.interface.parseLog(log)! as { args: readonly unknown[] };
    const a = decoded.args;
    return {
      user: a[0] as string,
      x: a[1] as bigint,
      y: a[2] as bigint,
      q: a[3] as bigint,
    };
  });
}

/** X, Y, Q handles from the first `OPRFMinted` log in a receipt (args[0] is user). */
export function getOprfMintedHandlesFromReceipt(
  receipt: Parameters<typeof findParsedLogInReceipt>[0],
  contract: Parameters<typeof findParsedLogInReceipt>[1]
): { xHandle: bigint; yHandle: bigint; qHandle: bigint } | undefined {
  const first = getOprfMintedEventsFromReceipt(receipt, contract)[0];
  if (!first) return undefined;
  return { xHandle: first.x, yHandle: first.y, qHandle: first.q };
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

  await retryWithBackoff(async () => {
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
  }, 2, 1000);
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

/**
 * Chain IDs with deployed Bubble host contracts, read from the installed
 * BubbleAddresses.sol so this list cannot drift from the Solidity library.
 */
export function supportedBubbleChainIds(): number[] {
  const src = fs.readFileSync(
    require.resolve("@sodalabs/bubble-core-contracts/contracts/bubble/BubbleAddresses.sol"),
    "utf8"
  );
  const constants = new Map<string, number>();
  for (const m of src.matchAll(/constant\s+(CHAIN_\w+)\s*=\s*(\d+)/g)) {
    constants.set(m[1], Number(m[2]));
  }
  const marker = src.indexOf("function gcHandler");
  if (marker === -1) {
    throw new Error(
      "BubbleAddresses.sol: could not find gcHandler() — the address lookup has changed shape. " +
      "Fix this parser rather than letting every integration suite skip silently."
    );
  }
  const body = src.slice(marker);
  const ids = new Set<number>();
  for (const m of body.matchAll(/chainId == (CHAIN_\w+)\)/g)) {
    const id = constants.get(m[1]);
    if (id !== undefined) ids.add(id);
  }
  if (ids.size === 0) {
    throw new Error("BubbleAddresses.sol: parsed no chain ids — refusing to skip every suite silently");
  }
  // The library knows chains this repo does not offer a network for. Answer the question the repo
  // actually has — "which chains can I connect to from here?" — so deleting a network from
  // hardhat.config.ts is the single action that removes a chain.
  const configured = new Set(
    Object.values(hre.config.networks)
      .map((n: any) => n?.chainId)
      .filter((id: unknown): id is number => typeof id === "number")
  );
  const offered = [...ids].filter((id) => configured.has(id));
  return offered.length > 0 ? offered : [...ids];
}

/**
 * Skip the calling suite unless it can actually run. These are integration tests: they need
 * Bubble host contracts on the connected chain and a funded MNEMONIC. The default Hardhat
 * network has no Bubble deployment, so they are skipped rather than failed.
 */
export async function skipUnlessBubbleNetwork(ctx: Mocha.Context): Promise<void> {
  if (!process.env.MNEMONIC) {
    console.log("      skipped: set MNEMONIC to run integration tests");
    ctx.skip();
  }
  const { chainId } = await hre.ethers.provider.getNetwork();
  if (!supportedBubbleChainIds().includes(Number(chainId))) {
    console.log(`      skipped: chain ${chainId} has no Bubble deployment ` +
                `(use --network sepolia-arbitrum or another supported chain)`);
    ctx.skip();
  }
}
