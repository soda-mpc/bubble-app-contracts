/**
 * Safe + PrivateERC20 integration on Arbitrum Sepolia (chain 421614).
 *
 * Simulates bubble's smart-account pattern:
 * - Safe holds encrypted balances (msg.sender == Safe)
 * - EOA keeps the MPC user key
 * - Safe grants view via GCACL.permit(handle, eoa)
 * - Encrypted transfers use IT bound to EOA (tx.origin == EOA when owner executes Safe tx)
 * - OPRF named send: mintOPRFToken, splitTokenForRecipient (on-chain link to recipient), burnToken
 *   Bearer-note anonymity (no Safe↔agent edge) lives in safe-oprf-facilitator.arbitrum-sepolia.test.ts
 *
 * Run:
 *   cd wallet
 *   npm run test:safe:bubble:arbitrum-sepolia
 *
 * Env:
 *   MNEMONIC, ALCHEMY_API_KEY (or QUICKNODE_ARBITRUM_SEPOLIA_URL)
 *   PROXY_URL (default https://proxy.bubble.sodalabs.net)
 *   SAFE_ADDRESS (optional — reuse an existing 1-of-1 Safe owned by signer[0])
 */
import { expect } from "chai";
import hre from "hardhat";
import dotenv from "dotenv";

import { decryptMultipleValuesViaProxy, decryptValueViaProxy, getUserKeyViaProxy, prepareMessageForBubble256 } from "../helpers/bubbleCryptoTransport";
import {
  execSafeBurnToken,
  execSafeClearTransfer,
  execSafeEncryptedTransfer,
  execSafeErc20Approve,
  execSafeMintOprfToken,
  execSafePermitHandleView,
  execSafePermitHandleViews,
  execSafeRedeemMany,
  execSafeShield,
  execSafeSplitTokenForRecipient,
  getOrDeploySafeInfrastructure,
  mintUnderlyingToSafe,
  resolveSafeForTests,
} from "../helpers/safeBubbleHelpers";
import {
  buildUnsignedItUint128,
  buildUnsignedItUint256,
  createRandomWalletsAndFund,
  decryptHandleForOwnerViaProxy,
  delay,
  DELAY_BALANCE_SYNC_MS,
  DELAY_MPC_DECRYPTION_MS,
  DELAY_MPC_EXTENDED_MS,
  DELAY_MPC_PROCESSING_MS,
  deployMockToken,
  deployPrivateToken,
  expectDecryptViaProxyToFail,
  findParsedLogInReceipt,
  findParsedLogsInReceipt,
  getGcAclContract,
  getOprfMintedEventsFromReceipt,
  getOprfMintedHandlesFromReceipt,
  getPrivateTokenBalance,
} from "../helpers/testHelpers";

dotenv.config();

const ARBITRUM_SEPOLIA_CHAIN_ID = 421614n;
const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const CLEAR_TRANSFER_AMOUNT = 3n * 10n ** 18n;
const ENCRYPTED_TRANSFER_AMOUNT = 5n * 10n ** 18n;
function shouldSkipLiveSuite(): boolean {
  return (
    (!process.env.QUICKNODE_ARBITRUM_SEPOLIA_URL && !process.env.ALCHEMY_API_KEY) ||
    !process.env.MNEMONIC
  );
}

describe("Safe + PrivateERC20 on Arbitrum Sepolia", function () {
  this.timeout(600000);

  let owner: any;
  let recipient: any;
  let master: any;
  let ownerAesKey: Buffer;
  let ownerAesKeyHex: string;
  let mockToken: any;
  let privateToken: any;
  let safeAddress: string;

  before(async function () {
    if (shouldSkipLiveSuite()) {
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

    ownerAesKey = await getUserKeyViaProxy(owner as any, PROXY_URL);
    ownerAesKeyHex = ownerAesKey.toString("hex");

    mockToken = await deployMockToken(hre, owner, "Safe Test USDC", "STUSDC");
    privateToken = await deployPrivateToken(hre, owner, {
      underlyingAddress: await mockToken.getAddress(),
      ownerAddress: owner.address,
      masterAddress: master.address,
      name: "Safe Bubble Token",
      symbol: "sBUB",
    });

    const deployedSafe = await resolveSafeForTests(hre, owner.address, owner);
    safeAddress = deployedSafe.safeAddress;
  });

  describe("Safe infrastructure", function () {
    it("resolves canonical SafeL2 + factory on Arbitrum Sepolia", async function () {
      const infrastructure = await getOrDeploySafeInfrastructure(hre);
      expect(infrastructure.source).to.equal("canonical");
      expect(infrastructure.safeL2Address).to.properAddress;
      expect(infrastructure.factoryAddress).to.properAddress;
    });

    it("creates or reuses a 1-of-1 Safe owned by the test EOA", async function () {
      const safe = await hre.ethers.getContractAt(
        ["function getOwners() view returns (address[])", "function getThreshold() view returns (uint256)"],
        safeAddress
      );
      expect(await safe.getThreshold()).to.equal(1n);
      expect(await safe.getOwners()).to.deep.equal([owner.address]);
    });
  });

  describe("Shield via Safe execTransaction", function () {
    const shieldAmount = 25n * 10n ** 18n;

    before(async function () {
      await mintUnderlyingToSafe(mockToken, safeAddress, shieldAmount);
      await execSafeErc20Approve(
        safeAddress,
        owner,
        await mockToken.getAddress(),
        await privateToken.getAddress(),
        shieldAmount
      );
      await delay(DELAY_BALANCE_SYNC_MS);
      await execSafeShield(safeAddress, owner, await privateToken.getAddress(), shieldAmount);
      await delay(DELAY_MPC_PROCESSING_MS);
    });

    it("credits encrypted balance to the Safe address", async function () {
      const handle = await privateToken["balanceOf(address)"](safeAddress);
      expect(handle).to.not.equal(0n);
    });

    it("does not let an unrelated account decrypt the Safe balance before view is granted", async function () {
      const handle = await privateToken["balanceOf(address)"](safeAddress);
      const recipientAesKey = await getUserKeyViaProxy(recipient as any, PROXY_URL);
      await expectDecryptViaProxyToFail(handle, recipient, recipientAesKey, PROXY_URL);
    });

    it("lets the owner decrypt after Safe grants GCACL.permit(handle, owner)", async function () {
      const handle = await privateToken["balanceOf(address)"](safeAddress);
      await execSafePermitHandleView(hre, safeAddress, owner, owner.address, handle);
      await delay(DELAY_MPC_DECRYPTION_MS);

      const gcAcl = await getGcAclContract(hre, owner);
      expect(await gcAcl.isPermitted(handle, owner.address)).to.equal(true);

      const decrypted = await getPrivateTokenBalance({
        privateToken,
        address: safeAddress,
        signer: owner,
        aesKey: ownerAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(decrypted).to.equal(shieldAmount);
    });

    it("supports on-behalf decrypt with owner=Safe when isPermittedToView is set", async function () {
      const handle = await privateToken["balanceOf(address)"](safeAddress);
      const gcAcl = await getGcAclContract(hre, owner);
      const canViewOnBehalf = await gcAcl.isPermittedToView(safeAddress, owner.address, handle);

      if (!canViewOnBehalf) {
        // gcAcl.permit(handle, viewer) grants handle-level decrypt; on-behalf view needs
        // ACL.permitFullViewAccess(Safe → EOA) — add when bundler/AA path is required.
        this.skip();
      }

      const decrypted = await decryptHandleForOwnerViaProxy({
        privateToken,
        ownerAddress: safeAddress,
        viewer: owner,
        viewerAesKey: ownerAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(decrypted).to.equal(shieldAmount);
    });
  });

  describe("Transfer via Safe execTransaction", function () {
    it("transfers clear amount from Safe to recipient", async function () {
      const privateTokenAddress = await privateToken.getAddress();
      const { receipt } = await execSafeClearTransfer(
        safeAddress,
        owner,
        privateTokenAddress,
        recipient.address,
        CLEAR_TRANSFER_AMOUNT
      );
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
      expect(recipientBalance).to.equal(CLEAR_TRANSFER_AMOUNT);
    });

    it("transfers encrypted amount from Safe using IT bound to owner EOA", async function () {
      const privateTokenAddress = await privateToken.getAddress();
      const { encryptedHigh, encryptedLow } = prepareMessageForBubble256(
        ENCRYPTED_TRANSFER_AMOUNT,
        owner.address,
        ownerAesKeyHex,
        privateTokenAddress
      );

      const { receipt } = await execSafeEncryptedTransfer(
        safeAddress,
        owner,
        privateTokenAddress,
        recipient.address,
        {
          userAddress: owner.address,
          ciphertext: { ciphertextHigh: encryptedHigh, ciphertextLow: encryptedLow },
        }
      );
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
      expect(recipientBalance).to.equal(CLEAR_TRANSFER_AMOUNT + ENCRYPTED_TRANSFER_AMOUNT);
    });
  });

  describe("OPRF named split via Safe", function () {
    this.timeout(900000);

    const oprfShieldAmount = 40n * 10n ** 18n;
    const oprfQuantity = 30n * 10n ** 18n;
    const qSplit = 12n * 10n ** 18n;

    let mintReceipt: { status?: number | null; logs?: readonly unknown[] } | null;
    let decryptedX: bigint;
    let decryptedY: bigint;
    let decryptedQ: bigint;
    let paymentX: bigint;
    let paymentQ: bigint;
    let decryptedYPay: bigint;
    let remainderX: bigint;
    let remainderQ: bigint;
    let decryptedYRemainder: bigint;

    before(async function () {
      const privateTokenAddress = await privateToken.getAddress();
      await mintUnderlyingToSafe(mockToken, safeAddress, oprfShieldAmount);
      await execSafeErc20Approve(
        safeAddress,
        owner,
        await mockToken.getAddress(),
        privateTokenAddress,
        oprfShieldAmount
      );
      await delay(DELAY_BALANCE_SYNC_MS);
      await execSafeShield(safeAddress, owner, privateTokenAddress, oprfShieldAmount);
      await delay(DELAY_MPC_EXTENDED_MS);
    });

    it("anonymizes Safe private balance into an OPRF token (mintOPRFToken)", async function () {
      const privateTokenAddress = await privateToken.getAddress();
      const quantityIt = buildUnsignedItUint256({
        value: oprfQuantity,
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
      expect(receipt?.status).to.equal(1);
      await delay(DELAY_MPC_EXTENDED_MS);

      const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
      expect(mintHandles).to.not.be.undefined;

      const mintEvents = getOprfMintedEventsFromReceipt(mintReceipt, privateToken);
      expect(mintEvents[0]?.user.toLowerCase()).to.equal(safeAddress.toLowerCase());

      const { xHandle, yHandle, qHandle } = mintHandles!;
      await execSafePermitHandleViews(hre, safeAddress, owner, owner.address, [xHandle, yHandle, qHandle]);
      await delay(DELAY_MPC_DECRYPTION_MS);

      [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
        [xHandle, yHandle, qHandle],
        owner,
        ownerAesKey,
        PROXY_URL
      );
      expect(decryptedQ).to.equal(oprfQuantity);
      expect(decryptedX).to.not.equal(0n);
      expect(decryptedY).to.not.equal(0n);
    });

    it("splits on-chain to a named recipient via splitTokenForRecipient", async function () {
      const privateTokenAddress = await privateToken.getAddress();
      const xIt = buildUnsignedItUint128({
        value: decryptedX,
        userAddress: owner.address,
        userAesKeyHex: ownerAesKeyHex,
        contractAddress: privateTokenAddress,
      });
      const qIt = buildUnsignedItUint256({
        value: decryptedQ,
        userAddress: owner.address,
        userAesKeyHex: ownerAesKeyHex,
        contractAddress: privateTokenAddress,
      });
      const qSplitIt = buildUnsignedItUint256({
        value: qSplit,
        userAddress: owner.address,
        userAesKeyHex: ownerAesKeyHex,
        contractAddress: privateTokenAddress,
      });

      const { receipt } = await execSafeSplitTokenForRecipient(safeAddress, owner, privateTokenAddress, {
        xIt,
        qIt,
        yClear: decryptedY,
        qSplitIt,
        recipient: recipient.address,
      });
      expect(receipt?.status).to.equal(1);
      await delay(DELAY_MPC_EXTENDED_MS);

      const splitEvent = findParsedLogInReceipt(receipt, privateToken, "OPRFSplitForRecipient");
      expect(splitEvent).to.not.be.undefined;
      const splitDecoded = privateToken.interface.parseLog(splitEvent!);
      expect(splitDecoded?.args[0].toLowerCase()).to.equal(safeAddress.toLowerCase());
      expect(splitDecoded?.args[1].toLowerCase()).to.equal(recipient.address.toLowerCase());

      const oprfMintedEvents = getOprfMintedEventsFromReceipt(receipt, privateToken);
      const remainderEvent = oprfMintedEvents.find((e) => e.user.toLowerCase() === safeAddress.toLowerCase());
      const paymentEvent = oprfMintedEvents.find((e) => e.user.toLowerCase() === recipient.address.toLowerCase());
      expect(remainderEvent).to.not.be.undefined;
      expect(paymentEvent).to.not.be.undefined;

      remainderX = remainderEvent!.x;
      remainderQ = remainderEvent!.q;
      paymentX = paymentEvent!.x;
      paymentQ = paymentEvent!.q;

      await execSafePermitHandleViews(hre, safeAddress, owner, owner.address, [
        remainderX,
        remainderQ,
        remainderEvent!.y,
      ]);
      await delay(DELAY_MPC_DECRYPTION_MS);

      const decryptedQRemainder = await decryptValueViaProxy(remainderQ, owner, ownerAesKey, PROXY_URL);
      expect(decryptedQRemainder).to.equal(oprfQuantity - qSplit);
      decryptedYRemainder = await decryptValueViaProxy(remainderEvent!.y, owner, ownerAesKey, PROXY_URL);

      const recipientAesKey = await getUserKeyViaProxy(recipient as any, PROXY_URL);
      const decryptedQPay = await decryptValueViaProxy(paymentQ, recipient, recipientAesKey, PROXY_URL);
      expect(decryptedQPay).to.equal(qSplit);
      decryptedYPay = await decryptValueViaProxy(paymentEvent!.y, recipient, recipientAesKey, PROXY_URL);
    });

    it("deanonymizes recipient OPRF token into private balance (burnToken)", async function () {
      const privateTokenAddress = await privateToken.getAddress();
      const recipientAesKey = await getUserKeyViaProxy(recipient as any, PROXY_URL);
      const recipientAesKeyHex = recipientAesKey.toString("hex");
      const recipientBalanceBefore = await getPrivateTokenBalance({
        privateToken,
        address: recipient.address,
        signer: recipient,
        aesKey: recipientAesKey,
        proxyUrl: PROXY_URL,
      });

      const [decryptedXPay, decryptedQPay] = await decryptMultipleValuesViaProxy(
        [paymentX, paymentQ],
        recipient,
        recipientAesKey,
        PROXY_URL
      );
      expect(decryptedQPay).to.equal(qSplit);

      const xIt = buildUnsignedItUint128({
        value: decryptedXPay,
        userAddress: recipient.address,
        userAesKeyHex: recipientAesKeyHex,
        contractAddress: privateTokenAddress,
      });
      const qIt = buildUnsignedItUint256({
        value: decryptedQPay,
        userAddress: recipient.address,
        userAesKeyHex: recipientAesKeyHex,
        contractAddress: privateTokenAddress,
      });

      const burnTx = await privateToken.connect(recipient).burnToken(
        xIt,
        qIt,
        decryptedYPay,
        recipient.address
      );
      const burnReceipt = await burnTx.wait();
      expect(burnReceipt?.status).to.equal(1);
      await delay(DELAY_MPC_EXTENDED_MS);

      const burnEvent = findParsedLogInReceipt(burnReceipt, privateToken, "OPRFBurned");
      expect(burnEvent).to.not.be.undefined;

      const recipientBalance = await getPrivateTokenBalance({
        privateToken,
        address: recipient.address,
        signer: recipient,
        aesKey: recipientAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(recipientBalance).to.equal(recipientBalanceBefore + qSplit);
    });

    it("deanonymizes Safe OPRF remainder back to Safe private balance", async function () {
      const privateTokenAddress = await privateToken.getAddress();

      const [decryptedXRemainder, decryptedQRemainder] = await decryptMultipleValuesViaProxy(
        [remainderX, remainderQ],
        owner,
        ownerAesKey,
        PROXY_URL
      );
      expect(decryptedQRemainder).to.equal(oprfQuantity - qSplit);

      const xIt = buildUnsignedItUint128({
        value: decryptedXRemainder,
        userAddress: owner.address,
        userAesKeyHex: ownerAesKeyHex,
        contractAddress: privateTokenAddress,
      });
      const qIt = buildUnsignedItUint256({
        value: decryptedQRemainder,
        userAddress: owner.address,
        userAesKeyHex: ownerAesKeyHex,
        contractAddress: privateTokenAddress,
      });

      const { receipt } = await execSafeBurnToken(safeAddress, owner, privateTokenAddress, {
        xIt,
        qIt,
        yClear: decryptedYRemainder,
        recipient: safeAddress,
      });
      expect(receipt?.status).to.equal(1);
      await delay(DELAY_MPC_EXTENDED_MS);

      const balanceHandle = await privateToken["balanceOf(address)"](safeAddress);
      expect(balanceHandle).to.not.equal(0n);
      await execSafePermitHandleView(hre, safeAddress, owner, owner.address, balanceHandle);
      await delay(DELAY_MPC_DECRYPTION_MS);

      const safeBalance = await getPrivateTokenBalance({
        privateToken,
        address: safeAddress,
        signer: owner,
        aesKey: ownerAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(safeBalance).to.be.greaterThan(0n);
    });

    it("redeems via Safe execTransaction and credits remainder OPRF to the Safe", async function () {
      const privateTokenAddress = await privateToken.getAddress();
      const redeemQuantity = 8n * 10n ** 18n;
      const redeemAmount = 3n * 10n ** 18n;

      const quantityIt = buildUnsignedItUint256({
        value: redeemQuantity,
        userAddress: owner.address,
        userAesKeyHex: ownerAesKeyHex,
        contractAddress: privateTokenAddress,
      });
      const { receipt: mintReceipt } = await execSafeMintOprfToken(
        safeAddress,
        owner,
        privateTokenAddress,
        quantityIt
      );
      expect(mintReceipt?.status).to.equal(1);
      await delay(DELAY_MPC_EXTENDED_MS);

      const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
      expect(mintHandles).to.not.be.undefined;
      await execSafePermitHandleViews(hre, safeAddress, owner, owner.address, [
        mintHandles!.xHandle,
        mintHandles!.yHandle,
        mintHandles!.qHandle,
      ]);
      await delay(DELAY_MPC_DECRYPTION_MS);

      const [mintedX, mintedY, mintedQ] = await decryptMultipleValuesViaProxy(
        [mintHandles!.xHandle, mintHandles!.yHandle, mintHandles!.qHandle],
        owner,
        ownerAesKey,
        PROXY_URL
      );
      expect(mintedQ).to.equal(redeemQuantity);

      const { receipt: redeemReceipt } = await execSafeRedeemMany(safeAddress, owner, privateTokenAddress, {
        tokens: [
          {
            xIt: buildUnsignedItUint128({
              value: mintedX,
              userAddress: owner.address,
              userAesKeyHex: ownerAesKeyHex,
              contractAddress: privateTokenAddress,
            }),
            qIt: buildUnsignedItUint256({
              value: mintedQ,
              userAddress: owner.address,
              userAesKeyHex: ownerAesKeyHex,
              contractAddress: privateTokenAddress,
            }),
            yClear: mintedY,
          },
        ],
        amountIt: buildUnsignedItUint256({
          value: redeemAmount,
          userAddress: owner.address,
          userAesKeyHex: ownerAesKeyHex,
          contractAddress: privateTokenAddress,
        }),
        recipient: recipient.address,
      });
      expect(redeemReceipt?.status).to.equal(1);
      await delay(DELAY_MPC_EXTENDED_MS);

      const mintedEvents = getOprfMintedEventsFromReceipt(redeemReceipt, privateToken);
      const remainderEvent = mintedEvents.find((e) => e.user.toLowerCase() === safeAddress.toLowerCase());
      expect(remainderEvent).to.not.be.undefined;
      expect(mintedEvents.some((e) => e.user.toLowerCase() === owner.address.toLowerCase())).to.equal(false);

      const invalidated = findParsedLogsInReceipt(redeemReceipt, privateToken, "OPRFTokenInvalidated");
      expect(invalidated.length).to.be.greaterThan(0);
      for (const log of invalidated) {
        const decoded = privateToken.interface.parseLog(log);
        expect(decoded?.args[0].toLowerCase()).to.equal(safeAddress.toLowerCase());
      }

      await execSafePermitHandleViews(hre, safeAddress, owner, owner.address, [
        remainderEvent!.x,
        remainderEvent!.y,
        remainderEvent!.q,
      ]);
      await delay(DELAY_MPC_DECRYPTION_MS);
      const remainderQ = await decryptValueViaProxy(remainderEvent!.q, owner, ownerAesKey, PROXY_URL);
      expect(remainderQ).to.equal(redeemQuantity - redeemAmount);
    });
  });
});

describe("Safe + PrivateERC20 network guard", function () {
  it("skips when not invoked with --network sepolia-arbitrum", async function () {
    const network = await hre.ethers.provider.getNetwork();
    if (network.chainId === ARBITRUM_SEPOLIA_CHAIN_ID) {
      return;
    }
    expect(network.chainId).to.not.equal(ARBITRUM_SEPOLIA_CHAIN_ID);
  });
});
