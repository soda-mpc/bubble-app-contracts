/**
 * End-to-end vault deposit from a fresh account, without the gasless relay.
 *
 *   npm run test:vault-e2e:arbitrum-sepolia
 *
 * The treasury shields USDC and hands the pUSDC note off-chain. The fresh account
 * redeems that note, then calls VaultDepositBatcher once. A USDC permit is signed
 * off-chain and submitted inside that call, so there is no approve transaction.
 * The test records that account's transactions and signatures.
 *
 * Ciphertexts are unsigned. A direct caller (tx.origin is the note owner) does
 * not sign them. The unshield callback is submitted by the decryption network,
 * not by the fresh account.
 */
import { expect } from "chai";
import hre from "hardhat";
import { Wallet } from "ethers";
import dotenv from "dotenv";

import {
  decryptMultipleValuesViaProxy,
  getUserKeyViaProxy,
} from "./helpers/bubbleCryptoTransport";
import {
  buildUnsignedItUint128,
  buildUnsignedItUint256,
  DELAY_BALANCE_SYNC_MS,
  DELAY_MPC_EXTENDED_MS,
  DELAY_MPC_REDEEM_MS,
  delay,
  deployPrivateToken,
  getOprfMintedHandlesFromReceipt,
  waitForUnshieldOutcome,
} from "./helpers/testHelpers";

dotenv.config();

const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const DEPOSIT_ASSETS = 1_000n * 10n ** 18n;

function shouldSkip(): boolean {
  return (
    !process.env.MNEMONIC ||
    (!process.env.QUICKNODE_ARBITRUM_SEPOLIA_URL &&
      !process.env.ALCHEMY_API_KEY &&
      !process.env.KURTOSIS)
  );
}

function instrumentFreshAccount(wallet: Wallet) {
  const transactions: string[] = [];
  const offchainSignatures: string[] = [];
  let txLabel = "unlabeled transaction";
  let signLabel = "unlabeled personal_sign";
  const sendTransaction = wallet.sendTransaction.bind(wallet);
  const signMessage = wallet.signMessage.bind(wallet);
  const signTypedData = wallet.signTypedData.bind(wallet);

  wallet.sendTransaction = (async (tx: Parameters<Wallet["sendTransaction"]>[0]) => {
    transactions.push(txLabel);
    txLabel = "unlabeled transaction";
    return sendTransaction(tx);
  }) as Wallet["sendTransaction"];

  wallet.signMessage = (async (message: string | Uint8Array) => {
    offchainSignatures.push(signLabel);
    signLabel = "unlabeled personal_sign";
    return signMessage(message);
  }) as Wallet["signMessage"];

  wallet.signTypedData = (async (...args: Parameters<Wallet["signTypedData"]>) => {
    offchainSignatures.push(signLabel);
    signLabel = "unlabeled personal_sign";
    return signTypedData(...args);
  }) as Wallet["signTypedData"];

  return {
    wallet,
    transactions,
    offchainSignatures,
    nextTx(label: string) {
      txLabel = label;
    },
    nextSign(label: string) {
      signLabel = label;
    },
  };
}

describe("Fresh account vault deposit e2e", function () {
  this.timeout(900000);

  let treasury: any;
  let treasuryAddress: string;
  let treasuryAesKey: Buffer;
  let treasuryAesKeyHex: string;
  let asset: any;
  let vault: any;
  let batcher: any;
  let pUsdc: any;
  let pShare: any;

  before(async function () {
    const network = await hre.ethers.provider.getNetwork();
    if (network.chainId === 31337n || shouldSkip()) {
      this.skip();
    }

    [treasury] = await hre.ethers.getSigners();
    treasuryAddress = await treasury.getAddress();
    treasuryAesKey = await getUserKeyViaProxy(treasury, PROXY_URL);
    treasuryAesKeyHex = treasuryAesKey.toString("hex");

    const AssetFactory = await hre.ethers.getContractFactory("MockPermitERC20", treasury);
    asset = await AssetFactory.deploy("Mock USDC", "mUSDC");
    await asset.waitForDeployment();
    const VaultFactory = await hre.ethers.getContractFactory("MockStaticVault", treasury);
    vault = await VaultFactory.deploy(await asset.getAddress(), "Mock static aUSDC", "maUSDC");
    await vault.waitForDeployment();
    const BatcherFactory = await hre.ethers.getContractFactory("VaultDepositBatcher", treasury);
    batcher = await BatcherFactory.deploy();
    await batcher.waitForDeployment();

    pUsdc = await deployPrivateToken(hre, treasury, {
      underlyingAddress: await asset.getAddress(),
      ownerAddress: treasuryAddress,
      masterAddress: treasuryAddress,
      name: "Private USDC",
      symbol: "pUSDC",
    });
    pShare = await deployPrivateToken(hre, treasury, {
      underlyingAddress: await vault.getAddress(),
      ownerAddress: treasuryAddress,
      masterAddress: treasuryAddress,
      name: "Private vault shares",
      symbol: "pShare",
    });
  });

  it("counts transactions and signatures from the fresh account", async function () {
    const pUsdcAddress = await pUsdc.getAddress();
    await (await asset.mint(treasuryAddress, DEPOSIT_ASSETS)).wait();
    await (await asset.approve(pUsdcAddress, DEPOSIT_ASSETS)).wait();
    await (await pUsdc.shield(DEPOSIT_ASSETS)).wait();
    await delay(DELAY_BALANCE_SYNC_MS);

    const quantityIt = buildUnsignedItUint256({
      value: DEPOSIT_ASSETS,
      userAddress: treasuryAddress,
      userAesKeyHex: treasuryAesKeyHex,
      contractAddress: pUsdcAddress,
    });
    const mintReceipt = await (await pUsdc.mintOPRFToken(quantityIt)).wait();
    expect(mintReceipt?.status).to.equal(1);
    await delay(DELAY_MPC_EXTENDED_MS);

    const minted = getOprfMintedHandlesFromReceipt(mintReceipt, pUsdc);
    expect(minted).to.not.be.undefined;
    const [noteX, noteY, noteQ] = await decryptMultipleValuesViaProxy(
      [minted!.xHandle, minted!.yHandle, minted!.qHandle],
      treasury,
      treasuryAesKey,
      PROXY_URL
    );
    expect(noteQ).to.equal(DEPOSIT_ASSETS);

    const fresh = instrumentFreshAccount(Wallet.createRandom().connect(hre.ethers.provider));
    const freshAddress = await freshWalletAddress(fresh);
    await (
      await treasury.sendTransaction({
        to: freshAddress,
        value: hre.ethers.parseEther("0.01"),
      })
    ).wait();

    fresh.nextSign("onboard");
    const freshAesKey = await getUserKeyViaProxy(fresh.wallet as Wallet, PROXY_URL);
    const freshAesKeyHex = freshAesKey.toString("hex");

    const noteInput = [
      {
        x: buildUnsignedItUint128({
          value: noteX,
          userAddress: freshAddress,
          userAesKeyHex: freshAesKeyHex,
          contractAddress: pUsdcAddress,
        }),
        q: buildUnsignedItUint256({
          value: noteQ,
          userAddress: freshAddress,
          userAesKeyHex: freshAesKeyHex,
          contractAddress: pUsdcAddress,
        }),
        y_clear: noteY,
      },
    ];
    const redeemAmount = buildUnsignedItUint256({
      value: DEPOSIT_ASSETS,
      userAddress: freshAddress,
      userAesKeyHex: freshAesKeyHex,
      contractAddress: pUsdcAddress,
    });

    const pUsdcAsFresh = pUsdc.connect(fresh.wallet);

    const startBlock = await hre.ethers.provider.getBlockNumber();
    fresh.nextTx("pUSDC.redeemManyToUnderlying");
    const redeemReceipt = await (
      await pUsdcAsFresh.redeemManyToUnderlying(noteInput, redeemAmount, freshAddress, false)
    ).wait();
    expect(redeemReceipt?.status).to.equal(1);

    await delay(DELAY_MPC_REDEEM_MS);
    const { successEvents, failedEvents } = await waitForUnshieldOutcome(pUsdc, hre, startBlock, {
      timeoutMs: 180000,
      pollIntervalMs: 3000,
    });
    expect(failedEvents.length).to.equal(0);
    expect(successEvents.length).to.be.greaterThan(0);
    expect(await asset.balanceOf(freshAddress)).to.equal(DEPOSIT_ASSETS);

    const batcherAddress = await batcher.getAddress();
    const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    fresh.nextSign("USDC permit");
    const permitSignature = await (fresh.wallet as Wallet).signTypedData(
      {
        name: "Mock USDC",
        version: "1",
        chainId,
        verifyingContract: await asset.getAddress(),
      },
      {
        Permit: [
          { name: "owner", type: "address" },
          { name: "spender", type: "address" },
          { name: "value", type: "uint256" },
          { name: "nonce", type: "uint256" },
          { name: "deadline", type: "uint256" },
        ],
      },
      {
        owner: freshAddress,
        spender: batcherAddress,
        value: DEPOSIT_ASSETS,
        nonce: await asset.nonces(freshAddress),
        deadline,
      }
    );
    const permitSig = hre.ethers.Signature.from(permitSignature);

    const batcherAsFresh = batcher.connect(fresh.wallet);
    fresh.nextTx("batcher.depositAndMint");
    const wrapReceipt = await (
      await batcherAsFresh.depositAndMint(await vault.getAddress(), await pShare.getAddress(), DEPOSIT_ASSETS, {
        deadline,
        v: permitSig.v,
        r: permitSig.r,
        s: permitSig.s,
      })
    ).wait();
    expect(wrapReceipt?.status).to.equal(1);
    expect(await asset.balanceOf(freshAddress)).to.equal(0n);
    expect(await vault.balanceOf(freshAddress)).to.equal(0n);
    expect(await vault.balanceOf(batcherAddress)).to.equal(0n);
    expect(await vault.balanceOf(await pShare.getAddress())).to.equal(DEPOSIT_ASSETS);

    const wrapped = getOprfMintedHandlesFromReceipt(wrapReceipt, pShare);
    expect(wrapped).to.not.be.undefined;
    await delay(DELAY_MPC_EXTENDED_MS);

    fresh.nextSign("decrypt pShare note");
    const [, , wrappedQ] = await decryptMultipleValuesViaProxy(
      [wrapped!.xHandle, wrapped!.yHandle, wrapped!.qHandle],
      fresh.wallet as Wallet,
      freshAesKey,
      PROXY_URL
    );
    expect(wrappedQ).to.equal(DEPOSIT_ASSETS);

    const onboardSignatures = fresh.offchainSignatures.filter((label) => label === "onboard");
    const perDepositSignatures = fresh.offchainSignatures.filter((label) => label !== "onboard");

    console.log("\nFresh account cost for one batched vault deposit (no gasless relay)");
    console.log(`  transactions: ${fresh.transactions.length}`);
    fresh.transactions.forEach((label, index) => console.log(`    ${index + 1}. ${label}`));
    console.log(`  transaction signatures: ${fresh.transactions.length}`);
    console.log(`  one-time personal_sign: ${onboardSignatures.length} (proxy onboard)`);
    console.log(`  signatures per deposit: ${perDepositSignatures.length}`);
    perDepositSignatures.forEach((label, index) => console.log(`    ${index + 1}. ${label}`));
    console.log("  ciphertext signatures: 0");

    expect(fresh.transactions).to.deep.equal([
      "pUSDC.redeemManyToUnderlying",
      "batcher.depositAndMint",
    ]);
    expect(onboardSignatures).to.deep.equal(["onboard"]);
    expect(perDepositSignatures).to.deep.equal(["USDC permit", "decrypt pShare note"]);
    expect(fresh.offchainSignatures.some((label) => label.startsWith("unlabeled"))).to.equal(false);
    expect(fresh.transactions.some((label) => label.startsWith("unlabeled"))).to.equal(false);
  });
});

function freshWalletAddress(instrumented: { wallet: Wallet }): Promise<string> {
  return instrumented.wallet.getAddress();
}
