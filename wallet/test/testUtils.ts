import hre from "hardhat";
import fetch from "node-fetch";
import { Wallet, getBytes, HDNodeWallet, solidityPacked, isAddress } from "ethers";
import crypto from "crypto";

import {
  generateRSAKeyPair,
  reconstructUserKey,
  decrypt,
  encrypt
} from "soda-sdk";

// Utility function to retry operations with exponential backoff
async function retryWithBackoff<T>(
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

  // V2: Sign rsa_public_key + user_address (new behavior)
  
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

  // 3. Prepare request data - send DER bytes like the webapp implementation
  const rsaPublicKey = Buffer.from(publicKeyDer).toString("base64");
  const userSignature = Buffer.from(signedEK).toString("base64");

  // Get chain ID from the provider (with timeout to avoid hanging)
  let chainId: number;
  try {
    console.log(`[getUserKeyViaProxy] Getting network info for address ${userAddress}...`);
    const network = await Promise.race([
      hre.ethers.provider.getNetwork(),
      new Promise((_, reject) => 
        setTimeout(() => {
          console.error(`[getUserKeyViaProxy] Network call timeout after 30s for address ${userAddress}`);
          reject(new Error('Network call timeout'));
        }, 30000)
      )
    ]) as any;
    chainId = Number(network.chainId);
    console.log(`[getUserKeyViaProxy] Got network chainId: ${chainId} for address ${userAddress}`);
  } catch (error) {
    // Fallback to world-mobile-testnet chain ID if network call fails
    console.warn(`[getUserKeyViaProxy] Network call failed, using fallback chainId 323432 for address ${userAddress}`);
    chainId = 323432;
  }
  
  const requestData = {
    rsa_public_key: rsaPublicKey,
    user_signature: userSignature,
    address: userAddress,
    chain_id: chainId
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
  const RSA_CIPHERTEXT_SIZE = 256;
  const encryptedKeyShare0 = rsaCiphertexts.slice(0, RSA_CIPHERTEXT_SIZE).toString("hex");
  const encryptedKeyShare1 = rsaCiphertexts.slice(RSA_CIPHERTEXT_SIZE).toString("hex");
  
  // 6. Reconstruct user key
  const decryptedAESKey = reconstructUserKey(privateKey, encryptedKeyShare0, encryptedKeyShare1);

  return decryptedAESKey;
}

/**
 * Onboard a user using the Integration Service API
 * @param signer Wallet or HDNodeWallet to onboard
 * @param integrationServiceUrl Base URL of the Integration Service (e.g., https://isb.sodalabs.net)
 * @param apiKey Optional API key for authentication
 * @returns User's AES key as a Buffer
 */
export async function getUserKeyViaIntegrationService(
  signer: Wallet | HDNodeWallet,
  integrationServiceUrl: string,
  apiKey?: string
): Promise<Buffer> {
  // Get signer's address (deposit address)
  const userAddress = await signer.getAddress();

  // 1. Generate RSA key pair (synchronous function)
  const { publicKey, privateKey } = generateRSAKeyPair();

  // V2: Sign rsa_public_key + user_address (new behavior)
  
  // NPM package returns publicKey in DER format (binary)
  const publicKeyDer = new Uint8Array(publicKey);
  
  // Convert address to bytes using ethers.getBytes
  const addressBytes = hre.ethers.getBytes(userAddress);
  
  // Combine rsaPublicKeyDer + addressBytes (direct concatenation, no hashing)
  const message = new Uint8Array(publicKeyDer.length + addressBytes.length);
  message.set(publicKeyDer, 0);
  message.set(addressBytes, publicKeyDer.length);
  
  const signature = await signer.signMessage(message);
  const signedEK = getBytes(signature);

  // 3. Prepare request data for Integration Service API
  const rsaPublicKey = Buffer.from(publicKeyDer).toString("base64");
  const userSignature = Buffer.from(signedEK).toString("base64");
  
  const requestData = {
    rsaPublicKey: rsaPublicKey,
    depositAddress: userAddress,
    signature: userSignature
  };
  
  // Prepare headers
  const headers: Record<string, string> = {
    "Content-Type": "application/json"
  };
  
  // Add API key if provided
  if (apiKey) {
    headers["x-api-key"] = apiKey;
  }
  
  const url = `${integrationServiceUrl.replace(/\/$/, "")}/v1/user-keys/onBoardUser`;
  const response = await fetch(url, {
    method: "POST",
    headers,
    body: JSON.stringify(requestData),
  });
  
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Onboarding failed (${response.status}): ${errorText}`);
  }
  
  // Parse response - Integration Service returns ResponseEnvelope format
  const result = (await response.json()) as {
    success: boolean;
    message: string;
    data?: {
      keyShares: string;
      rsaPublicKey: string;
      depositAddress: string;
      signature: string;
    };
    error?: string;
    errorCode?: string;
  };

  if (!result.success || !result.data) {
    throw new Error(`Onboarding failed: ${result.error || result.message || "Unknown error"}`);
  }

  // 5. Process response - keyShares is the same as rsa_ciphertexts
  const rsaCiphertexts = Buffer.from(result.data.keyShares, "base64");
  const RSA_CIPHERTEXT_SIZE = 256;
  const encryptedKeyShare0 = rsaCiphertexts.slice(0, RSA_CIPHERTEXT_SIZE).toString("hex");
  const encryptedKeyShare1 = rsaCiphertexts.slice(RSA_CIPHERTEXT_SIZE).toString("hex");
  
  // 6. Reconstruct user key
  const decryptedAESKey = reconstructUserKey(privateKey, encryptedKeyShare0, encryptedKeyShare1);

  return decryptedAESKey;
}

/**
 * Helper function to decrypt a single encrypted output
 */
function decryptEncryptedOutput(encryptedOutput: Buffer, userAesKey: Buffer): bigint {
  const userKeyBytes = new Uint8Array(userAesKey);
  
  if (encryptedOutput.length === 32) {
    // 32-byte format: single block [cipher (16), r (16)]
    const cipher = new Uint8Array(encryptedOutput.slice(0, 16));
    const r = new Uint8Array(encryptedOutput.slice(16, 32));
    
    const decryptedMessage = decrypt(userKeyBytes, r, cipher);
    
    // Convert decrypted bytes to bigint
    let result = 0n;
    for (let i = 0; i < decryptedMessage.length; i++) {
      result = (result << 8n) | BigInt(decryptedMessage[i]);
    }
    return result;
  } else if (encryptedOutput.length === 64) {
    // 64-byte format: two blocks [cipherHigh (16), rHigh (16), cipherLow (16), rLow (16)]
    const cipher1 = new Uint8Array(encryptedOutput.slice(0, 16));
    const r1 = new Uint8Array(encryptedOutput.slice(16, 32));
    const cipher2 = new Uint8Array(encryptedOutput.slice(32, 48));
    const r2 = new Uint8Array(encryptedOutput.slice(48, 64));
    
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
  const handleHex = `0x${handle.toString(16).padStart(64, '0')}`;
  console.log(`[decryptValueViaProxy] Starting decryption for handle ${handleHex.substring(0, 20)}... (address: ${userAddress})`);

  // Convert handle to bytes (32-byte big-endian)
  const handleBytes = hre.ethers.getBytes(handleHex);

  // Sign the handle bytes
  const signature = await signer.signMessage(handleBytes);

  // Get chain ID from the provider (with timeout to avoid hanging)
  let chainId: number;
  try {
    console.log(`[decryptValueViaProxy] Getting network info for handle ${handleHex.substring(0, 20)}...`);
    const network = await Promise.race([
      hre.ethers.provider.getNetwork(),
      new Promise((_, reject) => 
        setTimeout(() => {
          console.error(`[decryptValueViaProxy] Network call timeout after 30s for handle ${handleHex.substring(0, 20)}`);
          reject(new Error('Network call timeout'));
        }, 30000)
      )
    ]) as any;
    chainId = Number(network.chainId);
    console.log(`[decryptValueViaProxy] Got network chainId: ${chainId} for handle ${handleHex.substring(0, 20)}`);
  } catch (error) {
    console.error(`[decryptValueViaProxy] Network call failed for handle ${handleHex.substring(0, 20)}:`, error);
    throw error;
  }


  // Prepare request data
  const handleBase64 = Buffer.from(handleBytes).toString('base64');
  const userSignature = Buffer.from(hre.ethers.getBytes(signature)).toString('base64');

  console.log(`[decryptValueViaProxy] Sending encrypt-to-user request to ${proxyUrl}/encrypt-to-user for handle ${handleHex.substring(0, 20)}...`);
  const data = await retryWithBackoff(async () => {
    const response = await fetch(`${proxyUrl}/encrypt-to-user`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        handle: handleBase64,
        chain_id: chainId,
        user_signature: userSignature,
      }),
    });

    console.log(`[decryptValueViaProxy] Received response status ${response.status} for handle ${handleHex.substring(0, 20)}`);
    const bodyText = await response.text();
    if (!response.ok) {
      console.error(`[decryptValueViaProxy] encrypt-to-user failed: status=${response.status} body=${bodyText} for handle ${handleHex.substring(0, 20)}`);
      throw new Error(`HTTP ${response.status}: ${bodyText}`);
    }

    try {
      return JSON.parse(bodyText) as any;
    } catch (error) {
      console.error(`[decryptValueViaProxy] encrypt-to-user invalid JSON response: ${bodyText} for handle ${handleHex.substring(0, 20)}`);
      throw error;
    }
  });
  const encryptedOutput = Buffer.from(data.output, 'base64');
  console.log(`[decryptValueViaProxy] Successfully decrypted handle ${handleHex.substring(0, 20)}`);

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

  // Concatenate all handles for signing (same order as Python implementation)
  const concatenatedHandles = new Uint8Array(handlesBytesToSign.reduce((acc, bytes) => acc + bytes.length, 0));
  let offset = 0;
  for (const bytes of handlesBytesToSign) {
    concatenatedHandles.set(bytes, offset);
    offset += bytes.length;
  }

  // Sign the concatenated handles
  const signature = await signer.signMessage(concatenatedHandles);

  // Get chain ID from the provider (with timeout to avoid hanging)
  let chainId: number;
  try {
    console.log(`[decryptMultipleValuesViaProxy] Getting network info for ${handles.length} handle(s)...`);
    const network = await Promise.race([
      hre.ethers.provider.getNetwork(),
      new Promise((_, reject) => 
        setTimeout(() => {
          console.error(`[decryptMultipleValuesViaProxy] Network call timeout after 30s for ${handles.length} handle(s)`);
          reject(new Error('Network call timeout'));
        }, 30000)
      )
    ]) as any;
    chainId = Number(network.chainId);
    console.log(`[decryptMultipleValuesViaProxy] Got network chainId: ${chainId} for ${handles.length} handle(s)`);
  } catch (error) {
    console.error(`[decryptMultipleValuesViaProxy] Network call failed for ${handles.length} handle(s):`, error);
    throw error;
  }

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
 * Prepares a message for ValidateCiphertext by encrypting the plaintext and building
 * abi.encodePacked(signerAddress, contractAddress, encryptedInt).
 */
export function prepareMessageForBubble(
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
  if (typeof aesKey !== "string" || aesKey.length !== 32) {
    throw new TypeError("Invalid AES key length. Expected 16 bytes as hex string (32 characters).");
  }
  if (typeof contractAddress !== "string" || !isAddress(contractAddress)) {
    throw new TypeError("Invalid contract address");
  }

  const plaintextBytes = Buffer.alloc(8);
  plaintextBytes.writeBigUInt64BE(plaintext);
  const keyBytes = new Uint8Array(Buffer.from(aesKey, "hex"));
  const { ciphertext, r } = encrypt(keyBytes, new Uint8Array(plaintextBytes));
  const ct = new Uint8Array(ciphertext.length + r.length);
  ct.set(ciphertext, 0);
  ct.set(r, ciphertext.length);

  const encryptedInt = BigInt("0x" + Buffer.from(ct).toString("hex"));
  const messageBytes = solidityPacked(
    ["address", "address", "uint256"],
    [signerAddress, contractAddress, encryptedInt]
  );

  return { encryptedInt, messageBytes: getBytes(messageBytes) };
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
  if (typeof aesKey !== "string" || aesKey.length !== 32) {
    throw new TypeError("Invalid AES key length. Expected 16 bytes as hex string (32 characters).");
  }
  if (typeof contractAddress !== "string" || !isAddress(contractAddress)) {
    throw new TypeError("Invalid contract address");
  }
  if (plaintext < 0n || plaintext >= 2n ** 128n) {
    throw new TypeError("Plaintext value must be >= 0 and < 2^128 for 128-bit values");
  }

  const plaintextBytes = Buffer.alloc(16);
  plaintextBytes.writeBigUInt64BE(plaintext >> 64n, 0);
  plaintextBytes.writeBigUInt64BE(plaintext & ((1n << 64n) - 1n), 8);

  const keyBytes = new Uint8Array(Buffer.from(aesKey, "hex"));
  const { ciphertext, r } = encrypt(keyBytes, new Uint8Array(plaintextBytes));
  const ct = new Uint8Array(ciphertext.length + r.length);
  ct.set(ciphertext, 0);
  ct.set(r, ciphertext.length);

  const encryptedInt = BigInt("0x" + Buffer.from(ct).toString("hex"));
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
  if (typeof aesKey !== "string" || aesKey.length !== 32) {
    throw new TypeError("Invalid AES key length. Expected 16 bytes as hex string (32 characters).");
  }
  if (typeof contractAddress !== "string" || !isAddress(contractAddress)) {
    throw new TypeError("Invalid contract address");
  }

  const plaintextBytes = Buffer.alloc(32);
  const hexString = plaintext.toString(16).padStart(64, "0");
  const valueBytes = Buffer.from(hexString, "hex");
  valueBytes.copy(plaintextBytes, 32 - valueBytes.length);

  const keyBytes = new Uint8Array(Buffer.from(aesKey, "hex"));
  const resultHigh = encrypt(keyBytes, new Uint8Array(plaintextBytes.slice(0, 16)));
  const resultLow = encrypt(keyBytes, new Uint8Array(plaintextBytes.slice(16)));

  const ct = Buffer.concat([
    resultHigh.ciphertext,
    resultHigh.r,
    resultLow.ciphertext,
    resultLow.r,
  ]);
  const ciphertextHigh = ct.slice(0, 32);
  const ciphertextLow = ct.slice(32);

  const encryptedHigh = BigInt("0x" + ciphertextHigh.toString("hex"));
  const encryptedLow = BigInt("0x" + ciphertextLow.toString("hex"));

  const messageBytes = solidityPacked(
    ["address", "address", "uint256", "uint256"],
    [signerAddress, contractAddress, encryptedHigh, encryptedLow]
  );

  return { encryptedHigh, encryptedLow, messageBytes: getBytes(messageBytes) };
}
