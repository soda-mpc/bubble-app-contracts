/**
 * Live HTTP facilitator (Python) + Safe anonymous OPRF on Arbitrum Sepolia.
 *
 * Requires:
 *   - Facilitator running: http://localhost:8002 (sodawallet/backend/facilitator-service)
 *   - FACILITATOR_URL (optional, default http://localhost:8002)
 *   - Facilitator CHAIN_ID=421614 (arb-sepolia) and EIP3009_NAME matching the mock ("TestUSD")
 *   - MNEMONIC + Alchemy/QuickNode for Hardhat network sepolia-arbitrum
 *
 * Run:
 *   cd wallet
 *   npm run test:safe:oprf-facilitator-service:arbitrum-sepolia
 */
import { expect } from "chai";
import { Wallet } from "ethers";
import hre from "hardhat";
import dotenv from "dotenv";
import { randomBytes, randomUUID } from "crypto";

import {
  decryptMultipleValuesViaProxy,
  getUserKeyViaProxy,
} from "../helpers/bubbleCryptoTransport";
import { signExecuteWithAuthorization } from "../helpers/gaslessAuth";
import { signEip3009TransferWithAuthorization } from "../helpers/eip3009";
import {
  facilitatorCreateSpend,
  facilitatorFaucet,
  facilitatorHealth,
  facilitatorIsReachable,
  probeFacilitatorExpectedChainId,
  waitForFacilitatorJob,
} from "../helpers/facilitatorClient";
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
  DELAY_BALANCE_SYNC_MS,
  DELAY_MPC_DECRYPTION_MS,
  DELAY_MPC_EXTENDED_MS,
  delay,
  deployPrivateTokenGasless,
  getGcAclContract,
  getOprfMintedHandlesFromReceipt,
} from "../helpers/testHelpers";

dotenv.config();

const ARBITRUM_SEPOLIA_CHAIN_ID = 421614n;
const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const NOTE_AMOUNT = 50n * 10n ** 18n;
const PAY_AMOUNT = 10n ** 17n; // 0.1
const INSERT_TTL_SECONDS = 365n * 24n * 60n * 60n;
/** Must match facilitator EIP3009_NAME (default TestUSD) and MockEIP3009Token name. */
const EIP3009_TOKEN_NAME = process.env.FACILITATOR_EIP3009_NAME || "TestUSD";
const EIP3009_TOKEN_VERSION = process.env.FACILITATOR_EIP3009_VERSION || "2";
const EIP3009_VALID_SLACK_SECONDS = Number(process.env.FACILITATOR_EIP3009_MIN_SLACK_SECONDS || "3600");

function shouldSkipLiveSuite(): boolean {
  return (
    (!process.env.QUICKNODE_ARBITRUM_SEPOLIA_URL && !process.env.ALCHEMY_API_KEY) ||
    !process.env.MNEMONIC
  );
}

async function waitForEthBalance(address: string, minWei: bigint, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const bal = await hre.ethers.provider.getBalance(address);
    if (bal >= minWei) {
      return bal;
    }
    await delay(2000);
  }
  throw new Error(`Timed out waiting for ETH balance >= ${minWei} at ${address}`);
}

describe("Safe OPRF spend via HTTP facilitator service (Arbitrum Sepolia)", function () {
  this.timeout(900000);

  let owner: any;
  let agent: Wallet;
  let destination: Wallet;
  let master: Wallet;
  let ownerAesKey: Buffer;
  let ownerAesKeyHex: string;
  let agentAesKey: Buffer;
  let agentAesKeyHex: string;
  let mockToken: any;
  let privateToken: any;
  let safeAddress: string;
  let decryptedX: bigint;
  let decryptedY: bigint;
  let decryptedQ: bigint;
  let networkChainId: number;

  before(async function () {
    if (shouldSkipLiveSuite()) {
      this.skip();
    }

    const network = await hre.ethers.provider.getNetwork();
    networkChainId = Number(network.chainId);
    if (network.chainId !== ARBITRUM_SEPOLIA_CHAIN_ID) {
      this.skip();
    }

    if (!(await facilitatorIsReachable())) {
      this.skip();
    }

    const expectedChainId = await probeFacilitatorExpectedChainId();
    if (expectedChainId !== networkChainId) {
      throw new Error(
        `Facilitator CHAIN_ID is ${expectedChainId}, but Hardhat network is ${networkChainId}. ` +
          `Set facilitator-service CHAIN_ID=421614 (arb-sepolia) and restart the service.`
      );
    }

    const health = await facilitatorHealth();
    expect(health.data.service).to.equal("facilitator-service");

    [owner] = await hre.ethers.getSigners();
    destination = Wallet.createRandom();
    master = Wallet.createRandom();
    // Agent stays unfunded until facilitator faucet (gasless spend path).
    agent = Wallet.createRandom().connect(hre.ethers.provider);

    ownerAesKey = await getUserKeyViaProxy(owner as any, PROXY_URL);
    ownerAesKeyHex = ownerAesKey.toString("hex");
    agentAesKey = await getUserKeyViaProxy(agent as any, PROXY_URL);
    agentAesKeyHex = agentAesKey.toString("hex");

    const MockFactory = await hre.ethers.getContractFactory("MockEIP3009Token", owner);
    mockToken = await MockFactory.deploy(EIP3009_TOKEN_NAME, "TUSD", 18);
    await mockToken.waitForDeployment();

    privateToken = await deployPrivateTokenGasless(hre, owner, {
      underlyingAddress: await mockToken.getAddress(),
      ownerAddress: owner.address,
      masterAddress: master.address,
      name: "Facilitator Service Bubble Token",
      symbol: "fsBUB",
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
    await delay(DELAY_MPC_EXTENDED_MS);

    const mintHandles = getOprfMintedHandlesFromReceipt(receipt, privateToken);
    expect(mintHandles).to.not.be.undefined;

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
  });

  it("faucets the agent, then completes POST /v1/spend (redeem → unshield → EIP-3009)", async function () {
    const privateTokenAddress = await privateToken.getAddress();
    const underlyingAddress = await mockToken.getAddress();

    const faucet = await facilitatorFaucet({
      chainId: networkChainId,
      address: agent.address,
    });
    expect(faucet.success).to.equal(true);
    await waitForEthBalance(agent.address, 1n);

    const gcAcl = await getGcAclContract(hre, agent);
    const expiration = BigInt(Math.floor(Date.now() / 1000)) + INSERT_TTL_SECONDS;
    await (await gcAcl.permitFullInsertAccess(privateTokenAddress, expiration)).wait();
    expect(await gcAcl.isFullInsertPermitted(agent.address, privateTokenAddress)).to.equal(true);

    const tokenInput = [
      {
        x: buildUnsignedItUint128({
          value: decryptedX,
          userAddress: agent.address,
          userAesKeyHex: agentAesKeyHex,
          contractAddress: privateTokenAddress,
        }),
        q: buildUnsignedItUint256({
          value: decryptedQ,
          userAddress: agent.address,
          userAesKeyHex: agentAesKeyHex,
          contractAddress: privateTokenAddress,
        }),
        y_clear: decryptedY,
      },
    ];
    const amountIt = buildUnsignedItUint256({
      value: PAY_AMOUNT,
      userAddress: agent.address,
      userAesKeyHex: agentAesKeyHex,
      contractAddress: privateTokenAddress,
    });

    const innerRedeemData = privateToken.interface.encodeFunctionData("redeemManyToUnderlying", [
      tokenInput,
      amountIt,
      agent.address,
      false,
    ]);

    const tokenName = await privateToken.name();
    const executeValidBefore = BigInt(Math.floor(Date.now() / 1000) + EIP3009_VALID_SLACK_SECONDS);
    const executeAuth = await signExecuteWithAuthorization({
      signer: agent,
      token: privateTokenAddress,
      tokenName,
      chainId: networkChainId,
      from: agent.address,
      data: innerRedeemData,
      validBefore: executeValidBefore,
    });

    const validBefore = BigInt(Math.floor(Date.now() / 1000) + EIP3009_VALID_SLACK_SECONDS);
    const authorization = await signEip3009TransferWithAuthorization({
      signer: agent,
      token: underlyingAddress,
      tokenName: EIP3009_TOKEN_NAME,
      tokenVersion: EIP3009_TOKEN_VERSION,
      chainId: networkChainId,
      from: agent.address,
      to: destination.address,
      value: PAY_AMOUNT,
      validBefore,
      nonce: "0x" + randomBytes(32).toString("hex"),
    });

    const destBefore = await mockToken.balanceOf(destination.address);
    const agentBefore = await mockToken.balanceOf(agent.address);

    const { status, body } = await facilitatorCreateSpend({
      chainId: networkChainId,
      idempotencyKey: randomUUID(),
      redeem: {
        privateToken: privateTokenAddress,
        to: privateTokenAddress,
        data: innerRedeemData,
        expectedRecipient: agent.address,
        tokenName,
        authorization: {
          from: executeAuth.from,
          validAfter: executeAuth.validAfter.toString(),
          validBefore: executeAuth.validBefore.toString(),
          nonce: executeAuth.nonce,
          signature: executeAuth.signature,
        },
      },
      transfer: {
        token: underlyingAddress,
        authorization,
      },
    });

    expect(status, JSON.stringify(body)).to.equal(202);
    expect(body.success).to.equal(true);
    const jobId = (body as any).data.jobId as string;
    expect(jobId).to.be.a("string").and.not.empty;

    const job = await waitForFacilitatorJob(jobId, {
      timeoutMs: 600_000,
      pollIntervalMs: 4_000,
    });

    expect(
      job.status,
      `job failed: ${JSON.stringify(job)}`
    ).to.equal("succeeded");
    expect(job.steps.redeem?.status).to.equal("mined");
    expect(job.steps.unshield?.status).to.equal("mined");
    expect(job.steps.transfer?.status).to.equal("mined");
    expect(job.steps.redeem?.txHash).to.match(/^0x[a-fA-F0-9]{64}$/);
    expect(job.steps.transfer?.txHash).to.match(/^0x[a-fA-F0-9]{64}$/);

    expect(await mockToken.balanceOf(destination.address)).to.equal(destBefore + PAY_AMOUNT);
    expect(await mockToken.balanceOf(agent.address)).to.equal(agentBefore);
  });
});
