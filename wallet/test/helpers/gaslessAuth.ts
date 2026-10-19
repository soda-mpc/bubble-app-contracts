import { randomBytes } from "crypto";
import type { Signer } from "ethers";

export const EXECUTE_WITH_AUTHORIZATION_TYPES = {
  ExecuteWithAuthorization: [
    { name: "from", type: "address" },
    { name: "data", type: "bytes" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
};

export async function signExecuteWithAuthorization(params: {
  signer: Signer;
  /** EIP-712 verifyingContract: the forwarder, not the token. */
  forwarder: string;
  tokenName: string;
  tokenVersion?: string;
  chainId: number;
  from: string;
  data: string;
  validAfter?: bigint;
  validBefore: bigint;
  nonce?: string;
}): Promise<{
  from: string;
  data: string;
  validAfter: bigint;
  validBefore: bigint;
  nonce: string;
  signature: string;
}> {
  const from = params.from;
  const validAfter = params.validAfter ?? 0n;
  const nonce = params.nonce ?? ("0x" + randomBytes(32).toString("hex"));
  const domain = {
    name: params.tokenName,
    version: params.tokenVersion ?? "1",
    chainId: params.chainId,
    verifyingContract: params.forwarder,
  };
  const message = {
    from,
    data: params.data,
    validAfter,
    validBefore: params.validBefore,
    nonce,
  };
  const signature = await params.signer.signTypedData(
    domain,
    EXECUTE_WITH_AUTHORIZATION_TYPES,
    message
  );
  return {
    from,
    data: params.data,
    validAfter,
    validBefore: params.validBefore,
    nonce,
    signature,
  };
}

export const CANCEL_AUTHORIZATION_TYPES = {
  CancelAuthorization: [
    { name: "authorizer", type: "address" },
    { name: "nonce", type: "bytes32" },
  ],
};

/** EIP-712 cancel for PrivateERC20GaslessForwarder. `verifyingContract` is the forwarder. */
export async function signCancelAuthorization(params: {
  signer: Signer;
  forwarder: string;
  tokenName: string;
  chainId: number;
  authorizer: string;
  nonce: string;
}): Promise<string> {
  return params.signer.signTypedData(
    {
      name: params.tokenName,
      version: "1",
      chainId: params.chainId,
      verifyingContract: params.forwarder,
    },
    CANCEL_AUTHORIZATION_TYPES,
    { authorizer: params.authorizer, nonce: params.nonce }
  );
}
