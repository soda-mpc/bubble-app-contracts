/**
 * Anonymous OPRF bearer notes: company Safe issues; agent cashes out via a facilitator.
 *
 * There must be no on-chain address edge from issuer (Safe) to user (agent):
 *   1. Safe mintOPRFToken — events mention only the Safe
 *   2. Off-chain handoff of plaintext (x, y, q) — not splitTokenForRecipient
 *   3. Agent encrypts ITs as userAddress=agent; facilitator submits redeem
 *      (tx.origin = facilitator, recipient/credit = agent, Safe absent)
 *
 * Insert ACL: GCHandler.ValidateCiphertext checks isFullInsertPermitted(userAddress, msg.sender).
 * msg.sender is the PrivateERC20 contract, not tx.origin (facilitator). The agent must call
 * GCACL.permitFullInsertAccess(privateTokenAddress, expiration).
 *
 * Run:
 *   cd wallet
 *   npm run test:safe:oprf-facilitator:arbitrum-sepolia
 */
import { expect } from "chai";
import hre from "hardhat";
import dotenv from "dotenv";

import {
  decryptMultipleValuesViaProxy,
  decryptValueViaProxy,
  getUserKeyViaProxy,
} from "../helpers/bubbleCryptoTransport";
import {
  execSafeErc20Approve,
  execSafeMintOprfToken,
  execSafePermitHandleViews,
  execSafeShield,
  mintUnderlyingToSafe,
  resolveSafeForTests,
} from "../helpers/safeBubbleHelpers";
import {
  buildUnsignedItUint128,
  buildUnsignedItUint256,
  createRandomWalletsAndFund,
  DELAY_BALANCE_SYNC_MS,
  DELAY_MPC_DECRYPTION_MS,
  DELAY_MPC_EXTENDED_MS,
  DELAY_MPC_REDEEM_MS,
  delay,
  deployMockToken,
  deployPrivateTokenGasless,
  expectDecryptViaProxyToFail,
  expectReverted,
  findParsedLogInReceipt,
  findParsedLogsInReceipt,
  collectEventAddressesFromReceipt,
  getGcAclContract,
  getOprfMintedEventsFromReceipt,
  getOprfMintedHandlesFromReceipt,
  waitForUnshieldOutcome,
} from "../helpers/testHelpers";

dotenv.config();

const ARBITRUM_SEPOLIA_CHAIN_ID = 421614n;
const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const NOTE_AMOUNT = 50n * 10n ** 18n;
const PAY_AMOUNT = 10n ** 17n; // 0.1
const INSERT_TTL_SECONDS = 365n * 24n * 60n * 60n;

function shouldSkipLiveSuite(): boolean {
  return (
    (!process.env.QUICKNODE_ARBITRUM_SEPOLIA_URL && !process.env.ALCHEMY_API_KEY) ||
    !process.env.MNEMONIC
  );
}

describe("Safe OPRF redeem via facilitator on Arbitrum Sepolia", function () {
  this.timeout(900000);

  let owner: any;
  let agent: any;
  let facilitator: any;
  let payTo: any;
  let master: any;
  let ownerAesKey: Buffer;
  let ownerAesKeyHex: string;
  let agentAesKey: Buffer;
  let agentAesKeyHex: string;
  let mockToken: any;
  let privateToken: any;
  let safeAddress: string;
  let mintReceipt: { status?: number | null; logs?: readonly unknown[] } | null;
  let decryptedX: bigint;
  let decryptedY: bigint;
  let decryptedQ: bigint;

  before(async function () {
    if (shouldSkipLiveSuite()) {
      this.skip();
    }

    const network = await hre.ethers.provider.getNetwork();
    if (network.chainId !== ARBITRUM_SEPOLIA_CHAIN_ID) {
      this.skip();
    }

    [owner] = await hre.ethers.getSigners();
    const ownerBalance = await hre.ethers.provider.getBalance(owner.address);
    // Leave most ETH for owner deploys / Safe txs. Arb Sepolia gas is cheap.
    const maxFundEach = hre.ethers.parseEther("0.005");
    const minFundEach = hre.ethers.parseEther("0.0003");
    const fundEach = ownerBalance / 10n;
    const amountWei = fundEach > maxFundEach ? maxFundEach : fundEach;
    if (amountWei < minFundEach) {
      throw new Error(
        `Owner ${owner.address} has ${ownerBalance} wei; need more ETH on Arbitrum Sepolia to fund agent + facilitator`
      );
    }
    [agent, facilitator] = await createRandomWalletsAndFund({
      hre,
      sender: owner,
      count: 2,
      amountWei,
    });
    payTo = hre.ethers.Wallet.createRandom();
    master = hre.ethers.Wallet.createRandom();

    ownerAesKey = await getUserKeyViaProxy(owner as any, PROXY_URL);
    ownerAesKeyHex = ownerAesKey.toString("hex");
    agentAesKey = await getUserKeyViaProxy(agent as any, PROXY_URL);
    agentAesKeyHex = agentAesKey.toString("hex");

    mockToken = await deployMockToken(hre, owner, "Facilitator Test USDC", "FTUSDC");
    privateToken = await deployPrivateTokenGasless(hre, owner, {
      underlyingAddress: await mockToken.getAddress(),
      ownerAddress: owner.address,
      masterAddress: master.address,
      name: "Facilitator Bubble Token",
      symbol: "fBUB",
    });

    const deployedSafe = await resolveSafeForTests(hre, owner.address, owner);
    safeAddress = deployedSafe.safeAddress;

    const privateTokenAddress = await privateToken.getAddress();
    await mintUnderlyingToSafe(mockToken, safeAddress, NOTE_AMOUNT);
    await execSafeErc20Approve(
      safeAddress,
      owner,
      await mockToken.getAddress(),
      privateTokenAddress,
      NOTE_AMOUNT
    );
    await delay(DELAY_BALANCE_SYNC_MS);
    await execSafeShield(safeAddress, owner, privateTokenAddress, NOTE_AMOUNT);
    await delay(DELAY_MPC_EXTENDED_MS);

    const quantityIt = buildUnsignedItUint256({
      value: NOTE_AMOUNT,
      userAddress: owner.address,
      userAesKeyHex: ownerAesKeyHex,
      contractAddress: privateTokenAddress,
    });
    const { receipt } = await execSafeMintOprfToken(
      safeAddress,
      owner,
      privateTokenAddress,
      quantityIt
    );
    mintReceipt = receipt;
    await delay(DELAY_MPC_EXTENDED_MS);

    const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
    expect(mintHandles).to.not.be.undefined;
    const mintEvents = getOprfMintedEventsFromReceipt(mintReceipt, privateToken);
    expect(mintEvents[0]?.user.toLowerCase()).to.equal(safeAddress.toLowerCase());
    const mintAddresses = collectEventAddressesFromReceipt(mintReceipt, privateToken);
    expect(mintAddresses).to.include(safeAddress.toLowerCase());
    expect(mintAddresses).to.not.include(agent.address.toLowerCase());
    expect(mintAddresses).to.not.include(facilitator.address.toLowerCase());
    expect(findParsedLogInReceipt(mintReceipt, privateToken, "OPRFSplitForRecipient")).to.be.undefined;

    await execSafePermitHandleViews(hre, safeAddress, owner, owner.address, [
      mintHandles!.xHandle,
      mintHandles!.yHandle,
      mintHandles!.qHandle,
    ]);
    await delay(DELAY_MPC_DECRYPTION_MS);

    [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
      [mintHandles!.xHandle, mintHandles!.yHandle, mintHandles!.qHandle],
      owner,
      ownerAesKey,
      PROXY_URL
    );
    expect(decryptedQ).to.equal(NOTE_AMOUNT);
    expect(decryptedX).to.not.equal(0n);
    expect(decryptedY).to.not.equal(0n);
  });

  function buildAgentNoteArgs(privateTokenAddress: string, note?: { x: bigint; y: bigint; q: bigint }) {
    const src = note ?? { x: decryptedX, y: decryptedY, q: decryptedQ };
    return {
      x: buildUnsignedItUint128({
        value: src.x,
        userAddress: agent.address,
        userAesKeyHex: agentAesKeyHex,
        contractAddress: privateTokenAddress,
      }),
      q: buildUnsignedItUint256({
        value: src.q,
        userAddress: agent.address,
        userAesKeyHex: agentAesKeyHex,
        contractAddress: privateTokenAddress,
      }),
      y_clear: src.y,
    };
  }

  function buildAgentRedeemArgs(
    privateTokenAddress: string,
    note?: { x: bigint; y: bigint; q: bigint }
  ) {
    const noteArgs = buildAgentNoteArgs(privateTokenAddress, note);
    return {
      tokenInput: [noteArgs],
      amountIt: buildUnsignedItUint256({
        value: PAY_AMOUNT,
        userAddress: agent.address,
        userAesKeyHex: agentAesKeyHex,
        contractAddress: privateTokenAddress,
      }),
    };
  }

  it("rejects facilitator redeem before the agent grants insert access", async function () {
    const privateTokenAddress = await privateToken.getAddress();
    const { tokenInput, amountIt } = buildAgentRedeemArgs(privateTokenAddress);

    await expectReverted(
      privateToken.connect(facilitator).redeemManyToUnderlying(tokenInput, amountIt, agent.address, false)
    );
  });

  describe("after the agent grants insert access", function () {
    before(async function () {
      const privateTokenAddress = await privateToken.getAddress();
      const gcAcl = await getGcAclContract(hre, agent);
      const expiration = BigInt(Math.floor(Date.now() / 1000)) + INSERT_TTL_SECONDS;
      await (await gcAcl.permitFullInsertAccess(privateTokenAddress, expiration)).wait();
      expect(await gcAcl.isFullInsertPermitted(agent.address, privateTokenAddress)).to.equal(true);
    });

    it("rejects facilitator redeemManyToUnderlying to the facilitator", async function () {
      const privateTokenAddress = await privateToken.getAddress();
      const { tokenInput, amountIt } = buildAgentRedeemArgs(privateTokenAddress);

      await expectReverted(
        privateToken.connect(facilitator).redeemManyToUnderlying(tokenInput, amountIt, facilitator.address, false)
      );
    });

    it("rejects facilitator burnToken to the facilitator", async function () {
      const privateTokenAddress = await privateToken.getAddress();
      const { x, q, y_clear } = buildAgentNoteArgs(privateTokenAddress);

      await expectReverted(privateToken.connect(facilitator).burnToken(x, q, y_clear, facilitator.address));
    });

    it("lets the facilitator redeem 0.1 to the agent and leaves the remainder OPRF with the agent", async function () {
      const privateTokenAddress = await privateToken.getAddress();
      const { tokenInput, amountIt } = buildAgentRedeemArgs(privateTokenAddress);

      const agentUnderlyingBefore = await mockToken.balanceOf(agent.address);
      const facilitatorUnderlyingBefore = await mockToken.balanceOf(facilitator.address);
      const startBlock = await hre.ethers.provider.getBlockNumber();
      try {
        await privateToken
          .connect(facilitator)
          .redeemManyToUnderlying.staticCall(tokenInput, amountIt, agent.address, false);
      } catch (err: any) {
        const data = err?.data ?? err?.error?.data ?? err?.info?.error?.data;
        throw new Error(
          `facilitator redeemManyToUnderlying reverted: ${err?.shortMessage ?? err?.message}${data ? ` data=${data}` : ""}`
        );
      }

      const redeemTx = await privateToken
        .connect(facilitator)
        .redeemManyToUnderlying(tokenInput, amountIt, agent.address, false);
      const redeemReceipt = await redeemTx.wait();
      expect(redeemReceipt?.status).to.equal(1);
      expect(redeemTx.from.toLowerCase()).to.equal(facilitator.address.toLowerCase());

      const redeemAddresses = collectEventAddressesFromReceipt(redeemReceipt, privateToken);
      expect(redeemAddresses).to.include(agent.address.toLowerCase());
      expect(redeemAddresses).to.not.include(safeAddress.toLowerCase());
      expect(findParsedLogInReceipt(redeemReceipt, privateToken, "OPRFSplitForRecipient")).to.be.undefined;

      const minted = getOprfMintedEventsFromReceipt(redeemReceipt, privateToken);
      const remainderEvent = minted.find((e) => e.user.toLowerCase() === agent.address.toLowerCase());
      expect(remainderEvent).to.not.be.undefined;
      expect(minted.some((e) => e.user.toLowerCase() === facilitator.address.toLowerCase())).to.equal(false);
      expect(minted.some((e) => e.user.toLowerCase() === safeAddress.toLowerCase())).to.equal(false);

      const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
      expect(remainderEvent!.x).to.not.equal(mintHandles!.xHandle);
      expect(remainderEvent!.q).to.not.equal(mintHandles!.qHandle);

      const invalidated = findParsedLogsInReceipt(redeemReceipt, privateToken, "OPRFTokenInvalidated");
      expect(invalidated.length).to.be.greaterThan(0);
      for (const log of invalidated) {
        const decoded = privateToken.interface.parseLog(log);
        expect(decoded?.args[0].toLowerCase()).to.equal(agent.address.toLowerCase());
        expect(decoded?.args[0].toLowerCase()).to.not.equal(safeAddress.toLowerCase());
      }

      await delay(DELAY_MPC_DECRYPTION_MS);
      const remainderQ = await decryptValueViaProxy(remainderEvent!.q, agent, agentAesKey, PROXY_URL);
      expect(remainderQ).to.equal(NOTE_AMOUNT - PAY_AMOUNT);

      const facilitatorAesKey = await getUserKeyViaProxy(facilitator as any, PROXY_URL);
      await expectDecryptViaProxyToFail(remainderEvent!.q, facilitator, facilitatorAesKey, PROXY_URL);

      const { successEvents, failedEvents } = await waitForUnshieldOutcome(privateToken, hre, startBlock, {
        timeoutMs: DELAY_MPC_REDEEM_MS * 6,
        pollIntervalMs: 3000,
      });
      expect(failedEvents.length).to.equal(0, "Unshield callback should not fail");
      expect(successEvents.length).to.be.greaterThan(0);
      const unshieldTo = (successEvents[0].args?.to ?? successEvents[0].args?.[0]) as string;
      expect(unshieldTo.toLowerCase()).to.equal(agent.address.toLowerCase());

      const agentUnderlyingAfter = await mockToken.balanceOf(agent.address);
      expect(agentUnderlyingAfter - agentUnderlyingBefore).to.equal(PAY_AMOUNT);
      expect(await mockToken.balanceOf(facilitator.address)).to.equal(facilitatorUnderlyingBefore);

      await (await mockToken.connect(agent).transfer(payTo.address, PAY_AMOUNT)).wait();
      expect(await mockToken.balanceOf(payTo.address)).to.equal(PAY_AMOUNT);
      expect(await mockToken.balanceOf(agent.address)).to.equal(agentUnderlyingBefore);
    });
  });
});
