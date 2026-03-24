/**
 * Transport (HTTP proxy, provider) + crypto for Bubble tests.
 * Deploy, delays, receipt helpers, and chai-style helpers: `testHelpers.ts`.
 */
import hre from "hardhat";
import fetch from "node-fetch";
import { Wallet, getBytes, HDNodeWallet, solidityPacked, isAddress } from "ethers";

import {
  generateRSAKeyPair,
  reconstructUserKey,
  decrypt,
  encrypt
} from "soda-sdk";

/** One limb in soda-sdk encrypt output: ciphertext block or nonce `r` (bytes). */
const AES_LIMB_BYTES = 16;
/** Single-block payload: `[cipher][r]` (128-bit plaintext after decrypt). */
const ENCRYPTED_SINGLE_OUTPUT_BYTES = AES_LIMB_BYTES * 2;
/** Two-block payload: two `[cipher][r]` pairs (256-bit plaintext after decrypt). */
const ENCRYPTED_DOUBLE_OUTPUT_BYTES = AES_LIMB_BYTES * 4;

/** RSA-encrypted key share size in onboard response (bytes). */
const RSA_CIPHERTEXT_BYTES = 256;

/** AES-128 key as lowercase hex string (16 bytes → 32 hex characters). */
const AES_KEY_HEX_CHARS = 32;

/** 128-bit plaintext in big-endian wire format (bytes). */
const UINT128_BYTES = 16;
/** Exclusive upper bound for uint128 (`2^128`). */
const UINT128_MAX = 2n ** 128n;
/** Bits per uint64 limb when splitting a uint128. */
const UINT64_BITS = 64n;
/** Low 64 bits of a uint128: `(1 << 64) - 1`. */
const UINT64_MASK = (1n << UINT64_BITS) - 1n;
/** Byte offset of the low uint64 in a big-endian uint128. */
const UINT128_LOW_U64_BYTE_OFFSET = 8;

/** 256-bit plaintext in big-endian wire format (bytes). */
const UINT256_BYTES = 32;
/** Hex digits for a full uint256 value (no `0x`). */
const UINT256_HEX_CHARS = 64;
/** First / second half of a uint256 plaintext (bytes), one AES block each. */
const UINT256_HALF_BYTES = AES_LIMB_BYTES;
/** Concatenated [cipher][r] for one half of a uint256 encrypt (32 bytes). */
const ENCRYPT_HALF_UINT256_BYTES = AES_LIMB_BYTES * 2;

/** Truncate `0x`-prefixed handle hex for log lines (full value is 66 chars). */
const HANDLE_HEX_LOG_PREFIX_CHARS = 20;

function handleHexForLog(fullHandleHex: string): string {
  if (fullHandleHex.length <= HANDLE_HEX_LOG_PREFIX_CHARS) {
    return fullHandleHex;
  }
  return `${fullHandleHex.slice(0, HANDLE_HEX_LOG_PREFIX_CHARS)}…`;
}

async function getNetworkWithTimeout(timeoutMs: number, timeoutMessage: string) {
  let timeoutId: NodeJS.Timeout | undefined;
  try {
    const network = await Promise.race([
      hre.ethers.provider.getNetwork(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new Error(timeoutMessage)), timeoutMs);
      }),
    ]);
    return network as any;
  } finally {
    if (timeoutId) {
      clearTimeout(timeoutId);
    }
  }
}

const PROVIDER_NETWORK_TIMEOUT_MS = 30_000;

/**
 * Read `chainId` from the Hardhat provider with timeout and logging (encrypt-to-user / proxy decrypt flows).
 */
async function getChainIdForEncryptToUser(logPrefix: string, contextLabel: string): Promise<number> {
  try {
    console.log(`${logPrefix} Getting network info for ${contextLabel}`);
    const network = await getNetworkWithTimeout(
      PROVIDER_NETWORK_TIMEOUT_MS,
      `${logPrefix} Network call timeout after ${PROVIDER_NETWORK_TIMEOUT_MS / 1000}s for ${contextLabel}`
    );
    const chainId = Number(network.chainId);
    console.log(`${logPrefix} Got network chainId: ${chainId} for ${contextLabel}`);
    return chainId;
  } catch (error) {
    console.error(`${logPrefix} Network call failed for ${contextLabel}:`, error);
    throw error;
  }
}

/** Retry with exponential backoff (`maxRetries` = number of retries after the first attempt). */
export async function retryWithBackoff<T>(
  operation: () => Promise<T>,
  maxRetries: number = 3,
  baseDelay: number = 1000
): Promise<T> {
  let lastError: Error;
  
  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      
      if (attempt === maxRetries) {
        throw lastError;
      }
      
      // Exponential backoff: 1s, 2s, 4s
      const delay = baseDelay * Math.pow(2, attempt);
      console.log(`Attempt ${attempt + 1} failed, retrying in ${delay}ms...`);
      await new Promise(resolve => setTimeout(resolve, delay));
    }
  }
  
  throw lastError!;
}

export async function getUserKeyViaProxy(signer: Wallet | HDNodeWallet, proxyUrl: string) {
  // Get signer's address
  const userAddress = await signer.getAddress();
  console.log(`[getUserKeyViaProxy] Starting onboarding for address ${userAddress} via ${proxyUrl}`);

  // 1. Generate RSA key pair (synchronous function)
  const { publicKey, privateKey } = generateRSAKeyPair();

  // V2: Sign rsa_public_key + user_address
  
  // NPM package returns publicKey in DER format (binary)
  const publicKeyDer = new Uint8Array(publicKey);
  
  // Convert address to bytes using ethers.getBytes like working version
  const addressBytes = hre.ethers.getBytes(userAddress);
  
  // Combine rsaPublicKeyDer + addressBytes (direct concatenation, no hashing)
  const message = new Uint8Array(publicKeyDer.length + addressBytes.length);
  message.set(publicKeyDer, 0);
  message.set(addressBytes, publicKeyDer.length);
  
  const signature = await signer.signMessage(message);
  const signedEK = getBytes(signature);

  // 3. Prepare request data - send DER bytes
  const rsaPublicKey = Buffer.from(publicKeyDer).toString("base64");
  const userSignature = Buffer.from(signedEK).toString("base64");

  const requestData = {
    rsa_public_key: rsaPublicKey,
    user_signature: userSignature,
    address: userAddress,
  };
  
  console.log(`[getUserKeyViaProxy] Sending onboard request to ${proxyUrl}/onboard for address ${userAddress}...`);
  const response = await fetch(`${proxyUrl}/onboard`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(requestData),
  });
  
  console.log(`[getUserKeyViaProxy] Received response status ${response.status} for address ${userAddress}`);
  
  if (!response.ok) {
    const errorText = await response.text();
    console.error(`[getUserKeyViaProxy] Onboarding failed for address ${userAddress}: ${errorText}`);
    throw new Error(`Onboarding failed: ${errorText}`);
  }
  
  const result = (await response.json()) as { rsa_ciphertexts: string; message: string };
  console.log(`[getUserKeyViaProxy] Successfully onboarded address ${userAddress}`);

  // 5. Process response
  const rsaCiphertexts = Buffer.from(result.rsa_ciphertexts, "base64");
  const encryptedKeyShare0 = rsaCiphertexts.slice(0, RSA_CIPHERTEXT_BYTES).toString("hex");
  const encryptedKeyShare1 = rsaCiphertexts.slice(RSA_CIPHERTEXT_BYTES).toString("hex");
  
  // 6. Reconstruct user key
  const decryptedAESKey = reconstructUserKey(privateKey, encryptedKeyShare0, encryptedKeyShare1);

  return decryptedAESKey;
}

/**
 * Helper function to decrypt a single encrypted output
 */
function decryptEncryptedOutput(encryptedOutput: Buffer, userAesKey: Buffer): bigint {
  const userKeyBytes = new Uint8Array(userAesKey);
  
  if (encryptedOutput.length === ENCRYPTED_SINGLE_OUTPUT_BYTES) {
    // Single block [cipher][r]
    const cipher = new Uint8Array(encryptedOutput.slice(0, AES_LIMB_BYTES));
    const r = new Uint8Array(encryptedOutput.slice(AES_LIMB_BYTES, ENCRYPTED_SINGLE_OUTPUT_BYTES));
    
    const decryptedMessage = decrypt(userKeyBytes, r, cipher);
    
    // Convert decrypted bytes to bigint
    let result = 0n;
    for (let i = 0; i < decryptedMessage.length; i++) {
      result = (result << 8n) | BigInt(decryptedMessage[i]);
    }
    return result;
  } else if (encryptedOutput.length === ENCRYPTED_DOUBLE_OUTPUT_BYTES) {
    // Two blocks: [cipherHigh][rHigh][cipherLow][rLow]
    const cipher1 = new Uint8Array(encryptedOutput.slice(0, AES_LIMB_BYTES));
    const r1 = new Uint8Array(encryptedOutput.slice(AES_LIMB_BYTES, AES_LIMB_BYTES * 2));
    const cipher2 = new Uint8Array(encryptedOutput.slice(AES_LIMB_BYTES * 2, AES_LIMB_BYTES * 3));
    const r2 = new Uint8Array(encryptedOutput.slice(AES_LIMB_BYTES * 3, ENCRYPTED_DOUBLE_OUTPUT_BYTES));
    
    // Use the 5-parameter version of decrypt for 256-bit values
    const decryptedMessage = decrypt(userKeyBytes, r1, cipher1, r2, cipher2);
    
    // Convert decrypted bytes to bigint
    let result = 0n;
    for (let i = 0; i < decryptedMessage.length; i++) {
      result = (result << 8n) | BigInt(decryptedMessage[i]);
    }
    return result;
  } else {
    throw new Error(`Unexpected encrypted output length: ${encryptedOutput.length}`);
  }
}

export async function decryptValueViaProxy(
  handle: bigint,
  signer: Wallet | HDNodeWallet,
  userAesKey: Buffer,
  proxyUrl: string,
  debugLogging: boolean = false
): Promise<bigint> {
  const userAddress = await signer.getAddress();
  const handleHex = `0x${handle.toString(16).padStart(64, "0")}`;
  const handleLabel = handleHexForLog(handleHex);
  console.log(`[decryptValueViaProxy] Starting decryption for handle ${handleLabel} (address: ${userAddress})`);

  // Convert handle to bytes (32-byte big-endian)
  const handleBytes = hre.ethers.getBytes(handleHex);

  // Sign the handle bytes
  const signature = await signer.signMessage(handleBytes);

  const chainId = await getChainIdForEncryptToUser("[decryptValueViaProxy]", `handle ${handleLabel}`);

  // Prepare request data
  const handleBase64 = Buffer.from(handleBytes).toString("base64");
  const userSignature = Buffer.from(hre.ethers.getBytes(signature)).toString("base64");

  console.log(`[decryptValueViaProxy] Sending encrypt-to-user request to ${proxyUrl}/encrypt-to-user for handle ${handleLabel}`);
  const data = await retryWithBackoff(async () => {
    const response = await fetch(`${proxyUrl}/encrypt-to-user`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        handle: handleBase64,
        chain_id: chainId,
        user_signature: userSignature,
      }),
    });

    console.log(`[decryptValueViaProxy] Received response status ${response.status} for handle ${handleLabel}`);
    const bodyText = await response.text();
    if (!response.ok) {
      console.error(`[decryptValueViaProxy] encrypt-to-user failed: status=${response.status} body=${bodyText} for handle ${handleLabel}`);
      throw new Error(`HTTP ${response.status}: ${bodyText}`);
    }

    try {
      return JSON.parse(bodyText) as any;
    } catch (error) {
      console.error(`[decryptValueViaProxy] encrypt-to-user invalid JSON response: ${bodyText} for handle ${handleLabel}`);
      throw error;
    }
  });
  const encryptedOutput = Buffer.from(data.output, "base64");
  console.log(`[decryptValueViaProxy] Successfully decrypted handle ${handleLabel}`);

  return decryptEncryptedOutput(encryptedOutput, userAesKey);
}

/**
 * Get decryption callback tx_data via the HTTP proxy (POST /get-decryption).
 * Used to test the GetDecryption endpoint and to submit the callback transaction
 * (e.g. callbackUnshield) when the MPC backend has produced the decryption.
 *
 * @param proxyUrl Base URL of the HTTP proxy (e.g. https://proxy.bubble.sodalabs.net)
 * @param chainId Chain ID of the network
 * @param contractAddress Contract address (hex string with or without 0x)
 * @param userDecryptId Decrypt request ID (e.g. from getLastDecryptRequestId() after unshield)
 * @returns Tx data as hex string (with 0x prefix) to send as transaction data to the contract
 */
export async function getDecryptionTxDataViaProxy(
  proxyUrl: string,
  chainId: number,
  contractAddress: string,
  userDecryptId: bigint | number
): Promise<string> {
  const url = `${proxyUrl.replace(/\/$/, "")}/get-decryption`;
  const body = {
    chain_id: Number(chainId),
    contract_address: contractAddress.startsWith("0x") ? contractAddress : `0x${contractAddress}`,
    user_decrypt_id: typeof userDecryptId === "bigint" ? userDecryptId.toString() : userDecryptId,
  };
  // Backend/MPC can take a long time to produce decryption; use 2 min timeout
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(120_000),
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`get-decryption failed: HTTP ${response.status} ${text}`);
  }
  const data = JSON.parse(text) as { success?: boolean; error?: string; tx_data?: string };
  if (!data.success) {
    throw new Error(data.error ?? "get-decryption failed");
  }
  if (!data.tx_data) {
    return "0x";
  }
  const txDataBytes = Buffer.from(data.tx_data, "base64");
  return "0x" + txDataBytes.toString("hex");
}

/**
 * Batch decrypt multiple handles in a single request.
 * This is more efficient than calling decryptValueViaProxy multiple times
 * as it reduces network round-trips.
 * 
 * @param handles Array of handles to decrypt
 * @param signer Wallet or HDNodeWallet to sign the request
 * @param userAesKey User's AES key for decryption
 * @param proxyUrl URL of the HTTP proxy
 * @param debugLogging Whether to enable debug logging
 * @returns Array of decrypted values in the same order as input handles
 */
export async function decryptMultipleValuesViaProxy(
  handles: bigint[],
  signer: Wallet | HDNodeWallet,
  userAesKey: Buffer,
  proxyUrl: string,
  debugLogging: boolean = false
): Promise<bigint[]> {
  const userAddress = await signer.getAddress();
  console.log(`[decryptMultipleValuesViaProxy] Starting batch decryption for ${handles.length} handle(s) (address: ${userAddress})`);
  
  if (handles.length === 0) {
    return [];
  }

  // Convert all handles to bytes (32-byte big-endian each)
  const handlesBytes: Uint8Array[] = [];
  const handlesBytesToSign: Uint8Array[] = [];
  
  for (const handle of handles) {
    const handleHex = `0x${handle.toString(16).padStart(64, '0')}`;
    const handleBytes = hre.ethers.getBytes(handleHex);
    handlesBytes.push(handleBytes);
    handlesBytesToSign.push(handleBytes);
  }

  // Concatenate all handles for signing
  const concatenatedHandles = new Uint8Array(handlesBytesToSign.reduce((acc, bytes) => acc + bytes.length, 0));
  let offset = 0;
  for (const bytes of handlesBytesToSign) {
    concatenatedHandles.set(bytes, offset);
    offset += bytes.length;
  }

  // Sign the concatenated handles
  const signature = await signer.signMessage(concatenatedHandles);

  const chainId = await getChainIdForEncryptToUser(
    "[decryptMultipleValuesViaProxy]",
    `${handles.length} handle(s)`
  );

  // Prepare request data with handles array
  const handlesBase64 = handlesBytes.map(bytes => Buffer.from(bytes).toString('base64'));
  const userSignature = Buffer.from(hre.ethers.getBytes(signature)).toString('base64');

  console.log(`[decryptMultipleValuesViaProxy] Sending batch encrypt-to-user request to ${proxyUrl}/encrypt-to-user for ${handles.length} handle(s)...`);
  const data = await retryWithBackoff(async () => {
    const response = await fetch(`${proxyUrl}/encrypt-to-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handles: handlesBase64,
        chain_id: chainId,
        user_signature: userSignature,
      }),
    });

    console.log(`[decryptMultipleValuesViaProxy] Received response status ${response.status} for ${handles.length} handle(s)`);
    const bodyText = await response.text();
    if (!response.ok) {
      console.error(`[decryptMultipleValuesViaProxy] encrypt-to-user (batch) failed: status=${response.status} body=${bodyText}`);
      throw new Error(`HTTP ${response.status}: ${bodyText}`);
    }

    try {
      return JSON.parse(bodyText) as any;
    } catch (error) {
      console.error(`[decryptMultipleValuesViaProxy] encrypt-to-user (batch) invalid JSON response: ${bodyText}`);
      throw error;
    }
  });
  console.log(`[decryptMultipleValuesViaProxy] Successfully received batch response for ${handles.length} handle(s)`);

  // Process all outputs
  if (!data.outputs || !Array.isArray(data.outputs)) {
    throw new Error(`Expected outputs array in response, got: ${JSON.stringify(data)}`);
  }

  if (data.outputs.length !== handles.length) {
    throw new Error(`Expected ${handles.length} outputs, got ${data.outputs.length}`);
  }

  // Decrypt each output
  const decryptedValues: bigint[] = [];
  for (const outputBase64 of data.outputs) {
    const encryptedOutput = Buffer.from(outputBase64, 'base64');
    const decryptedValue = decryptEncryptedOutput(encryptedOutput, userAesKey);
    decryptedValues.push(decryptedValue);
  }

  return decryptedValues;
}


// Alias for backward compatibility
export const decryptBalanceViaProxy = decryptValueViaProxy;

// --- Bubble-specific message preparation for ValidateCiphertext / ValidateCiphertext256 ---

/**
 * Encrypt one ≤16-byte block and interpret `ciphertext ‖ r` as a uint256 (Bubble wire format for `itUint128` limbs).
 */
function encryptBlockToEncryptedUint256(keyBytes: Uint8Array, plaintextBlock: Uint8Array): bigint {
  const { ciphertext, r } = encrypt(keyBytes, plaintextBlock);
  const ct = Buffer.concat([ciphertext, r]);
  return BigInt("0x" + ct.toString("hex"));
}

/**
 * Prepares a message for ValidateCiphertext for 128-bit values.
 */
export function prepareMessageForBubble128(
  plaintext: bigint,
  signerAddress: string,
  aesKey: string,
  contractAddress: string
): {
  encryptedInt: bigint;
  messageBytes: Uint8Array;
} {
  if (!isAddress(signerAddress)) {
    throw new TypeError("Invalid signer address");
  }
  if (typeof aesKey !== "string" || aesKey.length !== AES_KEY_HEX_CHARS) {
    throw new TypeError("Invalid AES key length. Expected 16 bytes as hex string (32 characters).");
  }
  if (typeof contractAddress !== "string" || !isAddress(contractAddress)) {
    throw new TypeError("Invalid contract address");
  }
  if (plaintext < 0n || plaintext >= UINT128_MAX) {
    throw new TypeError("Plaintext value must be >= 0 and < 2^128 for 128-bit values");
  }

  const plaintextBytes = Buffer.alloc(UINT128_BYTES);
  plaintextBytes.writeBigUInt64BE(plaintext >> UINT64_BITS, 0);
  plaintextBytes.writeBigUInt64BE(plaintext & UINT64_MASK, UINT128_LOW_U64_BYTE_OFFSET);

  const keyBytes = new Uint8Array(Buffer.from(aesKey, "hex"));
  const encryptedInt = encryptBlockToEncryptedUint256(keyBytes, new Uint8Array(plaintextBytes));
  const messageBytes = solidityPacked(
    ["address", "address", "uint256"],
    [signerAddress, contractAddress, encryptedInt]
  );

  return { encryptedInt, messageBytes: getBytes(messageBytes) };
}

/**
 * Prepares a message for ValidateCiphertext256 (256-bit values): encrypts plaintext as two blocks
 * and returns encryptedHigh, encryptedLow, and messageBytes = abi.encodePacked(signer, contract, high, low).
 */
export function prepareMessageForBubble256(
  plaintext: bigint,
  signerAddress: string,
  aesKey: string,
  contractAddress: string
): {
  encryptedHigh: bigint;
  encryptedLow: bigint;
  messageBytes: Uint8Array;
} {
  if (!isAddress(signerAddress)) {
    throw new TypeError("Invalid signer address");
  }
  if (typeof aesKey !== "string" || aesKey.length !== AES_KEY_HEX_CHARS) {
    throw new TypeError("Invalid AES key length. Expected 16 bytes as hex string (32 characters).");
  }
  if (typeof contractAddress !== "string" || !isAddress(contractAddress)) {
    throw new TypeError("Invalid contract address");
  }

  const plaintextBytes = Buffer.alloc(UINT256_BYTES);
  const hexString = plaintext.toString(16).padStart(UINT256_HEX_CHARS, "0");
  const valueBytes = Buffer.from(hexString, "hex");
  valueBytes.copy(plaintextBytes, UINT256_BYTES - valueBytes.length);

  const keyBytes = new Uint8Array(Buffer.from(aesKey, "hex"));
  const encryptedHigh = encryptBlockToEncryptedUint256(
    keyBytes,
    new Uint8Array(plaintextBytes.subarray(0, UINT256_HALF_BYTES))
  );
  const encryptedLow = encryptBlockToEncryptedUint256(
    keyBytes,
    new Uint8Array(plaintextBytes.subarray(UINT256_HALF_BYTES))
  );

  const messageBytes = solidityPacked(
    ["address", "address", "uint256", "uint256"],
    [signerAddress, contractAddress, encryptedHigh, encryptedLow]
  );

  return { encryptedHigh, encryptedLow, messageBytes: getBytes(messageBytes) };
}
