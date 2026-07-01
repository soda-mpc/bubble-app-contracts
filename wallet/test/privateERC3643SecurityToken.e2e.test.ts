import { expect } from "chai";
import hre from "hardhat";
import dotenv from "dotenv";

import { decryptBalanceViaProxy, getUserKeyViaProxy } from "./helpers/bubbleCryptoTransport";
import {
  buildSignedItUint256,
  createRandomWalletsAndFund,
  getPrivateTokenBalance,
  waitForDeploymentConfirmation,
} from "./helpers/testHelpers";

dotenv.config();

const ARBITRUM_SEPOLIA_CHAIN_ID = 421614n;
const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const ERC3643_SECURITY_FQN =
  "contracts/erc3643/PrivateERC3643SecurityToken256.sol:PrivateERC3643SecurityToken256";
const CLEAR_TRANSFER_TOPIC = hre.ethers.id("Transfer(address,address,uint256)");
const PRIVATE_TRANSFER_TOPIC = hre.ethers.id("Transfer(address,address)");

async function createPrivateERC3643SecurityTokenViaFactory(params: {
  owner: any;
  identityRegistry: string;
  compliance: string;
}) {
  const { owner, identityRegistry, compliance } = params;
  const Token = await hre.ethers.getContractFactory(ERC3643_SECURITY_FQN, owner);
  const implementation = await Token.deploy();
  await implementation.waitForDeployment();
  await waitForDeploymentConfirmation(implementation, hre);

  const Factory = await hre.ethers.getContractFactory("PrivateERC3643SecurityTokenFactory256", owner);
  const factory = await Factory.deploy(await implementation.getAddress());
  await factory.waitForDeployment();
  await waitForDeploymentConfirmation(factory, hre);

  const createReceipt = await (await factory.createToken(
    "Private Security Token",
    "pSEC",
    18,
    identityRegistry,
    compliance,
    hre.ethers.ZeroAddress
  )).wait();

  const event = parseEventFromReceipt(createReceipt, factory, "TokenCreated").args;
  const tokenAddress = event.token;
  expect(event.creator).to.equal(await owner.getAddress());
  expect(event.decimals).to.equal(18n);
  expect(await factory.isCreatedByFactory(tokenAddress)).to.equal(true);
  expect(await factory.totalTokensCreated()).to.equal(1n);

  return Token.attach(tokenAddress) as any;
}

function parseEventFromReceipt(receipt: any, contract: any, eventName: string) {
  for (const log of receipt.logs) {
    try {
      const parsed = contract.interface.parseLog(log);
      if (parsed?.name === eventName) {
        return parsed;
      }
    } catch {
      // Ignore logs from other contracts.
    }
  }
  throw new Error(`Missing ${eventName} event`);
}

async function decryptHandle(handle: bigint, signer: any, aesKey: Buffer) {
  if (handle === 0n) {
    return 0n;
  }
  return decryptBalanceViaProxy(handle, signer, aesKey, PROXY_URL);
}

async function expectOnlyNoAmountTransferEvent(tx: Promise<any>, privateToken: any) {
  const receipt = await (await tx).wait();
  const privateTokenAddress = (await privateToken.getAddress()).toLowerCase();
  const tokenLogs = receipt.logs.filter((log: any) => log.address.toLowerCase() === privateTokenAddress);
  const clearTransferLogs = tokenLogs.filter((log: any) => log.topics[0] === CLEAR_TRANSFER_TOPIC);
  const privateTransferLogs = tokenLogs.filter((log: any) => log.topics[0] === PRIVATE_TRANSFER_TOPIC);

  expect(clearTransferLogs.length, "Unexpected clear-amount Transfer event").to.equal(0);
  expect(privateTransferLogs.length, "Expected no-amount Transfer event").to.equal(1);
  return receipt;
}

describe("PrivateERC3643SecurityToken256 E2E", function () {
  this.timeout(900000);

  let owner: any;
  let recipient: any;
  let outsider: any;
  let ownerAddress: string;
  let recipientAddress: string;
  let ownerAesKey: Buffer;
  let recipientAesKey: Buffer;
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
    [recipient, outsider] = await createRandomWalletsAndFund({
      hre,
      sender: owner,
      count: 2,
      amountWei: hre.ethers.parseEther("0.02"),
    });

    ownerAddress = await owner.getAddress();
    recipientAddress = await recipient.getAddress();
    ownerAesKey = await getUserKeyViaProxy(owner as any, PROXY_URL);
    recipientAesKey = await getUserKeyViaProxy(recipient as any, PROXY_URL);

    const IdentityRegistry = await hre.ethers.getContractFactory("MockPrivateIdentityRegistry", owner);
    identityRegistry = await IdentityRegistry.deploy();
    await identityRegistry.waitForDeployment();
    await waitForDeploymentConfirmation(identityRegistry, hre);

    const Compliance = await hre.ethers.getContractFactory("MockPrivateSecurityTokenCompliance", owner);
    compliance = await Compliance.deploy();
    await compliance.waitForDeployment();
    await waitForDeploymentConfirmation(compliance, hre);

    privateToken = await createPrivateERC3643SecurityTokenViaFactory({
      owner,
      identityRegistry: await identityRegistry.getAddress(),
      compliance: await compliance.getAddress(),
    });
  });

  it("mints and burns private security token balances with encrypted supply", async function () {
    const mintAmount = 25n * 10n ** 18n;
    const transferAmount = 7n * 10n ** 18n;
    const overBurnAmount = 100n * 10n ** 18n;
    const burnAmount = 5n * 10n ** 18n;
    const frozenAmount = 10n * 10n ** 18n;
    const tokenAddress = await privateToken.getAddress();

    expect(await privateToken.isAgent(ownerAddress)).to.equal(true);
    expect(await privateToken.name()).to.equal("Private Security Token");
    expect(await privateToken.symbol()).to.equal("pSEC");
    expect(await privateToken.decimals()).to.equal(18n);

    const mintIt = await buildSignedItUint256({
      value: mintAmount,
      userAddress: ownerAddress,
      userAesKeyHex: ownerAesKey.toString("hex"),
      contractAddress: tokenAddress,
      signer: owner,
    });

    await expect(privateToken.connect(outsider).mint(ownerAddress, mintIt))
      .to.be.revertedWith("AgentRole: caller does not have the Agent role");
    await expect(privateToken.mint(ownerAddress, mintIt)).to.be.revertedWith("Identity is not verified.");

    await (await identityRegistry.setVerified(ownerAddress, true)).wait();
    await (await identityRegistry.setVerified(recipientAddress, true)).wait();

    await (await privateToken.setAddressFrozen(ownerAddress, true)).wait();
    await expect(privateToken.mint(ownerAddress, mintIt)).to.be.revertedWith("wallet is frozen");
    await (await privateToken.setAddressFrozen(ownerAddress, false)).wait();

    const mintReceipt = await (await privateToken.mint(ownerAddress, mintIt)).wait();
    const mintEvent = parseEventFromReceipt(mintReceipt, privateToken, "PrivateMint");
    expect(await decryptHandle(mintEvent.args.amount, owner, ownerAesKey)).to.equal(mintAmount);
    expect(await getPrivateTokenBalance({
      privateToken,
      address: ownerAddress,
      signer: owner,
      aesKey: ownerAesKey,
      proxyUrl: PROXY_URL,
    })).to.equal(mintAmount);
    expect(await decryptHandle(await privateToken.totalSupply(), owner, ownerAesKey)).to.equal(mintAmount);

    await (await compliance.setCreateAllowed(false)).wait();
    const deniedMintReceipt = await (await privateToken.mint(ownerAddress, mintIt)).wait();
    const deniedMintEvent = parseEventFromReceipt(deniedMintReceipt, privateToken, "PrivateMint");
    expect(await decryptHandle(deniedMintEvent.args.amount, owner, ownerAesKey)).to.equal(0n);
    expect(await decryptHandle(await privateToken.totalSupply(), owner, ownerAesKey)).to.equal(mintAmount);
    await (await compliance.setCreateAllowed(true)).wait();

    const transferReceipt = await expectOnlyNoAmountTransferEvent(
      privateToken["transfer(address,uint256)"](recipientAddress, transferAmount),
      privateToken
    );
    expect(transferReceipt.logs.some((log: any) => log.topics[0] === CLEAR_TRANSFER_TOPIC)).to.equal(false);
    expect(await getPrivateTokenBalance({
      privateToken,
      address: recipientAddress,
      signer: recipient,
      aesKey: recipientAesKey,
      proxyUrl: PROXY_URL,
    })).to.equal(transferAmount);

    const ownerBalanceAfterTransfer = mintAmount - transferAmount;
    expect(await getPrivateTokenBalance({
      privateToken,
      address: ownerAddress,
      signer: owner,
      aesKey: ownerAesKey,
      proxyUrl: PROXY_URL,
    })).to.equal(ownerBalanceAfterTransfer);

    const encryptedApproveAmount = 3n * 10n ** 18n;
    const encryptedApproveIt = await buildSignedItUint256({
      value: encryptedApproveAmount,
      userAddress: ownerAddress,
      userAesKeyHex: ownerAesKey.toString("hex"),
      contractAddress: tokenAddress,
      signer: owner,
    });
    await (await privateToken["approve(address,(address,(uint256,uint256)))"](
      recipientAddress,
      encryptedApproveIt
    )).wait();
    expect(await decryptHandle(await privateToken.allowance(ownerAddress, recipientAddress), owner, ownerAesKey))
      .to.equal(encryptedApproveAmount);

    const overBurnIt = await buildSignedItUint256({
      value: overBurnAmount,
      userAddress: ownerAddress,
      userAesKeyHex: ownerAesKey.toString("hex"),
      contractAddress: tokenAddress,
      signer: owner,
    });
    const overBurnReceipt = await (await privateToken.burn(ownerAddress, overBurnIt)).wait();
    const overBurnEvent = parseEventFromReceipt(overBurnReceipt, privateToken, "PrivateBurn");
    expect(await decryptHandle(overBurnEvent.args.realBurned, owner, ownerAesKey)).to.equal(0n);
    expect(await decryptHandle(await privateToken.totalSupply(), owner, ownerAesKey)).to.equal(mintAmount);

    const burnIt = await buildSignedItUint256({
      value: burnAmount,
      userAddress: ownerAddress,
      userAesKeyHex: ownerAesKey.toString("hex"),
      contractAddress: tokenAddress,
      signer: owner,
    });
    const burnReceipt = await (await privateToken.burn(ownerAddress, burnIt)).wait();
    const burnEvent = parseEventFromReceipt(burnReceipt, privateToken, "PrivateBurn");
    expect(await decryptHandle(burnEvent.args.requestedAmount, owner, ownerAesKey)).to.equal(burnAmount);
    expect(await decryptHandle(burnEvent.args.realBurned, owner, ownerAesKey)).to.equal(burnAmount);
    expect(await decryptHandle(await privateToken.totalSupply(), owner, ownerAesKey)).to.equal(mintAmount - burnAmount);
    expect(await getPrivateTokenBalance({
      privateToken,
      address: ownerAddress,
      signer: owner,
      aesKey: ownerAesKey,
      proxyUrl: PROXY_URL,
    })).to.equal(ownerBalanceAfterTransfer - burnAmount);

    const freezeIt = await buildSignedItUint256({
      value: frozenAmount,
      userAddress: ownerAddress,
      userAesKeyHex: ownerAesKey.toString("hex"),
      contractAddress: tokenAddress,
      signer: owner,
    });
    await (await privateToken.freezePartialTokens(ownerAddress, freezeIt)).wait();
    const frozenOverBurnReceipt = await (await privateToken.burn(ownerAddress, burnIt)).wait();
    const frozenOverBurnEvent = parseEventFromReceipt(frozenOverBurnReceipt, privateToken, "PrivateBurn");
    expect(await decryptHandle(frozenOverBurnEvent.args.realBurned, owner, ownerAesKey)).to.equal(0n);
  });
});
