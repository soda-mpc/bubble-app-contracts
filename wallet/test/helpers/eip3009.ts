import { randomBytes } from "crypto";
import type { Signer } from "ethers";

export const EIP3009_TRANSFER_TYPES = {
  TransferWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

export type SignedEIP3009Authorization = {
  from: string;
  to: string;
  value: string;
  validAfter: string;
  validBefore: string;
  nonce: string;
  v: number;
  r: string;
  s: string;
};

/** Sign EIP-3009 TransferWithAuthorization for the facilitator / MockEIP3009Token domain. */
export async function signEip3009TransferWithAuthorization(params: {
  signer: Signer;
  token: string;
  tokenName: string;
  tokenVersion?: string;
  chainId: number;
  from: string;
  to: string;
  value: bigint;
  validAfter?: bigint;
  validBefore: bigint;
  nonce?: string;
}): Promise<SignedEIP3009Authorization> {
  const from = params.from.toLowerCase();
  const to = params.to.toLowerCase();
  const validAfter = params.validAfter ?? 0n;
  const nonce = params.nonce ?? ("0x" + randomBytes(32).toString("hex"));

  const domain = {
    name: params.tokenName,
    version: params.tokenVersion ?? "1",
    chainId: params.chainId,
    verifyingContract: params.token,
  };

  const message = {
    from,
    to,
    value: params.value,
    validAfter,
    validBefore: params.validBefore,
    nonce,
  };

  const signature = await params.signer.signTypedData(domain, EIP3009_TRANSFER_TYPES, message);
  const r = "0x" + signature.slice(2, 66);
  const s = "0x" + signature.slice(66, 130);
  let v = parseInt(signature.slice(130, 132), 16);
  if (v < 27) {
    v += 27;
  }

  return {
    from,
    to,
    value: params.value.toString(),
    validAfter: validAfter.toString(),
    validBefore: params.validBefore.toString(),
    nonce,
    v,
    r,
    s,
  };
}
