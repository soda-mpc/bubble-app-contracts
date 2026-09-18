import { Interface, getAddress } from "ethers";
import { decryptItUint256 } from "./bubbleCryptoTransport";

const SHIELD_IFACE = new Interface(["function shield(uint256 amount) returns (bool)"]);
const CLEAR_TRANSFER_IFACE = new Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
const ERC20_APPROVE_IFACE = new Interface([
  "function approve(address spender, uint256 amount) returns (bool)",
]);
const ENCRYPTED_TRANSFER_IFACE = new Interface([
  "function transfer(address to, tuple(address userAddress, tuple(uint256 ciphertextHigh, uint256 ciphertextLow) ciphertext) it) returns (bool)",
]);
const PERMIT_CONTRACT_VIEW_IFACE = new Interface([
  "function permitContractViewAccess(address permittee, address contractAddress, uint64 expirationDate)",
]);

function aesKeyBuffer(aesKey: Buffer | string): Buffer {
  return typeof aesKey === "string" ? Buffer.from(aesKey, "hex") : aesKey;
}

export function encodeApprove(spender: string, amount: bigint): string {
  return ERC20_APPROVE_IFACE.encodeFunctionData("approve", [spender, amount]);
}

export function encodeShield(amount: bigint): string {
  return SHIELD_IFACE.encodeFunctionData("shield", [amount]);
}

export function encodeEncryptedTransfer(
  recipient: string,
  it: { userAddress: string; ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint } }
): string {
  return ENCRYPTED_TRANSFER_IFACE.encodeFunctionData("transfer", [recipient, it]);
}

export function encodePermitContractView(
  viewer: string,
  token: string,
  expiration: bigint
): string {
  return PERMIT_CONTRACT_VIEW_IFACE.encodeFunctionData("permitContractViewAccess", [
    viewer,
    token,
    expiration,
  ]);
}

export function assertInformedApprove(
  data: string,
  expectedSpender: string,
  expectedAmount: bigint
): { spender: string; amount: bigint } {
  const [spender, amount] = ERC20_APPROVE_IFACE.decodeFunctionData("approve", data);
  const decodedSpender = getAddress(spender);
  const decodedAmount = BigInt(amount);
  if (decodedSpender !== getAddress(expectedSpender)) {
    throw new Error(`Signer refuses: approve spender ${decodedSpender} != claimed ${expectedSpender}`);
  }
  if (decodedAmount !== expectedAmount) {
    throw new Error(`Signer refuses: approve amount ${decodedAmount} != claimed ${expectedAmount}`);
  }
  return { spender: decodedSpender, amount: decodedAmount };
}

export function assertInformedShield(data: string, expectedAmount: bigint): bigint {
  const [amount] = SHIELD_IFACE.decodeFunctionData("shield", data);
  const decoded = BigInt(amount);
  if (decoded !== expectedAmount) {
    throw new Error(`Signer refuses: shield amount ${decoded} != claimed ${expectedAmount}`);
  }
  return decoded;
}

export function assertInformedClearTransfer(
  data: string,
  expectedRecipient: string,
  expectedAmount: bigint
): { recipient: string; amount: bigint } {
  const [to, amount] = CLEAR_TRANSFER_IFACE.decodeFunctionData("transfer", data);
  const recipient = getAddress(to);
  const decodedAmount = BigInt(amount);
  if (recipient !== getAddress(expectedRecipient)) {
    throw new Error(`Signer refuses: clear transfer to ${recipient} != claimed ${expectedRecipient}`);
  }
  if (decodedAmount !== expectedAmount) {
    throw new Error(`Signer refuses: clear transfer amount ${decodedAmount} != claimed ${expectedAmount}`);
  }
  return { recipient, amount: decodedAmount };
}

export function openItUint256(
  aesKey: Buffer | string,
  it: { userAddress: string; ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint } }
): bigint {
  return decryptItUint256(aesKeyBuffer(aesKey), it.ciphertext.ciphertextHigh, it.ciphertext.ciphertextLow);
}

/**
 * Co-signer inspects encrypted transfer calldata: decrypt the IT with the shared AES key
 * and check recipient / userAddress / amount against the claimed intent.
 */
export function assertInformedEncryptedTransfer(params: {
  data: string;
  sharedAesKey: Buffer | string;
  expectedRecipient: string;
  expectedAmount: bigint;
  expectedUserAddress: string;
}): { recipient: string; userAddress: string; amount: bigint } {
  const { data, sharedAesKey, expectedRecipient, expectedAmount, expectedUserAddress } = params;
  const [to, it] = ENCRYPTED_TRANSFER_IFACE.decodeFunctionData("transfer", data);
  const recipient = getAddress(to);
  const userAddress = getAddress(it.userAddress);
  const amount = openItUint256(sharedAesKey, {
    userAddress,
    ciphertext: {
      ciphertextHigh: BigInt(it.ciphertext.ciphertextHigh),
      ciphertextLow: BigInt(it.ciphertext.ciphertextLow),
    },
  });

  if (recipient !== getAddress(expectedRecipient)) {
    throw new Error(`Signer refuses: encrypted transfer to ${recipient} != claimed ${expectedRecipient}`);
  }
  if (userAddress !== getAddress(expectedUserAddress)) {
    throw new Error(`Signer refuses: IT userAddress ${userAddress} != claimed ${expectedUserAddress}`);
  }
  if (amount !== expectedAmount) {
    throw new Error(`Signer refuses: IT amount ${amount} != claimed ${expectedAmount}`);
  }
  return { recipient, userAddress, amount };
}

export function assertInformedPermitContractView(
  data: string,
  expectedViewer: string,
  expectedToken: string
): { viewer: string; token: string; expiration: bigint } {
  const [permittee, contractAddress, expirationDate] = PERMIT_CONTRACT_VIEW_IFACE.decodeFunctionData(
    "permitContractViewAccess",
    data
  );
  const viewer = getAddress(permittee);
  const token = getAddress(contractAddress);
  if (viewer !== getAddress(expectedViewer)) {
    throw new Error(`Signer refuses: view grant to ${viewer} != claimed ${expectedViewer}`);
  }
  if (token !== getAddress(expectedToken)) {
    throw new Error(`Signer refuses: view grant token ${token} != claimed ${expectedToken}`);
  }
  return { viewer, token, expiration: BigInt(expirationDate) };
}
