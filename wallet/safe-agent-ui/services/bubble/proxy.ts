import type { Signer } from "ethers";
import {
  decryptEncryptedOutput,
  handleToBase64,
  onboardViaProxy,
} from "./crypto";
import { getStoredUserKey, storeUserKey } from "./userKeyStorage";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function retry<T>(fn: () => Promise<T>, attempts = 4): Promise<T> {
  let last: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await fn();
    } catch (e) {
      last = e;
      const msg = e instanceof Error ? e.message.toLowerCase() : String(e).toLowerCase();
      const retryable =
        msg.includes("pending") || msg.includes("unknown handle") || msg.includes("temporarily");
      if (!retryable || i === attempts - 1) throw e;
      await sleep(3000 * (i + 1));
    }
  }
  throw last;
}

export async function ensureUserKey(signer: Signer, chainId: number, _proxyUrl?: string): Promise<string> {
  const address = await signer.getAddress();
  const existing = getStoredUserKey(address, chainId);
  if (existing) {
    console.log("[ensureUserKey] cache hit", { address, chainId, keyLen: existing.length });
    return existing;
  }
  console.log("[ensureUserKey] cache miss — onboarding via /api/onboard", { address, chainId });
  const aesKeyHex = await onboardViaProxy(signer, { chainId });
  storeUserKey(address, chainId, aesKeyHex);
  console.log("[ensureUserKey] onboarded", { address, chainId, keyLen: aesKeyHex.length });
  return aesKeyHex;
}

/**
 * Sodawallet-style decrypt: POST /encrypt-to-user with `owner` only — no MetaMask signature.
 * Requires the owner address to already have view ACL on the handle (self-owned EOA balance,
 * or Safe → EOA contract/handle view grant).
 */
export async function decryptHandleByOwner(params: {
  handle: bigint;
  ownerAddress: string;
  aesKeyHex: string;
  chainId: number;
}): Promise<bigint> {
  const { handle, ownerAddress, aesKeyHex, chainId } = params;
  if (handle === 0n) return 0n;

  const data = await retry(async () => {
    const response = await fetch("/api/encrypt-to-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        handle: handleToBase64(handle),
        chain_id: chainId,
        owner: ownerAddress,
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
    return JSON.parse(text) as { output?: string; error?: string };
  });

  if (typeof data.output !== "string") {
    throw new Error(data.error || "Proxy response missing output");
  }
  return decryptEncryptedOutput(Buffer.from(data.output, "base64"), aesKeyHex);
}

export async function decryptHandlesByOwner(params: {
  handles: bigint[];
  ownerAddress: string;
  aesKeyHex: string;
  chainId: number;
}): Promise<bigint[]> {
  const { handles, ownerAddress, aesKeyHex, chainId } = params;
  if (handles.length === 0) return [];

  const data = await retry(async () => {
    const response = await fetch("/api/encrypt-to-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        handles: handles.map(handleToBase64),
        chain_id: chainId,
        owner: ownerAddress,
      }),
    });
    const text = await response.text();
    if (!response.ok) throw new Error(`HTTP ${response.status}: ${text}`);
    return JSON.parse(text) as { outputs?: string[]; error?: string };
  });

  if (!data.outputs || data.outputs.length !== handles.length) {
    throw new Error(data.error || "Unexpected batch decrypt response");
  }
  return data.outputs.map((o) => decryptEncryptedOutput(Buffer.from(o, "base64"), aesKeyHex));
}

/** @deprecated Prefer decryptHandleByOwner (no wallet signature). Kept for rare signed paths. */
export async function decryptHandleViaProxy(params: {
  handle: bigint;
  signer: Signer;
  aesKeyHex: string;
  chainId: number;
  proxyUrl?: string;
}): Promise<bigint> {
  const ownerAddress = await params.signer.getAddress();
  return decryptHandleByOwner({
    handle: params.handle,
    ownerAddress,
    aesKeyHex: params.aesKeyHex,
    chainId: params.chainId,
  });
}

/** @deprecated Prefer decryptHandlesByOwner (no wallet signature). */
export async function decryptHandlesViaProxy(params: {
  handles: bigint[];
  signer: Signer;
  aesKeyHex: string;
  chainId: number;
  proxyUrl?: string;
}): Promise<bigint[]> {
  const ownerAddress = await params.signer.getAddress();
  return decryptHandlesByOwner({
    handles: params.handles,
    ownerAddress,
    aesKeyHex: params.aesKeyHex,
    chainId: params.chainId,
  });
}
