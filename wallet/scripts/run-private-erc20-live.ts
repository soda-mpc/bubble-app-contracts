/**
 * End-to-end demo against a live Bubble network.
 *
 * Deploys a private ERC20, shields underlying tokens into it, transfers an amount that never
 * appears in calldata, and reads both balances back — each decrypted only by its owner, using
 * that owner's own AES key.
 *
 * Accounts are derived from MNEMONIC (indexes 1 and 2), not generated randomly, so any gas left
 * on them stays recoverable.
 *
 *   MNEMONIC="..." npx hardhat run scripts/run-private-erc20-live.ts --network sepolia
 *
 * Optional: AMOUNT (default 1000), PROXY_URL, <NETWORK>_RPC_URL to override the endpoint.
 *
 * No Bubble core contracts are deployed. MpcCore resolves the ones Soda Labs operates for the
 * connected chain via block.chainid, so the same script works on every supported network.
 */
import hre from "hardhat";
import { HDNodeWallet } from "ethers";

import { getUserKeyViaProxy, prepareMessageForBubble256 } from "../test/helpers/bubbleCryptoTransport";
import {
  delay,
  DELAY_MPC_PROCESSING_MS,
  DELAY_STANDARD_MS,
  deployMockToken,
  deployPrivateToken,
  fundWalletsForGas,
  getPrivateTokenBalance,
  mintApproveAndShield,
  supportedBubbleChainIds,
} from "../test/helpers/testHelpers";

const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const AMOUNT = BigInt(process.env.AMOUNT || 1000);

async function main() {
  if (!process.env.MNEMONIC) {
    throw new Error("Set MNEMONIC to a funded account on the target network");
  }

  const { chainId } = await hre.ethers.provider.getNetwork();
  if (!supportedBubbleChainIds().includes(Number(chainId))) {
    throw new Error(
      `chain ${chainId} has no Bubble deployment — use --network sepolia, sepolia-arbitrum, ` +
      `ethereum, arbitrum or polygon`
    );
  }

  const [signer] = await hre.ethers.getSigners();
  console.log(`chain ${chainId} — deployer ${await signer.getAddress()}`);

  // 1) Onboard: exchange an RSA public key for the AES user key, reassembled locally.
  const aesKey = await getUserKeyViaProxy(signer as any, PROXY_URL);
  console.log("onboarded — AES user key acquired");

  // 2) Recipient and master, derived from MNEMONIC so their keys stay recoverable.
  //    Only the recipient needs gas: it onboards and reads its own balance. `master` is used
  //    for its address alone, so funding it would be pure loss.
  const root = hre.ethers.Wallet.fromPhrase(process.env.MNEMONIC);
  const recipient = root.deriveChild(1).connect(hre.ethers.provider);
  const master = root.deriveChild(2);
  await fundWalletsForGas({
    sender: signer as any,
    recipients: [recipient.address],
    amountWei: hre.ethers.parseEther("0.005"),
  });

  // 3) Deploy the underlying ERC20 and the private token in front of it.
  const mockToken = await deployMockToken(hre, signer);
  await delay(DELAY_STANDARD_MS);
  const privateToken = await deployPrivateToken(hre, signer, {
    underlyingAddress: await mockToken.getAddress(),
    ownerAddress: await signer.getAddress(),
    masterAddress: master.address,
  });
  const privateTokenAddress = await privateToken.getAddress();
  console.log(`deployed private token at ${privateTokenAddress}`);

  // 4) Shield underlying into the private token — the balance becomes an encrypted handle.
  await mintApproveAndShield({
    mockToken: mockToken as any,
    privateToken: privateToken as any,
    recipient: await signer.getAddress(),
    amount: AMOUNT * 10n,
  });
  await delay(DELAY_MPC_PROCESSING_MS);

  const read = (address: string, asSigner: any, key: Buffer) =>
    getPrivateTokenBalance({
      privateToken: privateToken as any,
      address,
      signer: asSigner,
      aesKey: key,
      proxyUrl: PROXY_URL,
    });

  // The recipient needs its own AES key to read its own balance — that is the point of the demo.
  const recipientAesKey = await getUserKeyViaProxy(recipient as any, PROXY_URL);

  const before = await read(await signer.getAddress(), signer, aesKey);
  console.log(`balance before: ${before}`);

  // 5) Encrypt the amount client-side, then transfer. The value never enters calldata —
  //    only two ciphertext words do.
  const { encryptedHigh, encryptedLow } = prepareMessageForBubble256(
    AMOUNT,
    await signer.getAddress(),
    aesKey.toString("hex"),
    privateTokenAddress
  );
  const tx = await privateToken["transfer(address,(address,(uint256,uint256)))"](recipient.address, {
    userAddress: await signer.getAddress(),
    ciphertext: { ciphertextHigh: encryptedHigh, ciphertextLow: encryptedLow },
  });
  await tx.wait();
  console.log(`transferred ${AMOUNT} to ${recipient.address} — amount encrypted, not in calldata`);
  await delay(DELAY_MPC_PROCESSING_MS);

  const after = await read(await signer.getAddress(), signer, aesKey);
  const recipientBalance = await read(recipient.address, recipient, recipientAesKey);
  console.log(`balance after:  ${after}`);
  console.log(`recipient balance: ${recipientBalance} (decrypted with the recipient\u2019s own key)`);

  if (before - after !== AMOUNT) {
    throw new Error(`sender balance moved by ${before - after}, expected ${AMOUNT}`);
  }
  if (recipientBalance !== AMOUNT) {
    throw new Error(`recipient balance is ${recipientBalance}, expected ${AMOUNT}`);
  }
  console.log("OK");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
