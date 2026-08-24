import type { HardhatRuntimeEnvironment } from "hardhat/types";
import { Interface } from "ethers";
import {
  encodeContractCall,
  execSafeTransaction,
} from "../../scripts/safe/safe-tx";
import { deploySafeWallet, getOrDeploySafeInfrastructure } from "./safeHelpers";
import { GCACL_ABI, getGcAclAddress } from "./testHelpers";

export { getOrDeploySafeInfrastructure } from "./safeHelpers";

const ERC20_ABI = [
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
] as const;

const PRIVATE_ERC20_TRANSFER_ABI = [
  "function transfer(address to, tuple(address userAddress, tuple(uint256 ciphertextHigh, uint256 ciphertextLow) ciphertext) it) returns (bool)",
] as const;

const PRIVATE_ERC20_ABI = [
  "function shield(uint256 amount) returns (bool)",
  "function balanceOf(address account) view returns (uint256)",
] as const;

const PRIVATE_ERC20_OPRF_ABI = [
  "function mintOPRFToken(tuple(address userAddress, tuple(uint256 ciphertextHigh, uint256 ciphertextLow) ciphertext) quantity) external",
  "function splitTokenForRecipient(tuple(address userAddress, uint256 ciphertext) x, tuple(address userAddress, tuple(uint256 ciphertextHigh, uint256 ciphertextLow) ciphertext) q, uint128 y_clear, tuple(address userAddress, tuple(uint256 ciphertextHigh, uint256 ciphertextLow) ciphertext) qSplit, address recipient) external",
  "function burnToken(tuple(address userAddress, uint256 ciphertext) x, tuple(address userAddress, tuple(uint256 ciphertextHigh, uint256 ciphertextLow) ciphertext) q, uint128 y_clear, address recipient) external",
  "function redeemMany(tuple(tuple(address userAddress, uint256 ciphertext) x, tuple(address userAddress, tuple(uint256 ciphertextHigh, uint256 ciphertextLow) ciphertext) q, uint128 y_clear)[] tokens, tuple(address userAddress, tuple(uint256 ciphertextHigh, uint256 ciphertextLow) ciphertext) amount, address recipient) external",
] as const;

export type ItUint256Payload = {
  userAddress: string;
  ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint };
};

export type ItUint128Payload = {
  userAddress: string;
  ciphertext: bigint;
};

export async function resolveSafeForTests(
  hre: HardhatRuntimeEnvironment,
  ownerAddress: string,
  ownerSigner: { provider: unknown },
  saltNonce = BigInt(Date.now())
) {
  const envSafe = process.env.SAFE_ADDRESS?.trim();
  if (envSafe) {
    const safe = await hre.ethers.getContractAt(
      [
        "function getOwners() view returns (address[])",
        "function getThreshold() view returns (uint256)",
        "function VERSION() view returns (string)",
        "function nonce() view returns (uint256)",
      ],
      envSafe,
      ownerSigner as any
    );
    const owners = await safe.getOwners();
    if (!owners.map((o: string) => o.toLowerCase()).includes(ownerAddress.toLowerCase())) {
      throw new Error(`SAFE_ADDRESS ${envSafe} is not owned by ${ownerAddress}`);
    }
    return {
      safeAddress: envSafe,
      safe,
      singleton: "",
      factory: "",
      saltNonce: 0n,
      source: "env" as const,
    };
  }

  const infrastructure = await getOrDeploySafeInfrastructure(hre);
  const deployed = await deploySafeWallet(hre, [ownerAddress], 1, saltNonce);
  return { ...deployed, source: infrastructure.source };
}

export async function execSafeErc20Approve(
  safeAddress: string,
  ownerSigner: any,
  tokenAddress: string,
  spenderAddress: string,
  amount: bigint
) {
  const data = encodeContractCall(new Interface([...ERC20_ABI]), "approve", [spenderAddress, amount]);
  return execSafeTransaction(safeAddress, ownerSigner, { to: tokenAddress, data });
}

export async function execSafeShield(
  safeAddress: string,
  ownerSigner: any,
  privateTokenAddress: string,
  amount: bigint
) {
  const data = encodeContractCall(new Interface([...PRIVATE_ERC20_ABI]), "shield", [amount]);
  return execSafeTransaction(safeAddress, ownerSigner, { to: privateTokenAddress, data });
}

export async function execSafeClearTransfer(
  safeAddress: string,
  ownerSigner: any,
  privateTokenAddress: string,
  recipientAddress: string,
  amount: bigint
) {
  const clearTransferIface = new Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
  const data = clearTransferIface.encodeFunctionData("transfer", [recipientAddress, amount]);
  return execSafeTransaction(safeAddress, ownerSigner, { to: privateTokenAddress, data });
}

export async function execSafeEncryptedTransfer(
  safeAddress: string,
  ownerSigner: any,
  privateTokenAddress: string,
  recipientAddress: string,
  itPayload: {
    userAddress: string;
    ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint };
  }
) {
  const data = encodeContractCall(new Interface([...PRIVATE_ERC20_TRANSFER_ABI]), "transfer", [
    recipientAddress,
    itPayload,
  ]);
  return execSafeTransaction(safeAddress, ownerSigner, { to: privateTokenAddress, data });
}

/** Safe grants the owner GCACL view on a specific balance handle. */
export async function execSafePermitHandleView(
  hre: HardhatRuntimeEnvironment,
  safeAddress: string,
  ownerSigner: any,
  viewerAddress: string,
  handle: bigint
) {
  const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
  const gcAclAddress = getGcAclAddress(chainId);
  const data = encodeContractCall(new Interface([...GCACL_ABI]), "permit", [handle, viewerAddress]);
  return execSafeTransaction(safeAddress, ownerSigner, { to: gcAclAddress, data });
}

export async function mintUnderlyingToSafe(
  mockToken: { mint: (to: string, amount: bigint) => Promise<{ wait: () => Promise<unknown> }> },
  safeAddress: string,
  amount: bigint
) {
  await (await mockToken.mint(safeAddress, amount)).wait();
}

/** Safe grants the owner GCACL view on multiple handles (OPRF x/y/q, etc.). */
export async function execSafePermitHandleViews(
  hre: HardhatRuntimeEnvironment,
  safeAddress: string,
  ownerSigner: any,
  viewerAddress: string,
  handles: bigint[]
) {
  for (const handle of handles) {
    if (handle === 0n) continue;
    await execSafePermitHandleView(hre, safeAddress, ownerSigner, viewerAddress, handle);
  }
}

export async function execSafeMintOprfToken(
  safeAddress: string,
  ownerSigner: any,
  privateTokenAddress: string,
  quantityIt: ItUint256Payload
) {
  const data = encodeContractCall(new Interface([...PRIVATE_ERC20_OPRF_ABI]), "mintOPRFToken", [quantityIt]);
  return execSafeTransaction(safeAddress, ownerSigner, { to: privateTokenAddress, data });
}

export async function execSafeSplitTokenForRecipient(
  safeAddress: string,
  ownerSigner: any,
  privateTokenAddress: string,
  params: {
    xIt: ItUint128Payload;
    qIt: ItUint256Payload;
    yClear: bigint;
    qSplitIt: ItUint256Payload;
    recipient: string;
  }
) {
  const data = encodeContractCall(new Interface([...PRIVATE_ERC20_OPRF_ABI]), "splitTokenForRecipient", [
    params.xIt,
    params.qIt,
    params.yClear,
    params.qSplitIt,
    params.recipient,
  ]);
  return execSafeTransaction(safeAddress, ownerSigner, { to: privateTokenAddress, data });
}

export async function execSafeBurnToken(
  safeAddress: string,
  ownerSigner: any,
  privateTokenAddress: string,
  params: {
    xIt: ItUint128Payload;
    qIt: ItUint256Payload;
    yClear: bigint;
    recipient: string;
  }
) {
  const data = encodeContractCall(new Interface([...PRIVATE_ERC20_OPRF_ABI]), "burnToken", [
    params.xIt,
    params.qIt,
    params.yClear,
    params.recipient,
  ]);
  return execSafeTransaction(safeAddress, ownerSigner, { to: privateTokenAddress, data });
}

export async function execSafeRedeemMany(
  safeAddress: string,
  ownerSigner: any,
  privateTokenAddress: string,
  params: {
    tokens: Array<{ xIt: ItUint128Payload; qIt: ItUint256Payload; yClear: bigint }>;
    amountIt: ItUint256Payload;
    recipient: string;
  }
) {
  const data = encodeContractCall(new Interface([...PRIVATE_ERC20_OPRF_ABI]), "redeemMany", [
    params.tokens.map((token) => [token.xIt, token.qIt, token.yClear]),
    params.amountIt,
    params.recipient,
  ]);
  return execSafeTransaction(safeAddress, ownerSigner, { to: privateTokenAddress, data });
}
