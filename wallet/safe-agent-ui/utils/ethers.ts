import { BrowserProvider, JsonRpcSigner } from "ethers";
import type { WalletClient } from "viem";

/** Bridge wagmi WalletClient → ethers v6 Signer for Safe txs. */
export async function walletClientToSigner(walletClient: WalletClient): Promise<JsonRpcSigner> {
  const { account, chain, transport } = walletClient;
  if (!account) {
    throw new Error("Wallet client has no account");
  }
  if (!chain) {
    throw new Error("Wallet client has no chain");
  }
  const network = {
    chainId: chain.id,
    name: chain.name,
    ensAddress: chain.contracts?.ensRegistry?.address,
  };
  const provider = new BrowserProvider(transport, network);
  return provider.getSigner(account.address);
}
