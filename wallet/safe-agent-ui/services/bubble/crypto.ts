import { decrypt, encrypt, generateRSAKeyPair, reconstructUserKey } from "soda-sdk";
import { getBytes, isAddress } from "ethers";

const AES_LIMB_BYTES = 16;
const ENCRYPTED_SINGLE_OUTPUT_BYTES = 32;
const ENCRYPTED_DOUBLE_OUTPUT_BYTES = 64;
const RSA_CIPHERTEXT_BYTES = 256;
const AES_KEY_HEX_CHARS = 32;
const UINT128_BYTES = 16;
const UINT128_MAX = 2n ** 128n;
const UINT64_BITS = 64n;
const UINT64_MASK = (1n << UINT64_BITS) - 1n;
const UINT128_LOW_U64_BYTE_OFFSET = 8;
const UINT256_BYTES = 32;
const UINT256_MAX = 2n ** 256n;
const UINT256_HEX_CHARS = 64;
const UINT256_HALF_BYTES = 16;

function bytesToBigInt(bytes: Uint8Array): bigint {
  let result = 0n;
  for (const byte of bytes) {
    result = (result << 8n) | BigInt(byte);
  }
  return result;
}

export function decryptEncryptedOutput(encryptedOutput: Buffer, userAesKeyHex: string): bigint {
  const userKeyBytes = new Uint8Array(Buffer.from(userAesKeyHex, "hex"));

  if (encryptedOutput.length === ENCRYPTED_SINGLE_OUTPUT_BYTES) {
    const cipher = new Uint8Array(encryptedOutput.subarray(0, AES_LIMB_BYTES));
    const r = new Uint8Array(encryptedOutput.subarray(AES_LIMB_BYTES, ENCRYPTED_SINGLE_OUTPUT_BYTES));
    return bytesToBigInt(decrypt(userKeyBytes, r, cipher));
  }

  if (encryptedOutput.length === ENCRYPTED_DOUBLE_OUTPUT_BYTES) {
    const cipher1 = new Uint8Array(encryptedOutput.subarray(0, AES_LIMB_BYTES));
    const r1 = new Uint8Array(encryptedOutput.subarray(AES_LIMB_BYTES, AES_LIMB_BYTES * 2));
    const cipher2 = new Uint8Array(encryptedOutput.subarray(AES_LIMB_BYTES * 2, AES_LIMB_BYTES * 3));
    const r2 = new Uint8Array(encryptedOutput.subarray(AES_LIMB_BYTES * 3, ENCRYPTED_DOUBLE_OUTPUT_BYTES));
    return bytesToBigInt(decrypt(userKeyBytes, r1, cipher1, r2, cipher2));
  }

  throw new Error(`Unexpected encrypted output length: ${encryptedOutput.length}`);
}

function bufferToUint8Array(buf: Buffer): Uint8Array {
  return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
}

function aesKeyBytes(aesKeyHex: string): Uint8Array {
  const buf = Buffer.from(aesKeyHex, "hex");
  if (buf.length !== 16) {
    throw new TypeError(`AES key must be 16 bytes, got ${buf.length}`);
  }
  return bufferToUint8Array(buf);
}

/** Encrypt a uint128 for ValidateCiphertext (OPRF x limb). Matches sodawallet signMessage.ts. */
export function prepareMessageForBubble128(
  plaintext: bigint,
  signerAddress: string,
  aesKeyHex: string,
  contractAddress: string
): { encryptedInt: bigint } {
  if (!isAddress(signerAddress) || !isAddress(contractAddress)) {
    throw new TypeError("Invalid address");
  }
  if (aesKeyHex.length !== AES_KEY_HEX_CHARS) {
    throw new TypeError("Invalid AES key length");
  }
  if (plaintext < 0n || plaintext >= UINT128_MAX) {
    throw new TypeError("Plaintext out of uint128 range");
  }

  const plaintextBytes = Buffer.alloc(UINT128_BYTES);
  plaintextBytes.writeBigUInt64BE(plaintext >> UINT64_BITS, 0);
  plaintextBytes.writeBigUInt64BE(plaintext & UINT64_MASK, UINT128_LOW_U64_BYTE_OFFSET);

  const { ciphertext, r } = encrypt(aesKeyBytes(aesKeyHex), bufferToUint8Array(plaintextBytes));
  const ct = new Uint8Array(ciphertext.length + r.length);
  ct.set(ciphertext, 0);
  ct.set(r, ciphertext.length);
  return { encryptedInt: BigInt("0x" + Buffer.from(ct).toString("hex")) };
}

export function buildItUint128(params: {
  value: bigint;
  userAddress: string;
  userAesKeyHex: string;
  contractAddress: string;
}) {
  const { encryptedInt } = prepareMessageForBubble128(
    params.value,
    params.userAddress,
    params.userAesKeyHex,
    params.contractAddress
  );
  return {
    userAddress: params.userAddress,
    ciphertext: encryptedInt,
  };
}

/** Encrypt a uint256 for ValidateCiphertext256. Matches sodawallet signMessage.ts. */
export function prepareMessageForBubble256(
  plaintext: bigint,
  signerAddress: string,
  aesKeyHex: string,
  contractAddress: string
): { encryptedHigh: bigint; encryptedLow: bigint } {
  if (!isAddress(signerAddress) || !isAddress(contractAddress)) {
    throw new TypeError("Invalid address");
  }
  if (aesKeyHex.length !== AES_KEY_HEX_CHARS) {
    throw new TypeError("Invalid AES key length");
  }
  if (plaintext < 0n || plaintext >= UINT256_MAX) {
    throw new TypeError("Plaintext out of uint256 range");
  }

  const plaintextHex = plaintext.toString(16).padStart(UINT256_HEX_CHARS, "0");
  const highBuf = Buffer.from(plaintextHex.slice(0, 32), "hex");
  const lowBuf = Buffer.from(plaintextHex.slice(32, 64), "hex");
  const key = aesKeyBytes(aesKeyHex);

  const { ciphertext: c1, r: r1 } = encrypt(key, bufferToUint8Array(highBuf));
  const { ciphertext: c2, r: r2 } = encrypt(key, bufferToUint8Array(lowBuf));

  const ct = new Uint8Array(64);
  ct.set(c1, 0);
  ct.set(r1, 16);
  ct.set(c2, 32);
  ct.set(r2, 48);
  const ctHex = Buffer.from(ct).toString("hex");

  return {
    encryptedHigh: BigInt("0x" + ctHex.slice(0, 64)),
    encryptedLow: BigInt("0x" + ctHex.slice(64, 128)),
  };
}

export function buildItUint256(params: {
  value: bigint;
  userAddress: string;
  userAesKeyHex: string;
  contractAddress: string;
}) {
  const { encryptedHigh, encryptedLow } = prepareMessageForBubble256(
    params.value,
    params.userAddress,
    params.userAesKeyHex,
    params.contractAddress
  );
  return {
    userAddress: params.userAddress,
    ciphertext: { ciphertextHigh: encryptedHigh, ciphertextLow: encryptedLow },
  };
}

export function handleToBytes(handle: bigint): Uint8Array {
  const hex = handle.toString(16).padStart(64, "0");
  return getBytes("0x" + hex);
}

export function handleToBase64(handle: bigint): string {
  return Buffer.from(handleToBytes(handle)).toString("base64");
}

export async function onboardViaProxy(
  signer: { getAddress: () => Promise<string>; signMessage: (msg: string | Uint8Array) => Promise<string> },
  options?: { chainId?: number }
): Promise<string> {
  const userAddress = await signer.getAddress();
  const { publicKey, privateKey } = generateRSAKeyPair();
  const publicKeyDer = new Uint8Array(publicKey instanceof Uint8Array ? publicKey : Uint8Array.from(publicKey));
  const addressBytes = getBytes(userAddress);
  const message = new Uint8Array(publicKeyDer.length + addressBytes.length);
  message.set(publicKeyDer, 0);
  message.set(addressBytes, publicKeyDer.length);

  const signature = await signer.signMessage(message);
  const requestData = {
    rsa_public_key: Buffer.from(publicKeyDer).toString("base64"),
    user_signature: Buffer.from(getBytes(signature)).toString("base64"),
    address: userAddress,
    ...(options?.chainId != null ? { chain_id: options.chainId } : {}),
  };

  // Same-origin Next API route proxies to Bubble (avoids browser CORS).
  const response = await fetch("/api/onboard", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestData),
  });
  if (!response.ok) {
    throw new Error(`Onboarding failed: ${await response.text()}`);
  }
  const result = (await response.json()) as { rsa_ciphertexts?: string; error?: string };
  if (!result.rsa_ciphertexts) {
    throw new Error(result.error || "Onboarding response missing rsa_ciphertexts");
  }
  const rsaCiphertexts = Buffer.from(result.rsa_ciphertexts, "base64");
  if (rsaCiphertexts.length !== RSA_CIPHERTEXT_BYTES * 2) {
    throw new Error(`Invalid rsa_ciphertexts length: ${rsaCiphertexts.length}`);
  }
  const share0 = rsaCiphertexts.subarray(0, RSA_CIPHERTEXT_BYTES).toString("hex");
  const share1 = rsaCiphertexts.subarray(RSA_CIPHERTEXT_BYTES).toString("hex");
  const aesKey = reconstructUserKey(privateKey, share0, share1);
  const aesKeyHex = aesKey.toString("hex");
  if (aesKeyHex.length !== AES_KEY_HEX_CHARS) {
    throw new Error(`Unexpected AES key length: ${aesKeyHex.length}`);
  }
  return aesKeyHex;
}
