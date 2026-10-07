/**
 * shieldAndMint against a mock static vault on a Bubble network (not Hardhat 31337).
 *
 *   npm run test:shield-and-mint:arbitrum-sepolia
 *
 * Deposits mock USDC into MockStaticVault, then wraps the clear share amount into an OPRF note
 * without an encrypted quantity. Burns the note to confirm the escrowed shares back the quantity.
 */
import { expect } from "chai";
import hre from "hardhat";
import dotenv from "dotenv";

import {
  decryptMultipleValuesViaProxy,
  decryptValueViaProxy,
  getUserKeyViaProxy,
} from "./helpers/bubbleCryptoTransport";
import {
  buildSignedItUint128,
  buildSignedItUint256,
  DELAY_BALANCE_SYNC_MS,
  DELAY_MPC_EXTENDED_MS,
  DELAY_SHORT_MS,
  delay,
  deployMockToken,
  deployPrivateToken,
  findParsedLogInReceipt,
  getOprfMintedHandlesFromReceipt,
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

describe("PrivateERC20 shieldAndMint with mock vault", function () {
  this.timeout(600000);

  let signer: any;
  let userAddress: string;
  let userAesKey: Buffer;
  let userAesKeyHex: string;
  let asset: any;
  let vault: any;
  let privateToken: any;

  before(async function () {
    const network = await hre.ethers.provider.getNetwork();
    if (network.chainId === 31337n || shouldSkip()) {
      this.skip();
    }

    [signer] = await hre.ethers.getSigners();
    userAddress = await signer.getAddress();
    userAesKey = await getUserKeyViaProxy(signer, PROXY_URL);
    userAesKeyHex = userAesKey.toString("hex");

    asset = await deployMockToken(hre, signer, "Mock USDC", "mUSDC");
    const VaultFactory = await hre.ethers.getContractFactory("MockStaticVault", signer);
    vault = await VaultFactory.deploy(await asset.getAddress(), "Mock static aUSDC", "maUSDC");
    await vault.waitForDeployment();

    privateToken = await deployPrivateToken(hre, signer, {
      underlyingAddress: await vault.getAddress(),
      ownerAddress: userAddress,
      masterAddress: userAddress,
      name: "Private Mock aUSDC",
      symbol: "pmaUSDC",
    });
  });

  it("reverts when the clear amount is zero", async function () {
    await expect(privateToken.shieldAndMint(0)).to.be.revertedWith("Amount must be greater than 0");
  });

  it("mints a note for the clear share amount returned by the vault", async function () {
    await (await asset.mint(userAddress, DEPOSIT_ASSETS)).wait();
    await (await asset.approve(await vault.getAddress(), DEPOSIT_ASSETS)).wait();

    const depositTx = await vault.deposit(DEPOSIT_ASSETS, userAddress);
    const depositReceipt = await depositTx.wait();
    expect(depositReceipt?.status).to.equal(1);

    const shares = await vault.balanceOf(userAddress);
    expect(shares).to.equal(DEPOSIT_ASSETS);

    const tokenAddress = await privateToken.getAddress();
    await (await vault.approve(tokenAddress, shares)).wait();

    const supplyBefore = await privateToken.totalSupply();
    const tx = await privateToken.shieldAndMint(shares);
    const receipt = await tx.wait();
    expect(receipt?.status).to.equal(1);

    expect(await vault.balanceOf(userAddress)).to.equal(0n);
    expect(await vault.balanceOf(tokenAddress)).to.equal(shares);
    expect(await privateToken.totalSupply()).to.equal(supplyBefore + shares);

    const shieldEvent = findParsedLogInReceipt(receipt, privateToken, "Shield");
    expect(shieldEvent).to.not.be.undefined;
    const shieldDecoded = privateToken.interface.parseLog(shieldEvent!);
    expect(shieldDecoded?.args[0]).to.equal(userAddress);
    expect(shieldDecoded?.args[1]).to.equal(shares);

    const minted = getOprfMintedHandlesFromReceipt(receipt, privateToken);
    expect(minted).to.not.be.undefined;

    await delay(DELAY_MPC_EXTENDED_MS);

    const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
      [minted!.xHandle, minted!.yHandle, minted!.qHandle],
      signer,
      userAesKey,
      PROXY_URL
    );
    expect(decryptedX).to.not.equal(0n);
    expect(decryptedY).to.not.equal(0n);
    expect(decryptedQ).to.equal(shares);

    const xIT = await buildSignedItUint128({
      value: decryptedX,
      userAddress,
      userAesKeyHex,
      contractAddress: tokenAddress,
      signer,
    });
    const qIT = await buildSignedItUint256({
      value: decryptedQ,
      userAddress,
      userAesKeyHex,
      contractAddress: tokenAddress,
      signer,
    });

    const burnTx = await privateToken.burnToken(xIT, qIT, decryptedY, userAddress);
    const burnReceipt = await burnTx.wait();
    expect(burnReceipt?.status).to.equal(1);

    await delay(DELAY_BALANCE_SYNC_MS);
    const burnEvent = findParsedLogInReceipt(burnReceipt, privateToken, "OPRFBurned");
    expect(burnEvent).to.not.be.undefined;
    const burnDecoded = privateToken.interface.parseLog(burnEvent!);
    const burnedAmountHandle = burnDecoded?.args[2];

    await delay(DELAY_SHORT_MS);
    const decryptedBurned = await decryptValueViaProxy(burnedAmountHandle, signer, userAesKey, PROXY_URL);
    expect(decryptedBurned).to.equal(shares);

    const balanceHandle = await privateToken["balanceOf(address)"](userAddress);
    const decryptedBalance = await decryptValueViaProxy(balanceHandle, signer, userAesKey, PROXY_URL);
    expect(decryptedBalance).to.equal(shares);
  });
});
