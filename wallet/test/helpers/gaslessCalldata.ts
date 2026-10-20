import { Interface } from "ethers";

/** Calldata for the token entrypoints the gasless user-flow test signs and relays. */
const SHIELD_IFACE = new Interface(["function shield(uint256 amount) returns (bool)"]);
const ENCRYPTED_TRANSFER_IFACE = new Interface([
  "function transfer(address to, tuple(address userAddress, tuple(uint256 ciphertextHigh, uint256 ciphertextLow) ciphertext) it) returns (bool)",
]);

export function encodeShield(amount: bigint): string {
  return SHIELD_IFACE.encodeFunctionData("shield", [amount]);
}

export function encodeEncryptedTransfer(
  recipient: string,
  it: { userAddress: string; ciphertext: { ciphertextHigh: bigint; ciphertextLow: bigint } }
): string {
  return ENCRYPTED_TRANSFER_IFACE.encodeFunctionData("transfer", [recipient, it]);
}
