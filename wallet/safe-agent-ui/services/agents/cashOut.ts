import { Contract, JsonRpcProvider, Wallet, getAddress, Interface, formatUnits } from "ethers";
import { GCACL_ABI, getAppContractsConfig } from "~~/config/contracts";
import { buildItUint128, buildItUint256 } from "../bubble/crypto";
import { ensureUserKey, decryptHandlesViaProxy } from "../bubble/proxy";
import { resolveTxFeeOverrides } from "../web3/txFeeOverrides";
import type { AgentRecord } from "../agents/agentStore";
import type { NotePackage } from "../notes/noteStore";
import { upsertNote } from "../notes/noteStore";
import { recordActivity } from "../activity/activityStore";
import scaffoldConfig from "~~/scaffold.config";

const INSERT_TTL_SECONDS = 365n * 24n * 60n * 60n;
const UINT128_MAX = 2n ** 128n;
const LOG = "[cashOut]";

/** Compact ABI — returns are three gt* handles as uint256 (not nested ctUint256). */
const REDEEM_ABI = [
  "function redeemManyToUnderlying(tuple((address,uint256),(address,tuple(uint256,uint256)),uint128)[],tuple(address,tuple(uint256,uint256)),address,bool) returns (uint256,uint256,uint256)",
  "event OPRFMinted(address indexed user, uint256 x, uint256 y, uint256 q)",
];

function getRpcUrl() {
  return scaffoldConfig.targetNetworks[0].rpcUrls.default.http[0];
}

function agentWallet(agent: AgentRecord, provider: JsonRpcProvider) {
  return new Wallet(agent.privateKey, provider);
}

function log(...args: unknown[]) {
  console.log(LOG, ...args);
}

function logError(...args: unknown[]) {
  console.error(LOG, ...args);
}

function dumpError(err: any) {
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  const dump = {
    name: err?.name,
    code: err?.code,
    shortMessage: err?.shortMessage,
    reason: err?.reason,
    message: err?.message,
    action: err?.action,
    invocation: err?.invocation
      ? {
          method: err.invocation.method,
          args: err.invocation.args?.map((a: unknown) =>
            typeof a === "bigint" ? a.toString() : a
          ),
        }
      : undefined,
    infoError: err?.info?.error,
    nestedError: err?.error
      ? { code: err.error.code, message: err.error.message, data: err.error.data }
      : undefined,
    data: typeof data === "string" ? data : data,
    transaction: err?.transaction
      ? {
          to: err.transaction.to,
          from: err.transaction.from,
          data: err.transaction.data?.slice?.(0, 74) + "…",
          dataLength: err.transaction.data?.length,
        }
      : undefined,
  };
  logError("error dump:", JSON.stringify(dump, (_k, v) => (typeof v === "bigint" ? v.toString() : v), 2));
  return dump;
}

function formatRevert(err: any): string {
  dumpError(err);
  const candidates = [
    err?.shortMessage,
    err?.reason,
    err?.info?.error?.message,
    err?.error?.message,
    err?.data?.message,
    err?.message,
  ].filter(Boolean);
  const raw = candidates[0] || "execution reverted";
  const data = err?.data ?? err?.info?.error?.data ?? err?.error?.data;
  if (data && data !== "0x" && typeof data === "string") {
    return `${raw} (data=${data.slice(0, 66)}${data.length > 66 ? "…" : ""})`;
  }
  return raw;
}

async function ensureInsertAccess(agentSigner: Wallet, privateToken: string, gcAcl: string) {
  const acl = new Contract(gcAcl, GCACL_ABI, agentSigner);
  const permittedBefore = await acl.isFullInsertPermitted(agentSigner.address, privateToken);
  log("insert ACL before:", {
    permitter: agentSigner.address,
    permittee: privateToken,
    gcAcl,
    permitted: permittedBefore,
  });
  if (permittedBefore) {
    log("insert ACL already granted — skip permit tx");
    return;
  }
  const expiration = BigInt(Math.floor(Date.now() / 1000)) + INSERT_TTL_SECONDS;
  const fees = await resolveTxFeeOverrides(agentSigner.provider!);
  log("sending permitFullInsertAccess…", { expiration: expiration.toString(), fees });
  const tx = await acl.permitFullInsertAccess(privateToken, expiration, fees);
  log("permit tx hash:", tx.hash);
  const receipt = await tx.wait();
  log("permit receipt status:", receipt?.status);
  recordActivity({
    kind: "insert_acl",
    summary: `Agent granted insert ACL to private token`,
    txHash: tx.hash,
    address: agentSigner.address,
  });
  const permittedAfter = await acl.isFullInsertPermitted(agentSigner.address, privateToken);
  log("insert ACL after:", permittedAfter);
  if (!permittedAfter) {
    throw new Error("Insert ACL still false after permitFullInsertAccess");
  }
}

async function waitForClearIncrease(params: {
  provider: JsonRpcProvider;
  underlying: string;
  agentAddress: string;
  before: bigint;
  timeoutMs?: number;
}) {
  const { provider, underlying, agentAddress, before, timeoutMs = 180_000 } = params;
  const erc20 = new Contract(underlying, ["function balanceOf(address) view returns (uint256)"], provider);
  const start = Date.now();
  let attempt = 0;
  while (Date.now() - start < timeoutMs) {
    const bal = BigInt(await erc20.balanceOf(agentAddress));
    attempt += 1;
    log(`unshield poll #${attempt}: clear=${bal.toString()} before=${before.toString()}`);
    if (bal > before) return bal;
    await new Promise((r) => setTimeout(r, 3000));
  }
  throw new Error("Timed out waiting for clear tokens on the agent (MPC unshield)");
}

export type CashOutResult = {
  redeemTxHash: string;
  clearBalanceAfter: bigint;
  remainderNoteUpdated: boolean;
};

/**
 * Agent-paid cash-out: permit insert ACL, redeemManyToUnderlying to agent, wait for clear balance.
 */
export async function cashOutNoteToClear(params: {
  agent: AgentRecord;
  note: NotePackage;
  amount: bigint;
  onStatus?: (msg: string) => void;
}): Promise<CashOutResult> {
  const { agent, note, amount, onStatus } = params;
  const config = getAppContractsConfig();

  log("=== cashOut start ===");
  log("config:", {
    chainId: config.chainId,
    privateErc20: config.privateErc20,
    underlying: config.underlying,
    gcAcl: config.gcAcl,
    rpc: getRpcUrl(),
  });
  log("agent:", { id: agent.id, name: agent.name, address: agent.address });
  log("note:", {
    id: note.id,
    label: note.label,
    status: note.status,
    privateToken: note.privateToken,
    chainId: note.chainId,
    decimals: note.decimals,
    mintTxHash: note.mintTxHash,
    x: note.x,
    y: note.y,
    q: note.q,
  });
  log("requested amount (raw):", amount.toString());

  if (!config.privateErc20 || !config.underlying || !config.gcAcl) {
    throw new Error("Configure private token, underlying, and GCACL");
  }
  if (!note.x || !note.y || !note.q || note.x === "0x" || note.q === "0x") {
    throw new Error("Note is missing decrypted (x, y, q) — remint the note");
  }

  const x = BigInt(note.x);
  const y = BigInt(note.y);
  const q = BigInt(note.q);
  log("parsed note plaintext:", {
    x: x.toString(),
    y: y.toString(),
    q: q.toString(),
    xFitsUint128: x >= 0n && x < UINT128_MAX,
    yFitsUint128: y >= 0n && y < UINT128_MAX,
    amountLteQ: amount <= q,
  });

  if (x < 0n || x >= UINT128_MAX) {
    throw new Error(`Invalid note x (must fit uint128). Got ${x.toString()}. Remint the note.`);
  }
  if (y < 0n || y >= UINT128_MAX) {
    throw new Error(`Invalid note y (must fit uint128). Got ${y.toString()}. Remint the note.`);
  }
  if (amount <= 0n || amount > q) {
    throw new Error("Amount must be > 0 and ≤ note quantity");
  }

  if (note.privateToken && getAddress(note.privateToken) !== getAddress(config.privateErc20)) {
    logError("NOTE privateToken mismatch with env!", {
      note: note.privateToken,
      env: config.privateErc20,
    });
  }

  const privateTokenAddress = getAddress(config.privateErc20);
  const agentAddress = getAddress(agent.address);

  const provider = new JsonRpcProvider(getRpcUrl(), config.chainId);
  const network = await provider.getNetwork();
  log("provider network:", { chainId: network.chainId.toString(), name: network.name });

  const signer = agentWallet(agent, provider);
  const ethBal = await provider.getBalance(agentAddress);
  log("agent ETH balance:", ethBal.toString());
  if (ethBal === 0n) {
    throw new Error("Agent has 0 ETH — cannot pay gas");
  }

  const fees = await resolveTxFeeOverrides(provider);
  log("fee overrides:", {
    maxFeePerGas: fees.maxFeePerGas?.toString(),
    maxPriorityFeePerGas: fees.maxPriorityFeePerGas?.toString(),
    gasPrice: fees.gasPrice?.toString(),
  });

  onStatus?.("Onboarding agent Bubble key…");
  const aesKeyHex = await ensureUserKey(signer, config.chainId);
  log("agent AES key:", {
    length: aesKeyHex.length,
    prefix: aesKeyHex.slice(0, 4) + "…",
    fromCacheOrFresh: "see prior [ensureUserKey] if any",
  });
  if (aesKeyHex.length !== 32) {
    throw new Error(`Bad agent AES key length ${aesKeyHex.length} (expected 32 hex chars)`);
  }

  onStatus?.("Granting insert ACL (once)…");
  await ensureInsertAccess(signer, privateTokenAddress, config.gcAcl);

  log("building ITs…", {
    userAddress: agentAddress,
    contractAddress: privateTokenAddress,
  });
  const xIt = buildItUint128({
    value: x,
    userAddress: agentAddress,
    userAesKeyHex: aesKeyHex,
    contractAddress: privateTokenAddress,
  });
  const qIt = buildItUint256({
    value: q,
    userAddress: agentAddress,
    userAesKeyHex: aesKeyHex,
    contractAddress: privateTokenAddress,
  });
  const amountItBuilt = buildItUint256({
    value: amount,
    userAddress: agentAddress,
    userAesKeyHex: aesKeyHex,
    contractAddress: privateTokenAddress,
  });

  log("IT ciphertexts:", {
    xUser: xIt.userAddress,
    xCipher: xIt.ciphertext.toString(),
    qUser: qIt.userAddress,
    qHigh: qIt.ciphertext.ciphertextHigh.toString(),
    qLow: qIt.ciphertext.ciphertextLow.toString(),
    amountUser: amountItBuilt.userAddress,
    amountHigh: amountItBuilt.ciphertext.ciphertextHigh.toString(),
    amountLow: amountItBuilt.ciphertext.ciphertextLow.toString(),
    y_clear: y.toString(),
  });

  const tokenInput = [
    [
      [xIt.userAddress, xIt.ciphertext],
      [qIt.userAddress, [qIt.ciphertext.ciphertextHigh, qIt.ciphertext.ciphertextLow]],
      y,
    ],
  ];
  const amountIt = [
    amountItBuilt.userAddress,
    [amountItBuilt.ciphertext.ciphertextHigh, amountItBuilt.ciphertext.ciphertextLow],
  ];

  const iface = new Interface(REDEEM_ABI);
  const calldata = iface.encodeFunctionData("redeemManyToUnderlying", [
    tokenInput,
    amountIt,
    agentAddress,
    false,
  ]);
  log("encoded redeemManyToUnderlying:", {
    selector: calldata.slice(0, 10),
    calldataLength: calldata.length,
    calldataHead: calldata.slice(0, 138) + "…",
    recipient: agentAddress,
    unwrap: false,
  });

  const privateToken = new Contract(privateTokenAddress, REDEEM_ABI, signer);
  const underlying = new Contract(
    config.underlying,
    ["function balanceOf(address) view returns (uint256)"],
    provider
  );
  const clearBefore = BigInt(await underlying.balanceOf(agentAddress));
  log("agent clear balance before:", clearBefore.toString());

  // Raw eth_call for extra diagnostics
  onStatus?.("Simulating redeemManyToUnderlying…");
  log("eth_call from agent…");
  try {
    const raw = await provider.call({
      to: privateTokenAddress,
      from: agentAddress,
      data: calldata,
    });
    log("eth_call SUCCESS, return data length:", raw?.length, "head:", raw?.slice(0, 66));
  } catch (err: any) {
    logError("eth_call FAILED");
    dumpError(err);
    try {
      const gas = await provider.estimateGas({
        to: privateTokenAddress,
        from: agentAddress,
        data: calldata,
      });
      log("estimateGas unexpectedly succeeded:", gas.toString());
    } catch (estErr: any) {
      logError("estimateGas also failed");
      dumpError(estErr);
    }
    throw new Error(`Redeem would revert: ${formatRevert(err)}`);
  }

  try {
    log("ethers staticCall…");
    const result = await privateToken.redeemManyToUnderlying.staticCall(
      tokenInput,
      amountIt,
      agentAddress,
      false
    );
    log("staticCall OK", {
      xRemainder: result?.[0]?.toString?.() ?? String(result?.[0]),
      yRemainder: result?.[1]?.toString?.() ?? String(result?.[1]),
      qRemainder: result?.[2]?.toString?.() ?? String(result?.[2]),
    });
  } catch (err: any) {
    // eth_call already succeeded — decode mismatch must not block submit
    logError("staticCall decode/warn (non-fatal if eth_call OK):", err?.shortMessage || err?.message);
    dumpError(err);
  }

  onStatus?.("Submitting redeemManyToUnderlying…");
  let tx;
  try {
    const gasEstimate = await privateToken.redeemManyToUnderlying.estimateGas(
      tokenInput,
      amountIt,
      agentAddress,
      false
    );
    log("estimateGas:", gasEstimate.toString());
    tx = await privateToken.redeemManyToUnderlying(tokenInput, amountIt, agentAddress, false, {
      ...fees,
      gasLimit: (gasEstimate * 120n) / 100n,
    });
    log("redeem tx hash:", tx.hash);
  } catch (err: any) {
    throw new Error(`Redeem submit failed: ${formatRevert(err)}`);
  }
  const receipt = await tx.wait();
  log("redeem receipt:", { status: receipt?.status, logs: receipt?.logs?.length });
  if (!receipt || receipt.status !== 1) {
    throw new Error("Redeem transaction failed");
  }

  recordActivity({
    kind: "cash_out",
    summary: `Agent “${agent.name}” cashed out note “${note.label}”`,
    txHash: tx.hash as string,
    address: agentAddress,
    agentId: agent.id,
    agentName: agent.name,
    noteLabel: note.label,
    amount: formatUnits(amount, note.decimals || 18),
  });

  let remainderNoteUpdated = false;
  try {
    const minted = (receipt.logs || [])
      .map((logEntry: { topics: readonly string[]; data: string }) => {
        try {
          return iface.parseLog(logEntry);
        } catch {
          return null;
        }
      })
      .filter((p: { name?: string } | null) => p?.name === "OPRFMinted");
    log("OPRFMinted events:", minted.length);

    const remainder = minted.find(
      (p: { args: unknown[] }) => String(p.args[0]).toLowerCase() === agentAddress.toLowerCase()
    );
    if (remainder && amount < q) {
      onStatus?.("Decrypting remainder note…");
      await new Promise((r) => setTimeout(r, 8000));
      const [rx, ry, rq] = await decryptHandlesViaProxy({
        handles: [
          BigInt(remainder.args[1] as bigint),
          BigInt(remainder.args[2] as bigint),
          BigInt(remainder.args[3] as bigint),
        ],
        signer,
        aesKeyHex,
        chainId: config.chainId,
      });
      log("remainder plaintext:", { x: rx.toString(), y: ry.toString(), q: rq.toString() });
      upsertNote({
        ...note,
        x: rx.toString(),
        y: ry.toString(),
        q: rq.toString(),
        status: "partially_spent",
      });
      remainderNoteUpdated = true;
    } else if (amount >= q) {
      upsertNote({ ...note, status: "spent" });
      remainderNoteUpdated = true;
    }
  } catch (err) {
    logError("remainder bookkeeping failed (non-fatal):", err);
  }

  onStatus?.("Waiting for MPC unshield → clear balance…");
  const clearAfter = await waitForClearIncrease({
    provider,
    underlying: config.underlying,
    agentAddress,
    before: clearBefore,
  });
  log("=== cashOut done ===", { tx: tx.hash, clearAfter: clearAfter.toString() });

  return {
    redeemTxHash: tx.hash as string,
    clearBalanceAfter: clearAfter,
    remainderNoteUpdated,
  };
}
