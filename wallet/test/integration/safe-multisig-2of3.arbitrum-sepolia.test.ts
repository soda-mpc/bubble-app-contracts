/**
 * 2-of-3 Safe + Bubble on Arbitrum Sepolia.
 *
 * Requirements:
 *   - Co-signers inspect Safe calldata before signing (clear args + locally opened ITs).
 *   - Every owner decrypts the Safe private balance with their own onboarded key
 *     after Safe grants GCACL.permitContractViewAccess (batched via MultiSend).
 *
 * Shared AES (owner A's user key) is copied to B and C off-chain so they can open ITs.
 * Personal AES keys are used for encrypt-to-user vault decrypt (owner=Safe).
 *
 * Run:
 *   cd wallet
 *   npm run test:safe:multisig:arbitrum-sepolia
 */
import { expect } from "chai";
import { Wallet } from "ethers";
import hre from "hardhat";
import dotenv from "dotenv";

import { getUserKeyViaProxy, decryptValueViaProxy } from "../helpers/bubbleCryptoTransport";
import {
  assertInformedApprove,
  assertInformedEncryptedTransfer,
  assertInformedPermitContractView,
  assertInformedShield,
  encodeApprove,
  encodeEncryptedTransfer,
  encodePermitContractView,
  encodeShield,
} from "../helpers/safeInformedSign";
import { mintUnderlyingToSafe } from "../helpers/safeBubbleHelpers";
import { deploySafeWallet, execSafeTransaction, execSafeTransactions } from "../helpers/safeHelpers";
import {
  buildUnsignedItUint256,
  DELAY_MPC_DECRYPTION_MS,
  DELAY_MPC_PROCESSING_MS,
  delay,
  decryptHandleForOwnerViaProxy,
  deployMockToken,
  deployPrivateToken,
  expectDecryptViaProxyToFail,
  fundWalletsForGas,
  getGcAclAddress,
  getGcAclContract,
  getPrivateTokenBalance,
} from "../helpers/testHelpers";

dotenv.config();

const ARBITRUM_SEPOLIA_CHAIN_ID = 421614n;
const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const SHIELD_AMOUNT = 25n * 10n ** 18n;
const TRANSFER_AMOUNT = 5n * 10n ** 18n;
const VIEW_TTL_SECONDS = 365n * 24n * 60n * 60n;

function shouldSkipLiveSuite(): boolean {
  return (
    (!process.env.QUICKNODE_ARBITRUM_SEPOLIA_URL && !process.env.ALCHEMY_API_KEY) ||
    !process.env.MNEMONIC
  );
}

describe("Safe 2-of-3 + PrivateERC20 on Arbitrum Sepolia", function () {
  this.timeout(900000);

  let ownerA: any;
  let ownerB: Wallet;
  let ownerC: Wallet;
  let recipient: Wallet;
  let master: Wallet;
  let ownerAAesKey: Buffer;
  let ownerBAesKey: Buffer;
  let ownerCAesKey: Buffer;
  let sharedAesKey: Buffer;
  let sharedAesKeyHex: string;
  let mockToken: any;
  let privateToken: any;
  let privateTokenAddress: string;
  let safeAddress: string;
  let extraSigners: Wallet[];

  before(async function () {
    if (shouldSkipLiveSuite()) {
      this.skip();
    }

    const network = await hre.ethers.provider.getNetwork();
    if (network.chainId !== ARBITRUM_SEPOLIA_CHAIN_ID) {
      this.skip();
    }

    [ownerA] = await hre.ethers.getSigners();
    ownerB = Wallet.createRandom().connect(hre.ethers.provider);
    ownerC = Wallet.createRandom().connect(hre.ethers.provider);
    recipient = Wallet.createRandom().connect(hre.ethers.provider);
    master = Wallet.createRandom();
    extraSigners = [ownerB];

    // B/C only EIP-712-sign; tiny ETH keeps wallets usable if a path needs gas later.
    await fundWalletsForGas({
      sender: ownerA,
      recipients: [ownerB.address, ownerC.address],
      amountWei: hre.ethers.parseEther("0.002"),
    });

    ownerAAesKey = await getUserKeyViaProxy(ownerA as any, PROXY_URL);
    ownerBAesKey = await getUserKeyViaProxy(ownerB as any, PROXY_URL);
    ownerCAesKey = await getUserKeyViaProxy(ownerC as any, PROXY_URL);
    sharedAesKey = ownerAAesKey;
    sharedAesKeyHex = ownerAAesKey.toString("hex");

    mockToken = await deployMockToken(hre, ownerA, "Multisig Test USDC", "MTUSDC");
    privateToken = await deployPrivateToken(hre, ownerA, {
      underlyingAddress: await mockToken.getAddress(),
      ownerAddress: ownerA.address,
      masterAddress: master.address,
      name: "Multisig Bubble Token",
      symbol: "mBUB",
    });
    privateTokenAddress = await privateToken.getAddress();

    const deployed = await deploySafeWallet(
      hre,
      [ownerA.address, ownerB.address, ownerC.address],
      2,
      BigInt(Date.now())
    );
    safeAddress = deployed.safeAddress;
    expect(await deployed.safe.getThreshold()).to.equal(2n);
    expect(await deployed.safe.getOwners()).to.have.length(3);
  });

  async function execInspected(
    to: string,
    data: string
  ): Promise<{ receipt: { status?: number | null }; safeTx: { data: string } }> {
    return execSafeTransaction(safeAddress, ownerA, { to, data }, { extraSigners });
  }

  it("lets B refuse a mutated IT amount before signing", async function () {
    const quantityIt = buildUnsignedItUint256({
      value: TRANSFER_AMOUNT,
      userAddress: ownerA.address,
      userAesKeyHex: sharedAesKeyHex,
      contractAddress: privateTokenAddress,
    });
    const data = encodeEncryptedTransfer(recipient.address, quantityIt);
    const opened = assertInformedEncryptedTransfer({
      data,
      sharedAesKey,
      expectedRecipient: recipient.address,
      expectedAmount: TRANSFER_AMOUNT,
      expectedUserAddress: ownerA.address,
    });
    expect(opened.amount).to.equal(TRANSFER_AMOUNT);

    expect(() =>
      assertInformedEncryptedTransfer({
        data,
        sharedAesKey,
        expectedRecipient: recipient.address,
        expectedAmount: TRANSFER_AMOUNT + 1n,
        expectedUserAddress: ownerA.address,
      })
    ).to.throw("Signer refuses");
  });

  describe("after 2-of-3 shield and view grants", function () {
    before(async function () {
      await mintUnderlyingToSafe(mockToken, safeAddress, SHIELD_AMOUNT);

      // One Safe MultiSend = one 2-of-3 signature round:
      // approve + shield + permitContractViewAccess(A,B,C).
      const mockTokenAddress = await mockToken.getAddress();
      const gcAclAddress = getGcAclAddress(Number(ARBITRUM_SEPOLIA_CHAIN_ID));
      const expiration = BigInt(Math.floor(Date.now() / 1000)) + VIEW_TTL_SECONDS;

      const approveData = encodeApprove(privateTokenAddress, SHIELD_AMOUNT);
      assertInformedApprove(approveData, privateTokenAddress, SHIELD_AMOUNT);

      const shieldData = encodeShield(SHIELD_AMOUNT);
      assertInformedShield(shieldData, SHIELD_AMOUNT);

      const viewers = [ownerA.address, ownerB.address, ownerC.address];
      const permitCalls = viewers.map((viewer) => {
        const data = encodePermitContractView(viewer, privateTokenAddress, expiration);
        assertInformedPermitContractView(data, viewer, privateTokenAddress);
        return { to: gcAclAddress, data };
      });

      await execSafeTransactions(
        safeAddress,
        ownerA,
        [
          { to: mockTokenAddress, data: approveData },
          { to: privateTokenAddress, data: shieldData },
          ...permitCalls,
        ],
        { extraSigners }
      );
      await delay(DELAY_MPC_PROCESSING_MS);
      await delay(DELAY_MPC_DECRYPTION_MS);
    });

    it("lets every owner decrypt the same Safe private balance", async function () {
      const handle = await privateToken["balanceOf(address)"](safeAddress);
      expect(handle).to.not.equal(0n);

      const gcAcl = await getGcAclContract(hre, ownerA);
      for (const viewer of [ownerA.address, ownerB.address, ownerC.address]) {
        expect(await gcAcl.isContractViewPermitted(safeAddress, viewer, privateTokenAddress)).to.equal(true);
        expect(await gcAcl.isPermittedToView(safeAddress, viewer, handle)).to.equal(true);
      }

      const decryptedA = await decryptHandleForOwnerViaProxy({
        privateToken,
        ownerAddress: safeAddress,
        viewer: ownerA,
        viewerAesKey: ownerAAesKey,
        proxyUrl: PROXY_URL,
      });
      const decryptedB = await decryptHandleForOwnerViaProxy({
        privateToken,
        ownerAddress: safeAddress,
        viewer: ownerB,
        viewerAesKey: ownerBAesKey,
        proxyUrl: PROXY_URL,
      });
      const decryptedC = await decryptHandleForOwnerViaProxy({
        privateToken,
        ownerAddress: safeAddress,
        viewer: ownerC,
        viewerAesKey: ownerCAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(decryptedA).to.equal(SHIELD_AMOUNT);
      expect(decryptedB).to.equal(SHIELD_AMOUNT);
      expect(decryptedC).to.equal(SHIELD_AMOUNT);
      expect(decryptedA).to.equal(decryptedB);
      expect(decryptedB).to.equal(decryptedC);

      const outsiderAesKey = await getUserKeyViaProxy(recipient as any, PROXY_URL);
      await expectDecryptViaProxyToFail(handle, recipient, outsiderAesKey, PROXY_URL);
      try {
        await decryptValueViaProxy(handle, recipient, outsiderAesKey, PROXY_URL, safeAddress);
        expect.fail("outsider on-behalf decrypt should fail without Safe view grant");
      } catch {
        // expected
      }
    });

    it("transfers encrypted amount after B opens the IT with the shared key", async function () {
      const quantityIt = buildUnsignedItUint256({
        value: TRANSFER_AMOUNT,
        userAddress: ownerA.address,
        userAesKeyHex: sharedAesKeyHex,
        contractAddress: privateTokenAddress,
      });
      const data = encodeEncryptedTransfer(recipient.address, quantityIt);
      assertInformedEncryptedTransfer({
        data,
        sharedAesKey,
        expectedRecipient: recipient.address,
        expectedAmount: TRANSFER_AMOUNT,
        expectedUserAddress: ownerA.address,
      });

      const { receipt } = await execInspected(privateTokenAddress, data);
      expect(receipt?.status).to.equal(1);
      await delay(DELAY_MPC_PROCESSING_MS);

      const recipientAesKey = await getUserKeyViaProxy(recipient as any, PROXY_URL);
      const recipientBalance = await getPrivateTokenBalance({
        privateToken,
        address: recipient.address,
        signer: recipient,
        aesKey: recipientAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(recipientBalance).to.equal(TRANSFER_AMOUNT);

      // Co-signer B re-reads the vault after the spend.
      const safeBalance = await decryptHandleForOwnerViaProxy({
        privateToken,
        ownerAddress: safeAddress,
        viewer: ownerB,
        viewerAesKey: ownerBAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(safeBalance).to.equal(SHIELD_AMOUNT - TRANSFER_AMOUNT);

      const safeBalanceC = await decryptHandleForOwnerViaProxy({
        privateToken,
        ownerAddress: safeAddress,
        viewer: ownerC,
        viewerAesKey: ownerCAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(safeBalanceC).to.equal(SHIELD_AMOUNT - TRANSFER_AMOUNT);
    });
  });
});

describe("Safe 2-of-3 network guard", function () {
  it("skips when not invoked with --network sepolia-arbitrum", async function () {
    const network = await hre.ethers.provider.getNetwork();
    if (network.chainId === ARBITRUM_SEPOLIA_CHAIN_ID) {
      return;
    }
    expect(network.chainId).to.not.equal(ARBITRUM_SEPOLIA_CHAIN_ID);
  });
});
