/**
 * Native unwrap on redeemManyToUnderlying(..., unwrap = true), on a Bubble network (not Hardhat 31337).
 *
 * The underlying is a wrapped-native mock. With a plain `call` withdraw the recipient gets native token; with a
 * WETH9-style withdraw (2300-gas `transfer`, which cannot reach the token proxy), or a recipient that burns all the
 * gas it is given, the token falls back to paying the wrapped token. No case may fail or park the payout.
 *
 * Run: npx hardhat test test/PrivateERC20GaslessNativeUnwrap.test.ts --network sepolia-arbitrum
 */
import { expect } from "chai";
import hre from "hardhat";
import { Wallet } from "ethers";
import dotenv from "dotenv";

import { decryptMultipleValuesViaProxy, getUserKeyViaProxy } from "./helpers/bubbleCryptoTransport";
import {
  buildUnsignedItUint128,
  buildUnsignedItUint256,
  DELAY_MPC_EXTENDED_MS,
  DELAY_MPC_REDEEM_MS,
  delay,
  deployPrivateTokenGasless,
  getOprfMintedHandlesFromReceipt,
  waitForUnshieldOutcome,
} from "./helpers/testHelpers";

dotenv.config();

const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
// Small amounts: the wrapped token is backed by the test account's own native balance.
const NOTE_AMOUNT = 3n * 10n ** 12n;
const PAY_AMOUNT = 10n ** 12n;

function shouldSkip(): boolean {
  return (
    !process.env.MNEMONIC ||
    (!process.env.SEPOLIA_ARBITRUM_RPC_URL && !process.env.ALCHEMY_API_KEY)
  );
}

describe("PrivateERC20Contract256Gasless native unwrap", function () {
  this.timeout(900000);

  let owner: any;
  let ownerAesKey: Buffer;
  let ownerAesKeyHex: string;

  before(async function () {
    const network = await hre.ethers.provider.getNetwork();
    if (network.chainId === 31337n || shouldSkip()) {
      this.skip();
    }
    [owner] = await hre.ethers.getSigners();
    ownerAesKey = await getUserKeyViaProxy(owner, PROXY_URL);
    ownerAesKeyHex = ownerAesKey.toString("hex");
  });

  /** Mints a note for NOTE_AMOUNT of wrapped native and redeems PAY_AMOUNT of it with unwrap (to a fresh EOA by default). */
  async function redeemWithUnwrap(stipendOnly: boolean, recipient: string = Wallet.createRandom().address) {
    const wrapped: any = await hre.ethers.deployContract("WrappedNativeMock", [stipendOnly], owner);
    await wrapped.waitForDeployment();
    const privateToken = await deployPrivateTokenGasless(hre, owner, {
      underlyingAddress: await wrapped.getAddress(),
      ownerAddress: owner.address,
      masterAddress: owner.address,
      name: stipendOnly ? "Unwrap WETH9" : "Unwrap Call",
      symbol: "gWNM",
      underlyingIsWrappedNative: true,
    });
    const tokenAddress = await privateToken.getAddress();
    await (await wrapped.connect(owner).deposit({ value: NOTE_AMOUNT })).wait();
    await (await wrapped.connect(owner).approve(tokenAddress, NOTE_AMOUNT)).wait();

    const mintReceipt = await (await privateToken.connect(owner)["shieldAndMint(uint256)"](NOTE_AMOUNT)).wait();
    await delay(DELAY_MPC_EXTENDED_MS);
    const handles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
    expect(handles, "OPRFMinted").to.not.equal(undefined);
    const [x, y, q] = await decryptMultipleValuesViaProxy(
      [handles!.xHandle, handles!.yHandle, handles!.qHandle],
      owner,
      ownerAesKey,
      PROXY_URL
    );
    const ownerIt = (value: bigint) =>
      buildUnsignedItUint256({ value, userAddress: owner.address, userAesKeyHex: ownerAesKeyHex, contractAddress: tokenAddress });
    const note = {
      x: buildUnsignedItUint128({ value: x, userAddress: owner.address, userAesKeyHex: ownerAesKeyHex, contractAddress: tokenAddress }),
      q: ownerIt(q),
      y_clear: y,
    };

    const startBlock = await hre.ethers.provider.getBlockNumber();
    await (
      await privateToken.connect(owner).redeemManyToUnderlying([note], ownerIt(PAY_AMOUNT), recipient, true)
    ).wait();
    const outcome = await waitForUnshieldOutcome(privateToken, hre, startBlock, {
      timeoutMs: DELAY_MPC_REDEEM_MS * 6,
      pollIntervalMs: 3000,
    });
    expect(outcome.failedEvents.length, "unshield failed").to.equal(0);
    expect(outcome.parkedEvents.length, "unshield payout parked").to.equal(0);
    expect(outcome.successEvents.length, "unshield paid").to.be.greaterThan(0);
    return {
      native: await hre.ethers.provider.getBalance(recipient),
      wrapped: (await wrapped.balanceOf(recipient)) as bigint,
    };
  }

  it("pays native token when the wrapped token's withdraw uses a plain call", async function () {
    const paid = await redeemWithUnwrap(false);
    expect(paid.native).to.equal(PAY_AMOUNT);
    expect(paid.wrapped).to.equal(0n);
  });

  it("falls back to the wrapped token when withdraw only forwards a 2300-gas stipend (WETH9)", async function () {
    const paid = await redeemWithUnwrap(true);
    expect(paid.native).to.equal(0n);
    expect(paid.wrapped).to.equal(PAY_AMOUNT);
  });

  it("falls back to the wrapped token when the recipient burns all the gas it is given", async function () {
    const burner: any = await hre.ethers.deployContract("GasBurningReceiver", [], owner);
    await burner.waitForDeployment();
    const paid = await redeemWithUnwrap(false, await burner.getAddress());
    expect(paid.native).to.equal(0n);
    expect(paid.wrapped).to.equal(PAY_AMOUNT);
  });
});
