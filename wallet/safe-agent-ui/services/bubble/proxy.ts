import type { Signer } from "ethers";
import { getBytes } from "ethers";
import {
  decryptEncryptedOutput,
  handleToBase64,
  handleToBytes,
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

export async function decryptHandleViaProxy(params: {
  handle: bigint;
  signer: Signer;
  aesKeyHex: string;
  chainId: number;
  proxyUrl?: string;
}): Promise<bigint> {
  const { handle, signer, aesKeyHex, chainId } = params;
  if (handle === 0n) return 0n;

  const handleBytes = handleToBytes(handle);
  const signature = await signer.signMessage(handleBytes);
  const body = {
    handle: handleToBase64(handle),
    chain_id: chainId,
    user_signature: Buffer.from(getBytes(signature)).toString("base64"),
  };

  const data = await retry(async () => {
    const response = await fetch("/api/encrypt-to-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
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

export async function decryptHandlesViaProxy(params: {
  handles: bigint[];
  signer: Signer;
  aesKeyHex: string;
  chainId: number;
  proxyUrl?: string;
}): Promise<bigint[]> {
  const { handles, signer, aesKeyHex, chainId } = params;
  if (handles.length === 0) return [];

  const handlesBytes = handles.map(handleToBytes);
  const concat = new Uint8Array(handlesBytes.reduce((n, b) => n + b.length, 0));
  let offset = 0;
  for (const b of handlesBytes) {
    concat.set(b, offset);
    offset += b.length;
  }
  const signature = await signer.signMessage(concat);

  const data = await retry(async () => {
    const response = await fetch("/api/encrypt-to-user", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        handles: handles.map(handleToBase64),
        chain_id: chainId,
        user_signature: Buffer.from(getBytes(signature)).toString("base64"),
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
