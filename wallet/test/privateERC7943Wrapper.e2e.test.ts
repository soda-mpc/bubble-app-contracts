import { expect } from "chai";
import hre from "hardhat";
import dotenv from "dotenv";

import { getUserKeyViaProxy } from "./helpers/bubbleCryptoTransport";
import {
  createRandomWalletsAndFund,
  DELAY_BALANCE_SYNC_MS,
  deployMockToken,
  expectRecipientCanDecryptPrivateTransferEvent,
  getPrivateTokenBalance,
  mintAndApprove,
  expectPrivateTransferEmitted,
  waitForCondition,
  waitForDeploymentConfirmation,
  waitForUnshieldOutcome,
} from "./helpers/testHelpers";

dotenv.config();

const ARBITRUM_SEPOLIA_CHAIN_ID = 421614n;
const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const ERC7943_FQN = "contracts/erc7943/PrivateERC7943ERC20Contract256.sol:PrivateERC7943ERC20Contract256";
const ERC165_INTERFACE_ID = "0x01ffc9a7";
const ERC7943_FUNGIBLE_INTERFACE_ID = "0x3edbb4c4";

async function createPrivateERC7943WrapperViaFactory(params: {
  owner: any;
  underlying: string;
  master: string;
  defaultSendAllowed?: boolean;
  defaultReceiveAllowed?: boolean;
}) {
  const {
    owner,
    underlying,
    master,
    defaultSendAllowed = false,
    defaultReceiveAllowed = false,
  } = params;

  const Token = await hre.ethers.getContractFactory(ERC7943_FQN, owner);
  const implementation = await Token.deploy();
  await implementation.waitForDeployment();
  await waitForDeploymentConfirmation(implementation, hre);

  const Factory = await hre.ethers.getContractFactory("PrivateERC7943ERC20Factory256", owner);
  const erc7943Factory = await Factory.deploy(await implementation.getAddress());
  await erc7943Factory.waitForDeployment();
  await waitForDeploymentConfirmation(erc7943Factory, hre);

  const createTx = await erc7943Factory[
    "createToken(string,string,address,bool,address,bool,bool)"
  ](
    "Private Test USD 7943",
    "pTUSD7943",
    underlying,
    false,
    master,
    defaultSendAllowed,
    defaultReceiveAllowed
  );
  await createTx.wait();

  const events = await erc7943Factory.queryFilter(erc7943Factory.filters.TokenCreated());
  const event = events[events.length - 1].args;
  const tokenAddress = event.token;
  expect(event.creator).to.equal(await owner.getAddress());
  expect(event.master).to.equal(master);
  expect(event.defaultSendAllowed).to.equal(defaultSendAllowed);
  expect(event.defaultReceiveAllowed).to.equal(defaultReceiveAllowed);
  expect(await erc7943Factory.isCreatedByFactory(tokenAddress)).to.equal(true);
  expect(await erc7943Factory.totalTokensCreated()).to.equal(1n);

  const token = Token.attach(tokenAddress) as any;
  expect(await token.master()).to.equal(master);
  return token;
}

async function waitForForcedTransfer(
  privateToken: any,
  from: string,
  to: string,
  startBlock: number,
  options: { timeoutMs?: number; pollIntervalMs?: number } = {}
) {
  const { timeoutMs = 180000, pollIntervalMs = 5000 } = options;
  const startTime = Date.now();

  while (Date.now() - startTime < timeoutMs) {
    const currentBlock = await hre.ethers.provider.getBlockNumber();
    const events = await privateToken.queryFilter(
      privateToken.filters.ForcedTransfer(from, to),
      startBlock,
      currentBlock
    );
    if (events.length > 0) {
      return events[events.length - 1];
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  throw new Error(`Timed out waiting for ForcedTransfer(${from}, ${to})`);
}

describe.only("PrivateERC7943ERC20Contract256 E2E", function () {
  this.timeout(900000);

  let owner: any;
  let recipient: any;
  let master: any;
  let ownerAddress: string;
  let recipientAddress: string;
  let ownerAesKey: Buffer;
  let recipientAesKey: Buffer;
  let mockToken: any;
  let privateToken: any;

  before(async function () {
    if ((!process.env.QUICKNODE_ARBITRUM_SEPOLIA_URL && !process.env.ALCHEMY_API_KEY) || !process.env.MNEMONIC) {
      this.skip();
    }

    const network = await hre.ethers.provider.getNetwork();
    if (network.chainId !== ARBITRUM_SEPOLIA_CHAIN_ID) {
      this.skip();
    }

    [owner] = await hre.ethers.getSigners();
    [recipient, master] = await createRandomWalletsAndFund({
      hre,
      sender: owner,
      count: 2,
      amountWei: hre.ethers.parseEther("0.02"),
    });

    ownerAddress = await owner.getAddress();
    recipientAddress = await recipient.getAddress();
    ownerAesKey = await getUserKeyViaProxy(owner as any, PROXY_URL);
    recipientAesKey = await getUserKeyViaProxy(recipient as any, PROXY_URL);

    mockToken = await deployMockToken(hre, owner, "Test USD 7943", "TUSD7943");
    await waitForDeploymentConfirmation(mockToken, hre);

    privateToken = await createPrivateERC7943WrapperViaFactory({
      owner,
      underlying: await mockToken.getAddress(),
      master: await master.getAddress(),
      defaultSendAllowed: false,
      defaultReceiveAllowed: false,
    });
  });

  it("wraps Test USD into private balance and enforces eligibility/freeze/forced-transfer checks", async function () {
    const masterAddress = await master.getAddress();
    const shieldAmount = 30n * 10n ** 18n;
    const firstTransferAmount = 10n * 10n ** 18n;
    const frozenAmount = 12n * 10n ** 18n;
    const allowedFrozenTransferAmount = 5n * 10n ** 18n;
    const blockedFrozenTransferAmount = 4n * 10n ** 18n;
    const allowedUnshieldAmount = 3n * 10n ** 18n;
    const blockedUnshieldAmount = 1n * 10n ** 18n;
    const transferFromAmount = 1n * 10n ** 18n;
    const recipientFrozenAmount = 4n * 10n ** 18n;
    const forcedTransferRequestAmount = 100n * 10n ** 18n;

    expect(await privateToken.supportsInterface(ERC165_INTERFACE_ID)).to.equal(true);
    expect(await privateToken.supportsInterface(ERC7943_FUNGIBLE_INTERFACE_ID)).to.equal(false);
    await expect(privateToken.canTransfer(ownerAddress, recipientAddress, 1n))
      .to.be.revertedWithCustomError(privateToken, "ERC7943CanTransferNotImplemented");
    expect(await privateToken.canSend(hre.ethers.ZeroAddress)).to.equal(false);
    expect(await privateToken.canReceive(hre.ethers.ZeroAddress)).to.equal(false);
    expect(await privateToken.isAgent(ownerAddress)).to.equal(true);
    expect(await privateToken.canSend(recipientAddress)).to.equal(false);
    expect(await privateToken.canReceive(recipientAddress)).to.equal(false);

    await expect(privateToken.connect(recipient).addAgent(masterAddress))
      .to.be.revertedWithCustomError(privateToken, "OwnableUnauthorizedAccount")
      .withArgs(recipientAddress);
    await expect(privateToken.connect(recipient).setDefaultEligibility(true, true))
      .to.be.revertedWithCustomError(privateToken, "OwnableUnauthorizedAccount")
      .withArgs(recipientAddress);
    await expect(privateToken.connect(recipient).setCanSend(recipientAddress, true))
      .to.be.revertedWith("AgentRole: caller does not have the Agent role");
    await expect(privateToken.connect(recipient).setFrozenTokens(recipientAddress, 1n))
      .to.be.revertedWith("AgentRole: caller does not have the Agent role");
    await expect(privateToken.connect(recipient).pause())
      .to.be.revertedWith("AgentRole: caller does not have the Agent role");

    await expect(privateToken.setDefaultEligibility(true, true))
      .to.emit(privateToken, "DefaultEligibilitySet")
      .withArgs(true, true);
    expect(await privateToken.canSend(recipientAddress)).to.equal(true);
    expect(await privateToken.canReceive(recipientAddress)).to.equal(true);
    expect(await privateToken.canSend(hre.ethers.ZeroAddress)).to.equal(false);
    expect(await privateToken.canReceive(hre.ethers.ZeroAddress)).to.equal(false);
    await expect(privateToken.setDefaultEligibility(false, false))
      .to.emit(privateToken, "DefaultEligibilitySet")
      .withArgs(false, false);

    await expect(privateToken.addAgent(masterAddress))
      .to.emit(privateToken, "AgentAdded")
      .withArgs(masterAddress);
    expect(await privateToken.isAgent(masterAddress)).to.equal(true);
    await expect(privateToken.connect(master).setCanSend(recipientAddress, true))
      .to.emit(privateToken, "CanSendSet")
      .withArgs(recipientAddress, true);
    expect(await privateToken.canSend(recipientAddress)).to.equal(true);
    await expect(privateToken.removeAgent(masterAddress))
      .to.emit(privateToken, "AgentRemoved")
      .withArgs(masterAddress);
    expect(await privateToken.isAgent(masterAddress)).to.equal(false);
    await expect(privateToken.setCanSend(recipientAddress, false))
      .to.emit(privateToken, "CanSendSet")
      .withArgs(recipientAddress, false);

    await expect(privateToken.pause()).to.emit(privateToken, "Paused").withArgs(ownerAddress);
    expect(await privateToken.paused()).to.equal(true);
    await expect(privateToken.unpause()).to.emit(privateToken, "Unpaused").withArgs(ownerAddress);
    expect(await privateToken.paused()).to.equal(false);

    await expect(privateToken.forcedTransfer(hre.ethers.ZeroAddress, recipientAddress, 1n))
      .to.be.revertedWith("ERC20: transfer from the zero address");
    await expect(privateToken.forcedTransfer(ownerAddress, hre.ethers.ZeroAddress, 1n))
      .to.be.revertedWith("ERC20: transfer to the zero address");
    await expect(privateToken.forcedTransfer(ownerAddress, ownerAddress, 1n))
      .to.be.revertedWith("ERC20: forced transfer to self");
    await expect(privateToken.forcedTransfer(ownerAddress, recipientAddress, 0n))
      .to.be.revertedWith("Amount must be greater than 0");
    await expect(privateToken.forcedTransfer(ownerAddress, recipientAddress, 1n))
      .to.be.revertedWithCustomError(privateToken, "ERC7943CannotReceive")
      .withArgs(recipientAddress);

    await mintAndApprove({
      mockToken,
      privateToken,
      userAddress: ownerAddress,
      amount: shieldAmount,
      delayAfterApproveMs: 0,
    });

    await expect(privateToken.shield(shieldAmount))
      .to.be.revertedWithCustomError(privateToken, "ERC7943CannotReceive")
      .withArgs(ownerAddress);

    await expect(privateToken.setCanReceive(ownerAddress, true))
      .to.emit(privateToken, "CanReceiveSet")
      .withArgs(ownerAddress, true);
    expect(await privateToken.canReceive(ownerAddress)).to.equal(true);

    await expect(privateToken.shield(shieldAmount))
      .to.emit(privateToken, "Shield")
      .withArgs(ownerAddress, shieldAmount);

    await waitForCondition(async () => {
      const privateTokenAddress = await privateToken.getAddress();
      return (
        await mockToken.balanceOf(privateTokenAddress)
      ) === shieldAmount && await privateToken.totalSupply() === shieldAmount;
    }, 60000, 3000);
    expect(await mockToken.balanceOf(await privateToken.getAddress())).to.equal(shieldAmount);
    expect(await privateToken.totalSupply()).to.equal(shieldAmount);

    const ownerPrivateAfterShield = await getPrivateTokenBalance({
      privateToken,
      address: ownerAddress,
      signer: owner as any,
      aesKey: ownerAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(ownerPrivateAfterShield).to.equal(shieldAmount);

    await expect(privateToken["transfer(address,uint256)"](recipientAddress, firstTransferAmount))
      .to.be.revertedWithCustomError(privateToken, "ERC7943CannotSend")
      .withArgs(ownerAddress);

    await expect(privateToken.setCanSend(ownerAddress, true))
      .to.emit(privateToken, "CanSendSet")
      .withArgs(ownerAddress, true);
    await expect(privateToken["transfer(address,uint256)"](recipientAddress, firstTransferAmount))
      .to.be.revertedWithCustomError(privateToken, "ERC7943CannotReceive")
      .withArgs(recipientAddress);

    await expect(privateToken.setCanReceive(recipientAddress, true))
      .to.emit(privateToken, "CanReceiveSet")
      .withArgs(recipientAddress, true);
    const firstTransferReceipt = await expectPrivateTransferEmitted(
      privateToken["transfer(address,uint256)"](recipientAddress, firstTransferAmount),
      privateToken
    );
    await expectRecipientCanDecryptPrivateTransferEvent({
      receipt: firstTransferReceipt,
      privateToken,
      recipient,
      recipientAesKey,
      senderAddress: ownerAddress,
      recipientAddress,
      expectedAmount: firstTransferAmount,
      proxyUrl: PROXY_URL,
    });

    const recipientPrivateAfterFirstTransfer = await getPrivateTokenBalance({
      privateToken,
      address: recipientAddress,
      signer: recipient,
      aesKey: recipientAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(recipientPrivateAfterFirstTransfer).to.equal(firstTransferAmount);

    const ownerPrivateAfterFirstTransfer = await getPrivateTokenBalance({
      privateToken,
      address: ownerAddress,
      signer: owner as any,
      aesKey: ownerAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(ownerPrivateAfterFirstTransfer).to.equal(shieldAmount - firstTransferAmount);

    await expect(privateToken.setFrozenTokens(ownerAddress, frozenAmount))
      .to.emit(privateToken, "Frozen")
      .withArgs(ownerAddress, frozenAmount);
    expect(await privateToken.getFrozenTokens(ownerAddress)).to.equal(frozenAmount);

    await expectPrivateTransferEmitted(
      privateToken["transfer(address,uint256)"](recipientAddress, allowedFrozenTransferAmount),
      privateToken
    );

    const ownerPrivateAfterAllowedFrozenTransfer = await getPrivateTokenBalance({
      privateToken,
      address: ownerAddress,
      signer: owner as any,
      aesKey: ownerAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(ownerPrivateAfterAllowedFrozenTransfer)
      .to.equal(shieldAmount - firstTransferAmount - allowedFrozenTransferAmount);

    const recipientPrivateAfterAllowedFrozenTransfer = await getPrivateTokenBalance({
      privateToken,
      address: recipientAddress,
      signer: recipient,
      aesKey: recipientAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(recipientPrivateAfterAllowedFrozenTransfer)
      .to.equal(firstTransferAmount + allowedFrozenTransferAmount);

    await expectPrivateTransferEmitted(
      privateToken["transfer(address,uint256)"](recipientAddress, blockedFrozenTransferAmount),
      privateToken
    );

    const ownerPrivateAfterBlockedFrozenTransfer = await getPrivateTokenBalance({
      privateToken,
      address: ownerAddress,
      signer: owner as any,
      aesKey: ownerAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(ownerPrivateAfterBlockedFrozenTransfer).to.equal(ownerPrivateAfterAllowedFrozenTransfer);

    const recipientPrivateAfterBlockedFrozenTransfer = await getPrivateTokenBalance({
      privateToken,
      address: recipientAddress,
      signer: recipient,
      aesKey: recipientAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(recipientPrivateAfterBlockedFrozenTransfer).to.equal(recipientPrivateAfterAllowedFrozenTransfer);

    const allowedUnshieldUnderlyingBefore = await mockToken.balanceOf(ownerAddress);
    const allowedUnshieldStartBlock = await hre.ethers.provider.getBlockNumber();
    await (await privateToken.unshield(allowedUnshieldAmount)).wait();
    const allowedUnshieldOutcome = await waitForUnshieldOutcome(privateToken, hre, allowedUnshieldStartBlock, {
      timeoutMs: 180000,
      pollIntervalMs: 5000,
    });
    expect(allowedUnshieldOutcome.failedEvents.length, "Expected no failed allowed unshield").to.equal(0);
    expect(allowedUnshieldOutcome.successEvents.length, "Expected successful allowed unshield")
      .to.be.greaterThan(0);
    const allowedUnshieldUnderlyingAfter = await mockToken.balanceOf(ownerAddress);
    expect(allowedUnshieldUnderlyingAfter - allowedUnshieldUnderlyingBefore).to.equal(allowedUnshieldAmount);

    const blockedUnshieldStartBlock = await hre.ethers.provider.getBlockNumber();
    await (await privateToken.unshield(blockedUnshieldAmount)).wait();
    const blockedUnshieldOutcome = await waitForUnshieldOutcome(privateToken, hre, blockedUnshieldStartBlock, {
      timeoutMs: 180000,
      pollIntervalMs: 5000,
    });
    expect(blockedUnshieldOutcome.successEvents.length, "Expected no successful frozen unshield").to.equal(0);
    expect(blockedUnshieldOutcome.failedEvents.length, "Expected frozen unshield to fail with zero effective amount")
      .to.be.greaterThan(0);

    await expect(privateToken.setFrozenTokens(ownerAddress, 0n))
      .to.emit(privateToken, "Frozen")
      .withArgs(ownerAddress, 0n);

    await (await privateToken["approve(address,uint256)"](masterAddress, transferFromAmount)).wait();
    await expectPrivateTransferEmitted(
      privateToken
        .connect(master)
        ["transferFrom(address,address,uint256)"](ownerAddress, recipientAddress, transferFromAmount),
      privateToken
    );

    const ownerPrivateAfterTransferFrom = await getPrivateTokenBalance({
      privateToken,
      address: ownerAddress,
      signer: owner as any,
      aesKey: ownerAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(ownerPrivateAfterTransferFrom)
      .to.equal(shieldAmount - firstTransferAmount - allowedFrozenTransferAmount - allowedUnshieldAmount - transferFromAmount);

    const recipientPrivateAfterTransferFrom = await getPrivateTokenBalance({
      privateToken,
      address: recipientAddress,
      signer: recipient,
      aesKey: recipientAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(recipientPrivateAfterTransferFrom)
      .to.equal(firstTransferAmount + allowedFrozenTransferAmount + transferFromAmount);

    await new Promise((resolve) => setTimeout(resolve, DELAY_BALANCE_SYNC_MS));
    const ownerPrivateBeforeForcedTransfer = await getPrivateTokenBalance({
      privateToken,
      address: ownerAddress,
      signer: owner as any,
      aesKey: ownerAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(ownerPrivateBeforeForcedTransfer)
      .to.equal(
        shieldAmount
        - firstTransferAmount
        - allowedFrozenTransferAmount
        - allowedUnshieldAmount
        - transferFromAmount
      );

    const recipientPrivateBeforeForcedTransfer = await getPrivateTokenBalance({
      privateToken,
      address: recipientAddress,
      signer: recipient,
      aesKey: recipientAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(recipientPrivateBeforeForcedTransfer)
      .to.equal(firstTransferAmount + allowedFrozenTransferAmount + transferFromAmount);
    expect(recipientPrivateBeforeForcedTransfer).to.be.lessThan(forcedTransferRequestAmount);
    expect(recipientPrivateBeforeForcedTransfer).to.be.greaterThan(recipientFrozenAmount);

    await expect(privateToken.setCanSend(recipientAddress, false))
      .to.emit(privateToken, "CanSendSet")
      .withArgs(recipientAddress, false);
    await expect(privateToken.forcedTransfer(recipientAddress, ownerAddress, forcedTransferRequestAmount))
      .to.be.revertedWithCustomError(privateToken, "ERC7943NoFrozenTokens")
      .withArgs(recipientAddress);
    await expect(privateToken.setFrozenTokens(recipientAddress, recipientFrozenAmount))
      .to.emit(privateToken, "Frozen")
      .withArgs(recipientAddress, recipientFrozenAmount);

    const forcedTransferStartBlock = await hre.ethers.provider.getBlockNumber();
    const forcedTransferReceipt = await (
      await privateToken.forcedTransfer(recipientAddress, ownerAddress, forcedTransferRequestAmount)
    ).wait();
    const forcedTransferRequestedEvents = forcedTransferReceipt.logs
      .map((log: any) => {
        try {
          return privateToken.interface.parseLog(log);
        } catch {
          return null;
        }
      })
      .filter((event: any) => event?.name === "ForcedTransferRequested");
    expect(forcedTransferRequestedEvents.length, "Expected forced transfer request event").to.equal(1);
    expect(forcedTransferRequestedEvents[0].args.from).to.equal(recipientAddress);
    expect(forcedTransferRequestedEvents[0].args.to).to.equal(ownerAddress);
    expect(forcedTransferRequestedEvents[0].args.requestedAmount).to.equal(forcedTransferRequestAmount);

    const forcedTransferEvent = await waitForForcedTransfer(
      privateToken,
      recipientAddress,
      ownerAddress,
      forcedTransferStartBlock
    );
    expect(forcedTransferEvent.args.amount).to.equal(recipientFrozenAmount);
    expect(await privateToken.getFrozenTokens(recipientAddress)).to.equal(0n);

    const ownerPrivateAfterForcedTransfer = await getPrivateTokenBalance({
      privateToken,
      address: ownerAddress,
      signer: owner as any,
      aesKey: ownerAesKey,
      proxyUrl: PROXY_URL,
    });
    const recipientPrivateAfterForcedTransfer = await getPrivateTokenBalance({
      privateToken,
      address: recipientAddress,
      signer: recipient,
      aesKey: recipientAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(ownerPrivateAfterForcedTransfer)
      .to.equal(ownerPrivateBeforeForcedTransfer + recipientFrozenAmount);
    expect(recipientPrivateAfterForcedTransfer)
      .to.equal(recipientPrivateBeforeForcedTransfer - recipientFrozenAmount);

    const expectedBackedSupply = shieldAmount - allowedUnshieldAmount;
    expect(await privateToken.totalSupply()).to.equal(expectedBackedSupply);
    expect(await mockToken.balanceOf(await privateToken.getAddress())).to.equal(expectedBackedSupply);
  });
});
