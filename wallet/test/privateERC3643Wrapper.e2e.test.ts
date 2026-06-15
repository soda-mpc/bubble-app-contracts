import { expect } from "chai";
import hre from "hardhat";
import dotenv from "dotenv";

import { getUserKeyViaProxy } from "./helpers/bubbleCryptoTransport";
import {
  buildSignedItUint256,
  createRandomWalletsAndFund,
  DELAY_BALANCE_SYNC_MS,
  deployMockToken,
  getPrivateTokenBalance,
  mintAndApprove,
  waitForDeploymentConfirmation,
  waitForUnshieldOutcome,
} from "./helpers/testHelpers";

dotenv.config();

const ARBITRUM_SEPOLIA_CHAIN_ID = 421614n;
const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const ERC3643_FQN = "contracts/erc3643/PrivateERC3643ERC20Contract256.sol:PrivateERC3643ERC20Contract256";

async function createPrivateERC3643WrapperViaFactory(params: {
  owner: any;
  underlying: string;
  identityRegistry: string;
  compliance: string;
  master: string;
}) {
  const { owner, underlying, identityRegistry, compliance, master } = params;
  const Factory = await hre.ethers.getContractFactory(ERC3643_FQN, owner);
  const implementation = await Factory.deploy();
  await implementation.waitForDeployment();
  await waitForDeploymentConfirmation(implementation, hre);

  const Erc3643Factory = await hre.ethers.getContractFactory("PrivateERC3643ERC20Factory256", owner);
  const erc3643Factory = await Erc3643Factory.deploy(await implementation.getAddress());
  await erc3643Factory.waitForDeployment();
  await waitForDeploymentConfirmation(erc3643Factory, hre);

  const createTx = await erc3643Factory[
    "createToken(string,string,address,bool,address,address,address)"
  ](
    "Private Test USD",
    "pTUSD",
    underlying,
    false,
    identityRegistry,
    compliance,
    hre.ethers.ZeroAddress
  );
  await createTx.wait();

  const events = await erc3643Factory.queryFilter(erc3643Factory.filters.TokenCreated());
  const tokenAddress = events[events.length - 1].args.token;
  expect(await erc3643Factory.isCreatedByFactory(tokenAddress)).to.equal(true);
  expect(await erc3643Factory.totalTokensCreated()).to.equal(1n);

  return Factory.attach(tokenAddress) as any;
}

describe("PrivateERC3643ERC20Contract256 E2E", function () {
  this.timeout(900000);

  let owner: any;
  let recipient: any;
  let master: any;
  let ownerAddress: string;
  let recipientAddress: string;
  let ownerAesKey: Buffer;
  let recipientAesKey: Buffer;
  let mockToken: any;
  let identityRegistry: any;
  let compliance: any;
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

    mockToken = await deployMockToken(hre, owner, "Test USD", "TUSD");

    const IdentityRegistry = await hre.ethers.getContractFactory("MockPrivateIdentityRegistry", owner);
    identityRegistry = await IdentityRegistry.deploy();
    await identityRegistry.waitForDeployment();
    await waitForDeploymentConfirmation(identityRegistry, hre);

    const Compliance = await hre.ethers.getContractFactory("MockPrivateModularCompliance", owner);
    compliance = await Compliance.deploy();
    await compliance.waitForDeployment();
    await waitForDeploymentConfirmation(compliance, hre);

    privateToken = await createPrivateERC3643WrapperViaFactory({
      owner,
      underlying: await mockToken.getAddress(),
      identityRegistry: await identityRegistry.getAddress(),
      compliance: await compliance.getAddress(),
      master: await master.getAddress(),
    });
  });

  it("wraps Test USD into private balance and enforces identity/freeze checks", async function () {
    const shieldAmount = 25n * 10n ** 18n;
    const transferAmount = 7n * 10n ** 18n;
    const unshieldAmount = 5n * 10n ** 18n;
    const maxBalanceAllowedTransferAmount = 2n * 10n ** 18n;
    const maxBalanceLimit = 10n * 10n ** 18n;
    const maxBalanceBlockedTransferAmount = 4n * 10n ** 18n;
    const frozenAmount = 10n * 10n ** 18n;
    const allowedFrozenTransferAmount = 4n * 10n ** 18n;
    const allowedFrozenUnshieldAmount = 2n * 10n ** 18n;
    const blockedFrozenAmount = 9n * 10n ** 18n;

    await expect(privateToken.shield(shieldAmount)).to.be.revertedWith("Identity is not verified.");

    await (await identityRegistry.setVerified(ownerAddress, true)).wait();
    await (await identityRegistry.setVerified(recipientAddress, true)).wait();

    await (await privateToken.setAddressFrozen(ownerAddress, true)).wait();
    await expect(privateToken.shield(shieldAmount)).to.be.revertedWith("wallet is frozen");
    await (await privateToken.setAddressFrozen(ownerAddress, false)).wait();

    await mintAndApprove({
      mockToken,
      privateToken,
      userAddress: ownerAddress,
      amount: shieldAmount,
      delayAfterApproveMs: 0,
    });

    await expect(privateToken.shield(shieldAmount))
      .to.emit(privateToken, "Shield")
      .withArgs(ownerAddress, shieldAmount)
      .and.to.emit(compliance, "CreatedCalled")
      .withArgs(ownerAddress, shieldAmount);

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

    await (await identityRegistry.setVerified(recipientAddress, false)).wait();
    await expect(privateToken["transfer(address,uint256)"](recipientAddress, transferAmount))
      .to.be.revertedWith("Transfer not possible");

    await (await identityRegistry.setVerified(recipientAddress, true)).wait();
    await expect(privateToken["transfer(address,uint256)"](recipientAddress, transferAmount))
      .to.emit(compliance, "TransferredCalled");

    const recipientPrivateAfterTransfer = await getPrivateTokenBalance({
      privateToken,
      address: recipientAddress,
      signer: recipient,
      aesKey: recipientAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(recipientPrivateAfterTransfer).to.equal(transferAmount);

    const ownerPrivateAfterTransfer = await getPrivateTokenBalance({
      privateToken,
      address: ownerAddress,
      signer: owner as any,
      aesKey: ownerAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(ownerPrivateAfterTransfer).to.equal(shieldAmount - transferAmount);

    await (await compliance.setTransferAllowed(false)).wait();
    await expect(privateToken["transfer(address,uint256)"](recipientAddress, 1n * 10n ** 18n))
      .to.emit(compliance, "TransferredCalled");

    const recipientPrivateAfterDeniedTransfer = await getPrivateTokenBalance({
      privateToken,
      address: recipientAddress,
      signer: recipient,
      aesKey: recipientAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(recipientPrivateAfterDeniedTransfer).to.equal(transferAmount);

    const ownerPrivateAfterDeniedTransfer = await getPrivateTokenBalance({
      privateToken,
      address: ownerAddress,
      signer: owner as any,
      aesKey: ownerAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(ownerPrivateAfterDeniedTransfer).to.equal(ownerPrivateAfterTransfer);
    await (await compliance.setTransferAllowed(true)).wait();

    await (await compliance.setMaxBalance(recipientAddress, maxBalanceLimit)).wait();
    await expect(privateToken["transfer(address,uint256)"](recipientAddress, maxBalanceBlockedTransferAmount))
      .to.emit(compliance, "TransferredCalled");

    const recipientPrivateAfterMaxBalanceBlockedTransfer = await getPrivateTokenBalance({
      privateToken,
      address: recipientAddress,
      signer: recipient,
      aesKey: recipientAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(recipientPrivateAfterMaxBalanceBlockedTransfer).to.equal(transferAmount);

    const ownerPrivateAfterMaxBalanceBlockedTransfer = await getPrivateTokenBalance({
      privateToken,
      address: ownerAddress,
      signer: owner as any,
      aesKey: ownerAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(ownerPrivateAfterMaxBalanceBlockedTransfer).to.equal(ownerPrivateAfterTransfer);

    await expect(privateToken["transfer(address,uint256)"](recipientAddress, maxBalanceAllowedTransferAmount))
      .to.emit(compliance, "TransferredCalled");

    const recipientPrivateAfterMaxBalanceAllowedTransfer = await getPrivateTokenBalance({
      privateToken,
      address: recipientAddress,
      signer: recipient,
      aesKey: recipientAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(recipientPrivateAfterMaxBalanceAllowedTransfer).to.equal(transferAmount + maxBalanceAllowedTransferAmount);

    const ownerPrivateAfterMaxBalanceAllowedTransfer = await getPrivateTokenBalance({
      privateToken,
      address: ownerAddress,
      signer: owner as any,
      aesKey: ownerAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(ownerPrivateAfterMaxBalanceAllowedTransfer).to.equal(ownerPrivateAfterTransfer - maxBalanceAllowedTransferAmount);
    await (await compliance.clearMaxBalance(recipientAddress)).wait();

    const contractAddress = await privateToken.getAddress();
    const freezeIt = await buildSignedItUint256({
      value: frozenAmount,
      userAddress: ownerAddress,
      userAesKeyHex: ownerAesKey.toString("hex"),
      contractAddress,
      signer: owner,
    });
    await (await privateToken.freezePartialTokens(ownerAddress, freezeIt)).wait();

    await expect(privateToken["transfer(address,uint256)"](recipientAddress, allowedFrozenTransferAmount))
      .to.emit(compliance, "TransferredCalled");

    const recipientPrivateAfterAllowedFrozenTransfer = await getPrivateTokenBalance({
      privateToken,
      address: recipientAddress,
      signer: recipient,
      aesKey: recipientAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(recipientPrivateAfterAllowedFrozenTransfer)
      .to.equal(recipientPrivateAfterMaxBalanceAllowedTransfer + allowedFrozenTransferAmount);

    const ownerPrivateAfterAllowedFrozenTransfer = await getPrivateTokenBalance({
      privateToken,
      address: ownerAddress,
      signer: owner as any,
      aesKey: ownerAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(ownerPrivateAfterAllowedFrozenTransfer)
      .to.equal(ownerPrivateAfterMaxBalanceAllowedTransfer - allowedFrozenTransferAmount);

    await expect(privateToken["transfer(address,uint256)"](recipientAddress, blockedFrozenAmount))
      .to.emit(compliance, "TransferredCalled");

    const recipientPrivateAfterFrozenTransfer = await getPrivateTokenBalance({
      privateToken,
      address: recipientAddress,
      signer: recipient,
      aesKey: recipientAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(recipientPrivateAfterFrozenTransfer)
      .to.equal(recipientPrivateAfterMaxBalanceAllowedTransfer + allowedFrozenTransferAmount);

    const ownerPrivateAfterFrozenTransfer = await getPrivateTokenBalance({
      privateToken,
      address: ownerAddress,
      signer: owner as any,
      aesKey: ownerAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(ownerPrivateAfterFrozenTransfer).to.equal(ownerPrivateAfterAllowedFrozenTransfer);

    const allowedUnshieldUnderlyingBefore = await mockToken.balanceOf(ownerAddress);
    const allowedUnshieldStartBlock = await hre.ethers.provider.getBlockNumber();
    await (await privateToken.unshield(allowedFrozenUnshieldAmount)).wait();
    const allowedUnshieldOutcome = await waitForUnshieldOutcome(privateToken, hre, allowedUnshieldStartBlock, {
      timeoutMs: 180000,
      pollIntervalMs: 5000,
    });
    expect(allowedUnshieldOutcome.failedEvents.length, "Expected no failed allowed frozen unshield").to.equal(0);
    expect(allowedUnshieldOutcome.successEvents.length, "Expected successful allowed frozen unshield")
      .to.be.greaterThan(0);
    const allowedUnshieldUnderlyingAfter = await mockToken.balanceOf(ownerAddress);
    expect(allowedUnshieldUnderlyingAfter - allowedUnshieldUnderlyingBefore).to.equal(allowedFrozenUnshieldAmount);

    const blockedUnshieldStartBlock = await hre.ethers.provider.getBlockNumber();
    await (await privateToken.unshield(blockedFrozenAmount)).wait();
    const blockedUnshieldOutcome = await waitForUnshieldOutcome(privateToken, hre, blockedUnshieldStartBlock, {
      timeoutMs: 180000,
      pollIntervalMs: 5000,
    });
    expect(blockedUnshieldOutcome.successEvents.length, "Expected no successful frozen unshield").to.equal(0);
    expect(blockedUnshieldOutcome.failedEvents.length, "Expected frozen unshield to fail with zero effective amount")
      .to.be.greaterThan(0);

    const unfreezeIt = await buildSignedItUint256({
      value: frozenAmount,
      userAddress: ownerAddress,
      userAesKeyHex: ownerAesKey.toString("hex"),
      contractAddress,
      signer: owner,
    });
    await (await privateToken.unfreezePartialTokens(ownerAddress, unfreezeIt)).wait();

    const ownerUnderlyingBefore = await mockToken.balanceOf(ownerAddress);
    const startBlock = await hre.ethers.provider.getBlockNumber();
    await (await privateToken.unshield(unshieldAmount)).wait();

    const { successEvents, failedEvents } = await waitForUnshieldOutcome(privateToken, hre, startBlock, {
      timeoutMs: 180000,
      pollIntervalMs: 5000,
    });
    expect(failedEvents.length, "Expected no failed unshield events").to.equal(0);
    expect(successEvents.length, "Expected successful unshield event").to.be.greaterThan(0);
    const destroyedEvents = await compliance.queryFilter(
      compliance.filters.DestroyedCalled(ownerAddress),
      startBlock,
      await hre.ethers.provider.getBlockNumber()
    );
    expect(destroyedEvents.length, "Expected compliance destroyed callback").to.be.greaterThan(0);
    expect(destroyedEvents[destroyedEvents.length - 1].args.amount).to.equal(unshieldAmount);

    const ownerUnderlyingAfter = await mockToken.balanceOf(ownerAddress);
    expect(ownerUnderlyingAfter - ownerUnderlyingBefore).to.equal(unshieldAmount);
    expect(await privateToken.totalSupply()).to.equal(shieldAmount - allowedFrozenUnshieldAmount - unshieldAmount);
    expect(await mockToken.balanceOf(await privateToken.getAddress()))
      .to.equal(shieldAmount - allowedFrozenUnshieldAmount - unshieldAmount);

    await new Promise((resolve) => setTimeout(resolve, DELAY_BALANCE_SYNC_MS));
    const ownerPrivateAfterUnshield = await getPrivateTokenBalance({
      privateToken,
      address: ownerAddress,
      signer: owner as any,
      aesKey: ownerAesKey,
      proxyUrl: PROXY_URL,
    });
    expect(ownerPrivateAfterUnshield)
      .to.equal(
        shieldAmount
        - transferAmount
        - maxBalanceAllowedTransferAmount
        - allowedFrozenTransferAmount
        - allowedFrozenUnshieldAmount
        - unshieldAmount
      );
  });
});
