import { expect } from "chai";
import hre from "hardhat";
import { Wallet } from "ethers";
import dotenv from "dotenv";

import { decryptValueViaProxy, decryptMultipleValuesViaProxy, getUserKeyViaProxy } from "./helpers/bubbleCryptoTransport";
import {
  buildSignedItUint128,
  buildSignedItUint256,
  buildSignedOprfBurnPayloads,
  buildSignedOprfSplitPayloads,
  buildUnsignedItUint128,
  buildUnsignedItUint256,
  DELAY_BALANCE_SYNC_MS,
  DELAY_MPC_DECRYPTION_MS,
  DELAY_MPC_EXTENDED_MS,
  DELAY_MPC_PROCESSING_MS,
  DELAY_MPC_REDEEM_MS,
  DELAY_SHORT_MS,
  DELAY_STANDARD_MS,
  delay,
  deployMockToken,
  deployPrivateToken,
  findParsedLogInReceipt,
  findParsedLogInReceiptWhere,
  findParsedLogsInReceipt,
  getOprfMintedEventsFromReceipt,
  getOprfMintedHandlesFromReceipt,
  mintAndApprove,
  mintApproveAndShield,
  waitForUnshieldOutcome,
  waitForContractCode,
} from "./helpers/testHelpers";

dotenv.config();

const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC) {
  throw new Error("MNEMONIC environment variable is required");
}

describe("PrivateERC20Contract OPRF Minting", function () {
  // Increase timeout for all tests in this suite (MPC operations can take time)
  this.timeout(300000); // 300 seconds (5 minutes) - increased for redeemMany tests
  
  let userAesKey: Buffer;
  let userAesKeyHex: string;
  let userAddress: string;
  let privateToken: any;
  let mockToken: any;
  let defaultSigner: any;

  before(async function () {
    [defaultSigner] = await hre.ethers.getSigners();

    userAesKey = await getUserKeyViaProxy(defaultSigner as any, PROXY_URL);
    userAesKeyHex = userAesKey.toString("hex");
    userAddress = await defaultSigner.getAddress();

    mockToken = await deployMockToken(hre, defaultSigner);

    await delay(DELAY_STANDARD_MS);

    privateToken = await deployPrivateToken(hre, defaultSigner, {
      underlyingAddress: await mockToken.getAddress(),
      ownerAddress: defaultSigner.address,
      masterAddress: defaultSigner.address,
      name: "Test Private Token",
      symbol: "TPT",
    });

    const proxyAddress = await privateToken.getAddress();
    const code = await waitForContractCode(proxyAddress, hre);
    expect(code.length).to.be.greaterThan(2);

    await delay(DELAY_STANDARD_MS);

    const underlyingAmount = hre.ethers.parseEther("1000");
    await mintAndApprove({
      mockToken,
      privateToken,
      userAddress,
      amount: underlyingAmount,
    });

    const shieldAmount = hre.ethers.parseEther("100");
    await (await privateToken.shield(shieldAmount)).wait();

    await delay(DELAY_BALANCE_SYNC_MS);
  });

  describe("OPRF Token tests", function () {
    it("Should successfully mint OPRF tokens with encrypted parameters", async function () {

      const quantity = 50n;

      const quantityIT = await buildSignedItUint256({
        value: quantity,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });
      // Mint OPRF token
      const tx = await privateToken.mintOPRFToken(quantityIT);
      const receipt = await tx.wait();
      expect(receipt?.status).to.equal(1);

      await delay(DELAY_BALANCE_SYNC_MS);

      const event = findParsedLogInReceipt(receipt, privateToken, "OPRFMinted");

      expect(event).to.not.be.undefined;
      
      if (event) {
        const decoded = privateToken.interface.parseLog(event);
        expect(decoded?.args[0]).to.equal(userAddress);
        
        const xHandle = decoded?.args[1];
        const yHandle = decoded?.args[2];
        const qGTHandle = decoded?.args[3];
        
        expect(xHandle).to.not.be.undefined;
        expect(yHandle).to.not.be.undefined;
        expect(qGTHandle).to.not.be.undefined;

        await delay(DELAY_BALANCE_SYNC_MS);

        // Decrypt the values off-chain
        const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
          [xHandle, yHandle, qGTHandle],
          defaultSigner,
          userAesKey,
          PROXY_URL
        );
        
        // Verify the decrypted values are correct
        expect(decryptedX).to.not.equal(0n);
        expect(decryptedY).to.not.equal(0n);
        expect(decryptedQ).to.equal(quantity);
      }
    });

    it("Should mint OPRF tokens for actual transferred amount when insufficient balance", async function () {

      // Ensure user has enough private ERC20 balance for this test
      const additionalShieldAmount = hre.ethers.parseEther("50"); // Shield additional 50 tokens
      await mintApproveAndShield({
        mockToken,
        privateToken,
        recipient: userAddress,
        amount: additionalShieldAmount,
      });
      await delay(DELAY_STANDARD_MS); // Wait for MPC computation

      const requestedQuantity = 200n; // Try to mint more than user has
      
      // Prepare encrypted quantity parameter for the requested amount
      const quantityIT = await buildSignedItUint256({
        value: requestedQuantity,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });
      // Mint OPRF token - should succeed but mint for actual transferred amount
      const tx = await privateToken.mintOPRFToken(quantityIT);
      const receipt = await tx.wait();
      
      expect(receipt?.status).to.equal(1);
      
      // Add delay to allow MPC computation to complete
      await delay(DELAY_BALANCE_SYNC_MS);
      
      // Check that the OPRFMinted event was emitted
      const event = findParsedLogInReceipt(receipt, privateToken, "OPRFMinted");
      
      expect(event).to.not.be.undefined;
      
      if (event) {
        const decoded = privateToken.interface.parseLog(event);
        expect(decoded?.args[0]).to.equal(userAddress);
        
        // The x, y, and qGT values are encrypted handles
        const xHandle = decoded?.args[1];
        const yHandle = decoded?.args[2];
        const qGTHandle = decoded?.args[3];
        
        expect(xHandle).to.not.be.undefined;
        expect(yHandle).to.not.be.undefined;
        expect(qGTHandle).to.not.be.undefined;
        
        // Wait a bit more for MPC computation to complete before decryption
        await delay(DELAY_SHORT_MS);
        
        // Decrypt the values off-chain
        const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
          [xHandle, yHandle, qGTHandle],
          defaultSigner,
          userAesKey,
          PROXY_URL
        );
        
        // Verify the decrypted values are non-zero (indicating successful OPRF computation)
        expect(decryptedX).to.not.equal(0n);
        expect(decryptedY).to.not.equal(0n);
        // The actual amount should be less than or equal to the requested amount
        expect(decryptedQ).to.be.at.most(requestedQuantity);
        // The actual amount should be greater than 0 (some tokens were transferred)
        expect(decryptedQ).to.be.greaterThan(0n);
      }
    });

    it("Should mint 0 OPRF tokens when user has no private ERC20 balance", async function () {

      // Create a new user with no private ERC20 balance
      const newWallet = Wallet.createRandom().connect(hre.ethers.provider);
      const newUserAddress = await newWallet.getAddress();
      
      // Fund the new wallet with ETH for gas
      const fundTx = await defaultSigner.sendTransaction({
        to: newUserAddress,
        value: hre.ethers.parseEther("0.01") // 0.01 ETH for gas
      });
      await fundTx.wait();
      
      // Get AES key for the new user
      const newUserAesKey = await getUserKeyViaProxy(newWallet as any, PROXY_URL);
      const newUserAesKeyHex = newUserAesKey.toString("hex");

      const requestedQuantity = 50n;

      // Connect the new wallet to the contract
      const privateTokenWithNewUser = privateToken.connect(newWallet);

      // Prepare encrypted quantity parameter
      const quantityIT = await buildSignedItUint256({
        value: requestedQuantity,
        userAddress: newUserAddress,
        userAesKeyHex: newUserAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: newWallet,
      });
      // Mint OPRF token - should succeed but mint 0 tokens
      const tx = await privateTokenWithNewUser.mintOPRFToken(quantityIT);
      const receipt = await tx.wait();
      
      expect(receipt?.status).to.equal(1);
      
      // Add delay to allow MPC computation to complete
      await delay(DELAY_BALANCE_SYNC_MS);
      
      // Check that the OPRFMinted event was emitted
      const event = findParsedLogInReceipt(receipt, privateToken, "OPRFMinted");
      
      expect(event).to.not.be.undefined;
      
      if (event) {
        const decoded = privateToken.interface.parseLog(event);
        expect(decoded?.args[0]).to.equal(newUserAddress);
        
        // The x, y, and qGT values are encrypted handles
        const xHandle = decoded?.args[1];
        const yHandle = decoded?.args[2];
        const qGTHandle = decoded?.args[3];
        
        expect(xHandle).to.not.be.undefined;
        expect(yHandle).to.not.be.undefined;
        expect(qGTHandle).to.not.be.undefined;
        
        // Wait a bit more for MPC computation to complete before decryption
        await delay(DELAY_SHORT_MS);
        
        // Decrypt the values off-chain
        const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
          [xHandle, yHandle, qGTHandle],
          newWallet,
          newUserAesKey,
          PROXY_URL
        );
        
        // Verify the decrypted qGT is 0 (no tokens were transferred)
        expect(decryptedQ).to.equal(0n);
      }
    });

    it("Should successfully split OPRF tokens with encrypted parameters", async function () {

      // Ensure user has enough private ERC20 balance for this test
      const additionalShieldAmount = hre.ethers.parseEther("50"); // Shield additional 50 tokens
      await mintApproveAndShield({
        mockToken,
        privateToken,
        recipient: userAddress,
        amount: additionalShieldAmount,
      });
      await delay(DELAY_STANDARD_MS); // Wait for MPC computation

      const quantity = 50n;
      // yClear will be set after we decrypt the minted values
      const qSplit = 20n; // Amount to split off as payment (uint256) - following user_contract.sol example
      
      // Mint an OPRF token (no approval needed since mintOPRFToken uses direct transfer)
      const quantityIT = await buildSignedItUint256({
        value: quantity,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });
      // Mint OPRF token
      const mintTx = await privateToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await delay(DELAY_BALANCE_SYNC_MS);

      // Get the minted values from the event
      const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
      expect(mintHandles).to.not.be.undefined;
      const { xHandle, yHandle, qHandle } = mintHandles!;

      // Wait a bit for MPC computation to complete before decryption
      await delay(DELAY_SHORT_MS);

      // Decrypt X, Y, and Q values from minting
      const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
        [xHandle, yHandle, qHandle],
        defaultSigner,
        userAesKey,
        PROXY_URL
      );

      const yClear = decryptedY;

      const { xIT, qIT, qSplitIT } = await buildSignedOprfSplitPayloads({
        decryptedX,
        decryptedQ,
        qSplit,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });

      // Split the OPRF token
      const splitTx = await privateToken.splitToken(
        xIT,
        qIT,
        yClear,
        qSplitIT
      );
      const splitReceipt = await splitTx.wait();
      expect(splitReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await delay(DELAY_BALANCE_SYNC_MS);

      // Get the split event
      const splitEvent = findParsedLogInReceipt(splitReceipt, privateToken, "OPRFSplit");

      expect(splitEvent).to.not.be.undefined;

      if (splitEvent) {
        const splitDecoded = privateToken.interface.parseLog(splitEvent);
        const xrRemainderHandle = splitDecoded?.args[1];
        const qRemainderHandle = splitDecoded?.args[2];
        const yRemainderHandle = splitDecoded?.args[3];
        const xrPayHandle = splitDecoded?.args[4];
        const qPayHandle = splitDecoded?.args[5];
        const yPayHandle = splitDecoded?.args[6];

        expect(xrRemainderHandle).to.not.be.undefined;
        expect(qRemainderHandle).to.not.be.undefined;
        expect(yRemainderHandle).to.not.be.undefined;
        expect(xrPayHandle).to.not.be.undefined;
        expect(qPayHandle).to.not.be.undefined;
        expect(yPayHandle).to.not.be.undefined;

        // Wait a bit more for MPC computation to complete before decryption
        await delay(DELAY_SHORT_MS);

        // Decrypt the split values using the same approach as existing tests
        const [
          decryptedXrRemainder,
          decryptedQRemainder,
          decryptedYRemainder,
          decryptedXrPay,
          decryptedQPay,
          decryptedYPay,
        ] = await decryptMultipleValuesViaProxy(
          [
            xrRemainderHandle,
            qRemainderHandle,
            yRemainderHandle,
            xrPayHandle,
            qPayHandle,
            yPayHandle,
          ],
          defaultSigner,
          userAesKey,
          PROXY_URL
        );

        // Verify the decrypted values are non-zero (indicating successful OPRF split computation)
        // Note: QRemainder and QPay might be 0 depending on the OPRF split algorithm
        expect(decryptedXrRemainder).to.not.equal(0n);
        expect(decryptedYRemainder).to.not.equal(0n);
        expect(decryptedXrPay).to.not.equal(0n);
        expect(decryptedYPay).to.not.equal(0n);

        // The x and y values should be different between remainder and pay portions
        expect(decryptedXrRemainder).to.not.equal(decryptedXrPay);
        expect(decryptedYRemainder).to.not.equal(decryptedYPay);
      }
    });

    it("Should fail when trying to split more tokens than available", async function () {

      // Ensure user has enough private ERC20 balance for this test
      const additionalShieldAmount = hre.ethers.parseEther("50"); // Shield additional 50 tokens
      await mintApproveAndShield({
        mockToken,
        privateToken,
        recipient: userAddress,
        amount: additionalShieldAmount,
      });
      await delay(DELAY_STANDARD_MS); // Wait for MPC computation

      const quantity = 50n;
      const qSplit = 80n; // Try to split more than we have (80 > 50)
      
      // Mint an OPRF token (no approval needed since mintOPRFToken uses direct transfer)
      const quantityIT = await buildSignedItUint256({
        value: quantity,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });
      // Mint OPRF token
      const mintTx = await privateToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await delay(DELAY_BALANCE_SYNC_MS);

      // Get the minted values from the event
      const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
      expect(mintHandles).to.not.be.undefined;
      const { xHandle, yHandle, qHandle } = mintHandles!;

      // Wait a bit for MPC computation to complete before decryption
      await delay(DELAY_SHORT_MS);

      // Decrypt X, Y, and Q values from minting
      const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
        [xHandle, yHandle, qHandle],
        defaultSigner,
        userAesKey,
        PROXY_URL
      );

      const yClear = decryptedY;

      const { xIT, qIT, qSplitIT } = await buildSignedOprfSplitPayloads({
        decryptedX,
        decryptedQ,
        qSplit,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });

      // Try to split more than available - should succeed but with 0 amount for excess
      const splitTx = await privateToken.splitToken(
        xIT,
        qIT,
        yClear,
        qSplitIT
      );
      const splitReceipt = await splitTx.wait();
      expect(splitReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await delay(DELAY_BALANCE_SYNC_MS);

      // Get the split event
      const splitEvent = findParsedLogInReceipt(splitReceipt, privateToken, "OPRFSplit");

      expect(splitEvent).to.not.be.undefined;

      if (splitEvent) {
        const splitDecoded = privateToken.interface.parseLog(splitEvent);
        const xrRemainderHandle = splitDecoded?.args[1];
        const qRemainderHandle = splitDecoded?.args[2];
        const yRemainderHandle = splitDecoded?.args[3];
        const xrPayHandle = splitDecoded?.args[4];
        const qPayHandle = splitDecoded?.args[5];
        const yPayHandle = splitDecoded?.args[6];

        expect(xrRemainderHandle).to.not.be.undefined;
        expect(qRemainderHandle).to.not.be.undefined;
        expect(yRemainderHandle).to.not.be.undefined;
        expect(xrPayHandle).to.not.be.undefined;
        expect(qPayHandle).to.not.be.undefined;
        expect(yPayHandle).to.not.be.undefined;

        // Wait a bit more for MPC computation to complete before decryption
        await delay(DELAY_SHORT_MS);

        // Decrypt the split values
        const [
          decryptedXrRemainder,
          decryptedQRemainder,
          decryptedYRemainder,
          decryptedXrPay,
          decryptedQPay,
          decryptedYPay,
        ] = await decryptMultipleValuesViaProxy(
          [
            xrRemainderHandle,
            qRemainderHandle,
            yRemainderHandle,
            xrPayHandle,
            qPayHandle,
            yPayHandle,
          ],
          defaultSigner,
          userAesKey,
          PROXY_URL
        );

        // Verify the expected behavior: remainder should be original amount, payment should be 0
        expect(decryptedQRemainder).to.equal(quantity);
        expect(decryptedQPay).to.equal(0n);
        
        // Verify the coordinate values are still valid (non-zero)
        expect(decryptedXrRemainder).to.not.equal(0n);
        expect(decryptedYRemainder).to.not.equal(0n);
        expect(decryptedXrPay).to.not.equal(0n);
        expect(decryptedYPay).to.not.equal(0n);
      }
    });

    it("Should successfully merge OPRF tokens - simple flow: mint -> split -> merge", async function () {

      // Ensure user has enough private ERC20 balance for this test
      const additionalShieldAmount = hre.ethers.parseEther("50"); // Shield additional 50 tokens
      await mintApproveAndShield({
        mockToken,
        privateToken,
        recipient: userAddress,
        amount: additionalShieldAmount,
      });
      await delay(DELAY_STANDARD_MS); // Wait for MPC computation

      const quantity = 50n;
      const qSplit = 20n; // Amount to split off as payment
      
      // Mint an OPRF token (no approval needed since mintOPRFToken uses direct transfer)
      const quantityIT = await buildSignedItUint256({
        value: quantity,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });
      // Mint OPRF token
      const mintTx = await privateToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await delay(DELAY_BALANCE_SYNC_MS);

      // Get the minted values from the event
      const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
      expect(mintHandles).to.not.be.undefined;
      const { xHandle, yHandle, qHandle } = mintHandles!;

      // Wait a bit for MPC computation to complete before decryption
      await delay(DELAY_SHORT_MS);

      // Decrypt X, Y, and Q values from minting
      const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
        [xHandle, yHandle, qHandle],
        defaultSigner,
        userAesKey,
        PROXY_URL
      );

      const yClear = decryptedY;

      // Re-encrypt the decrypted values using a temporary account (matches frontend anonymous flow)

      // Create temp account to perform the split anonymously
      const tempWallet = Wallet.createRandom().connect(hre.ethers.provider);
      const tempAddress = await tempWallet.getAddress();
      const fundTempTx = await defaultSigner.sendTransaction({
        to: tempAddress,
        value: hre.ethers.parseEther("0.01")
      });
      await fundTempTx.wait();

      const tempAesKey = await getUserKeyViaProxy(tempWallet as any, PROXY_URL);
      const tempAesKeyHex = tempAesKey.toString("hex");

      const { xIT, qIT, qSplitIT } = await buildSignedOprfSplitPayloads({
        decryptedX,
        decryptedQ,
        qSplit,
        userAddress: tempAddress,
        userAesKeyHex: tempAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: tempWallet,
      });

      // Split must be sent by the account that signed the itUint payloads
      const splitTx = await privateToken.connect(tempWallet).splitToken(
        xIT,
        qIT,
        yClear,
        qSplitIT
      );
      const splitReceipt = await splitTx.wait();
      expect(splitReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await delay(DELAY_BALANCE_SYNC_MS);

      // Get the split event
      const splitEvent = findParsedLogInReceipt(splitReceipt, privateToken, "OPRFSplit");

      expect(splitEvent).to.not.be.undefined;
      const splitDecoded = privateToken.interface.parseLog(splitEvent!);
      const xrRemainderHandle = splitDecoded?.args[1];
      const qRemainderHandle = splitDecoded?.args[2];
      const yRemainderHandle = splitDecoded?.args[3];
      const xrPayHandle = splitDecoded?.args[4];
      const qPayHandle = splitDecoded?.args[5];
      const yPayHandle = splitDecoded?.args[6];

      // Wait a bit more for MPC computation to complete before decryption
      await delay(DELAY_SHORT_MS);

      // Split was executed by tempWallet — all remainder/payment handles are permitted to msg.sender (tempWallet)
      const [
        decryptedXrRemainder,
        decryptedQRemainder,
        decryptedYRemainder,
        decryptedXrPay,
        decryptedQPay,
        decryptedYPay,
      ] = await decryptMultipleValuesViaProxy(
        [
          xrRemainderHandle,
          qRemainderHandle,
          yRemainderHandle,
          xrPayHandle,
          qPayHandle,
          yPayHandle,
        ],
        tempWallet,
        tempAesKey,
        PROXY_URL
      );

      console.log("Split Results:");
      console.log("  Remainder Quantity:", decryptedQRemainder.toString());
      console.log("  Payment Quantity:", decryptedQPay.toString());
      console.log("  Total (should equal original):", (decryptedQRemainder + decryptedQPay).toString());

      // Now prepare for merging - re-encrypt the split values
      const xrRemainderIT = await buildSignedItUint128({
        value: decryptedXrRemainder,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });
      const qRemainderIT = await buildSignedItUint256({
        value: decryptedQRemainder,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });
      const xrPayIT = await buildSignedItUint128({
        value: decryptedXrPay,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });
      const qPayIT = await buildSignedItUint256({
        value: decryptedQPay,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });

      const yRemainderClear = decryptedYRemainder;
      const yPayClear = decryptedYPay;

      const tokensToMerge = [
        {
          x: {
            userAddress: xrRemainderIT.userAddress,
            ciphertext: xrRemainderIT.ciphertext,
            signature: xrRemainderIT.signature,
          },
          q: {
            userAddress: qRemainderIT.userAddress,
            ciphertext: qRemainderIT.ciphertext,
            signature: qRemainderIT.signature,
          },
          y_clear: yRemainderClear,
        },
        {
          x: {
            userAddress: xrPayIT.userAddress,
            ciphertext: xrPayIT.ciphertext,
            signature: xrPayIT.signature,
          },
          q: {
            userAddress: qPayIT.userAddress,
            ciphertext: qPayIT.ciphertext,
            signature: qPayIT.signature,
          },
          y_clear: yPayClear,
        },
      ];

      const mergeTx = await privateToken.mergeMany(tokensToMerge);
      const mergeReceipt = await mergeTx.wait();
      expect(mergeReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await delay(DELAY_BALANCE_SYNC_MS);

      // Get the merge event
      const mergeEvent = findParsedLogInReceipt(mergeReceipt, privateToken, "OPRFMerged");

      expect(mergeEvent).to.not.be.undefined;

      if (mergeEvent) {
        const mergeDecoded = privateToken.interface.parseLog(mergeEvent);
        const xrMergedHandle = mergeDecoded?.args[1];
        const qMergedHandle = mergeDecoded?.args[2];
        const yMergedHandle = mergeDecoded?.args[3];

        expect(xrMergedHandle).to.not.be.undefined;
        expect(qMergedHandle).to.not.be.undefined;
        expect(yMergedHandle).to.not.be.undefined;

        // Wait a bit more for MPC computation to complete before decryption
        await delay(DELAY_SHORT_MS);

        const [decryptedXrMerged, decryptedQMerged, decryptedYMerged] = await decryptMultipleValuesViaProxy(
          [xrMergedHandle, qMergedHandle, yMergedHandle],
          defaultSigner,
          userAesKey,
          PROXY_URL
        );

        // Verify the decrypted values are non-zero (indicating successful OPRF merge computation)
        expect(decryptedXrMerged).to.not.equal(0n);
        expect(decryptedYMerged).to.not.equal(0n);

        // Verify the merged quantity equals the sum of remainder and payment quantities
        expect(decryptedQMerged).to.equal(decryptedQRemainder + decryptedQPay);
      }
    });

    it("Should successfully split OPRF token for anonymous transfer to recipient", async function () {

      // Ensure user has enough private ERC20 balance for this test
      const additionalShieldAmount = hre.ethers.parseEther("50"); // Shield additional 50 tokens
      await mintApproveAndShield({
        mockToken,
        privateToken,
        recipient: userAddress,
        amount: additionalShieldAmount,
      });
      await delay(DELAY_STANDARD_MS); // Wait for MPC computation

      // Create a recipient wallet
      const recipientWallet = Wallet.createRandom().connect(hre.ethers.provider);
      const recipientAddress = await recipientWallet.getAddress();
      
      // Fund the recipient wallet with ETH for gas
      const fundTx = await defaultSigner.sendTransaction({
        to: recipientAddress,
        value: hre.ethers.parseEther("0.01") // 0.01 ETH for gas
      });
      await fundTx.wait();

      const quantity = 50n;
      const qSplit = 20n; // Amount to split off as payment to recipient
      
      // Mint an OPRF token (no approval needed since mintOPRFToken uses direct transfer)
      const quantityIT = await buildSignedItUint256({
        value: quantity,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });
      // Mint OPRF token
      const mintTx = await privateToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await delay(DELAY_BALANCE_SYNC_MS);

      // Get the minted values from the event
      const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
      expect(mintHandles).to.not.be.undefined;
      const { xHandle, yHandle, qHandle } = mintHandles!;

      // Wait a bit for MPC computation to complete before decryption
      await delay(DELAY_SHORT_MS);

      // Decrypt X, Y, and Q values from minting
      const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
        [xHandle, yHandle, qHandle],
        defaultSigner,
        userAesKey,
        PROXY_URL
      );

      const yClear = decryptedY;

      const { xIT, qIT, qSplitIT } = await buildSignedOprfSplitPayloads({
        decryptedX,
        decryptedQ,
        qSplit,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });

      // Caller must be defaultSigner (matches ciphertext userAddress). Remainder handles are permitted to msg.sender.
      const splitTx = await privateToken.connect(defaultSigner).splitTokenForRecipient(
        xIT,
        qIT,
        yClear,
        qSplitIT,
        recipientAddress
      );
      const splitReceipt = await splitTx.wait();
      expect(splitReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await delay(DELAY_BALANCE_SYNC_MS);

      // Get the split event
      const splitEvent = findParsedLogInReceipt(splitReceipt, privateToken, "OPRFSplitForRecipient");

      expect(splitEvent).to.not.be.undefined;

      if (splitEvent) {
        const splitDecoded = privateToken.interface.parseLog(splitEvent);
        const user = splitDecoded?.args[0];
        const recipient = splitDecoded?.args[1];
        const xrRemainderHandle = splitDecoded?.args[2];
        const qRemainderHandle = splitDecoded?.args[3];
        const yRemainderHandle = splitDecoded?.args[4];
        const xrPayHandle = splitDecoded?.args[5];
        const qPayHandle = splitDecoded?.args[6];
        const yPayHandle = splitDecoded?.args[7];

        expect(user).to.equal(userAddress);
        expect(recipient).to.equal(recipientAddress);
        expect(xrRemainderHandle).to.not.be.undefined;
        expect(qRemainderHandle).to.not.be.undefined;
        expect(yRemainderHandle).to.not.be.undefined;
        expect(xrPayHandle).to.not.be.undefined;
        expect(qPayHandle).to.not.be.undefined;
        expect(yPayHandle).to.not.be.undefined;

        // Wait a bit more for MPC computation to complete before decryption
        await delay(DELAY_SHORT_MS);

        const [decryptedXrRemainder, decryptedQRemainder, decryptedYRemainder] = await decryptMultipleValuesViaProxy(
          [xrRemainderHandle, qRemainderHandle, yRemainderHandle],
          defaultSigner,
          userAesKey,
          PROXY_URL
        );

        // Get recipient's AES key for decryption
        let recipientAesKey: Buffer;
        try {
          recipientAesKey = await Promise.race([
            getUserKeyViaProxy(recipientWallet as any, PROXY_URL),
            new Promise((_, reject) => 
              setTimeout(() => reject(new Error('getUserKeyViaProxy timeout after 30 seconds')), 30000)
            )
          ]) as Buffer;
        } catch (error) {
          console.error("Failed to get recipient AES key:", error);
          throw error;
        }

        const [decryptedXrPay, decryptedQPay, decryptedYPay] = await decryptMultipleValuesViaProxy(
          [xrPayHandle, qPayHandle, yPayHandle],
          recipientWallet,
          recipientAesKey,
          PROXY_URL
        );

        // Verify the decrypted values are non-zero (indicating successful OPRF split computation)
        expect(decryptedXrRemainder).to.not.equal(0n);
        expect(decryptedYRemainder).to.not.equal(0n);
        expect(decryptedXrPay).to.not.equal(0n);
        expect(decryptedYPay).to.not.equal(0n);

        // The x and y values should be different between remainder and pay portions
        expect(decryptedXrRemainder).to.not.equal(decryptedXrPay);
        expect(decryptedYRemainder).to.not.equal(decryptedYPay);

        expect(decryptedQRemainder).to.equal(quantity - qSplit);
        expect(decryptedQPay).to.equal(qSplit);
      }
    });

    it("Should complete anonymous transfer flow: split + burn by recipient", async function () {

      // Ensure user has enough private ERC20 balance for this test
      const additionalShieldAmount = hre.ethers.parseEther("50"); // Shield additional 50 tokens
      await mintApproveAndShield({
        mockToken,
        privateToken,
        recipient: userAddress,
        amount: additionalShieldAmount,
      });
      await delay(DELAY_STANDARD_MS); // Wait for MPC computation

      // Create a recipient wallet
      const recipientWallet = Wallet.createRandom().connect(hre.ethers.provider);
      const recipientAddress = await recipientWallet.getAddress();
      
      // Fund the recipient wallet with ETH for gas
      const fundTx = await defaultSigner.sendTransaction({
        to: recipientAddress,
        value: hre.ethers.parseEther("0.01") // 0.01 ETH for gas
      });
      await fundTx.wait();

      const quantity = 50n;
      const qSplit = 20n; // Amount to split off as payment to recipient
      
      // Step 1: Mint OPRF token (no key needed - contract manages it internally)
      const quantityIT = await buildSignedItUint256({
        value: quantity,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });
      const mintTx = await privateToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);
      await delay(DELAY_BALANCE_SYNC_MS);

      // Get minted values
      const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
      expect(mintHandles).to.not.be.undefined;
      const { xHandle, yHandle, qHandle } = mintHandles!;

      await delay(DELAY_SHORT_MS);

      // Decrypt minted values
      const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
        [xHandle, yHandle, qHandle],
        defaultSigner,
        userAesKey,
        PROXY_URL
      );
      
      console.log("\n=== Original OPRF Token (Minted) ===");
      console.log("X:", decryptedX.toString());
      console.log("Y:", decryptedY.toString());
      console.log("Q:", decryptedQ.toString());
      console.log("=================================\n");

      // Step 2: Split token for recipient using temp account (like frontend)
      const tempWallet = Wallet.createRandom().connect(hre.ethers.provider);
      const tempAddress = await tempWallet.getAddress();
      
      const fundTempTx = await defaultSigner.sendTransaction({
        to: tempAddress,
        value: hre.ethers.parseEther("0.01")
      });
      await fundTempTx.wait();
      
      const tempAesKey = await getUserKeyViaProxy(tempWallet as any, PROXY_URL);
      
      const yClear = decryptedY;
      const tempAesKeyHex = tempAesKey.toString("hex");

      const { xIT, qIT, qSplitIT } = await buildSignedOprfSplitPayloads({
        decryptedX,
        decryptedQ,
        qSplit,
        userAddress: tempAddress,
        userAesKeyHex: tempAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: tempWallet,
      });

      const splitTx = await privateToken.connect(tempWallet).splitTokenForRecipient(
        xIT,
        qIT,
        yClear,
        qSplitIT,
        recipientAddress
      );
      const splitReceipt = await splitTx.wait();
      expect(splitReceipt?.status).to.equal(1);
      await delay(DELAY_BALANCE_SYNC_MS);

      // Get split values from OPRFMinted events (same approach as frontend)
      // The contract emits two OPRFMinted events: one for remainder (msg.sender) and one for payment (recipient)
      const oprfMintedEvents = getOprfMintedEventsFromReceipt(splitReceipt, privateToken);

      // Find remainder event (for msg.sender = tempWallet in this test)
      const remainderEvent = oprfMintedEvents.find((e: any) => 
        e.user.toLowerCase() === tempAddress.toLowerCase()
      );
      // Find payment event (for recipient)
      const paymentEvent = oprfMintedEvents.find((e: any) => 
        e.user.toLowerCase() === recipientAddress.toLowerCase()
      );

      expect(remainderEvent).to.not.be.undefined;
      expect(paymentEvent).to.not.be.undefined;

      const xrRemainderHandle = remainderEvent.x;
      const qRemainderHandle = remainderEvent.q;
      const yRemainderHandle = remainderEvent.y;
      const xrPayHandle = paymentEvent.x;
      const qPayHandle = paymentEvent.q;
      const yPayHandle = paymentEvent.y;

      await delay(DELAY_SHORT_MS);

      const [decryptedXrRemainder, decryptedQRemainder, decryptedYRemainder] = await decryptMultipleValuesViaProxy(
        [xrRemainderHandle, qRemainderHandle, yRemainderHandle],
        tempWallet,
        tempAesKey,
        PROXY_URL
      );

      const recipientAesKey = await getUserKeyViaProxy(recipientWallet as any, PROXY_URL);

      const [decryptedXrPay, decryptedQPay, decryptedYPay] = await decryptMultipleValuesViaProxy(
        [xrPayHandle, qPayHandle, yPayHandle],
        recipientWallet,
        recipientAesKey,
        PROXY_URL
      );

      // Step 3: Recipient burns their OPRF token portion
      // No key needed - contract manages it internally
      const recipientAesKeyHex = recipientAesKey.toString("hex");
      const recipientXIT = await buildSignedItUint128({
        value: decryptedXrPay,
        userAddress: recipientAddress,
        userAesKeyHex: recipientAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: recipientWallet,
      });
      const recipientQIT = await buildSignedItUint256({
        value: decryptedQPay,
        userAddress: recipientAddress,
        userAesKeyHex: recipientAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: recipientWallet,
      });

      // Step 3: Burn the split OPRF token and transfer tokens to recipient
      const burnTx = await privateToken.connect(recipientWallet).burnToken(
        recipientXIT,
        recipientQIT,
        decryptedYPay, // Use the yPay from the split
        recipientAddress // Recipient to receive the tokens
      );
      const burnReceipt = await burnTx.wait();
      expect(burnReceipt?.status).to.equal(1);
      
      await delay(DELAY_BALANCE_SYNC_MS);

      // Verify the burn event (now includes recipient)
      const burnEvent = findParsedLogInReceipt(burnReceipt, privateToken, "OPRFBurned");
      expect(burnEvent).to.not.be.undefined;

      const burnDecoded = privateToken.interface.parseLog(burnEvent!);
      const burnedUser = burnDecoded?.args[0];
      const burnedRecipient = burnDecoded?.args[1];
      const burnedAmountHandle = burnDecoded?.args[2];

      expect(burnedUser).to.equal(recipientAddress);
      expect(burnedRecipient).to.equal(recipientAddress);

      await delay(DELAY_SHORT_MS);
      const decryptedBurnedAmount = await decryptValueViaProxy(burnedAmountHandle, recipientWallet, recipientAesKey, PROXY_URL);

      // Verify quantities are preserved
      expect(decryptedQRemainder + decryptedQPay).to.equal(quantity);
      expect(decryptedQPay).to.equal(qSplit);
      expect(decryptedQRemainder).to.equal(quantity - qSplit);
      
      expect(decryptedBurnedAmount).to.equal(decryptedQPay);
      
      // Verify recipient received the tokens by checking their balance
      const recipientBalanceHandle = await privateToken["balanceOf(address)"](recipientAddress);
      await delay(DELAY_SHORT_MS);
      const recipientBalanceDecrypted = await decryptValueViaProxy(recipientBalanceHandle, recipientWallet, recipientAesKey, PROXY_URL);
      expect(recipientBalanceDecrypted).to.be.greaterThan(0n);
    });

    it("Should successfully burn OPRF token and verify burned amount equals quantity", async function () {

      // Ensure user has enough private ERC20 balance for this test
      const additionalShieldAmount = hre.ethers.parseEther("50"); // Shield additional 50 tokens
      await mintApproveAndShield({
        mockToken,
        privateToken,
        recipient: userAddress,
        amount: additionalShieldAmount,
      });
      await delay(DELAY_STANDARD_MS); // Wait for MPC computation

      const quantity = 30n;
      
      // Mint an OPRF token (no approval needed since mintOPRFToken uses direct transfer)
      const quantityIT = await buildSignedItUint256({
        value: quantity,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });
      // Mint OPRF token
      const mintTx = await privateToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await delay(DELAY_BALANCE_SYNC_MS);

      // Get the minted values from the event
      const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
      expect(mintHandles).to.not.be.undefined;
      const { xHandle, yHandle, qHandle } = mintHandles!;

      // Wait a bit for MPC computation to complete before decryption
      await delay(DELAY_SHORT_MS);

      // Decrypt X, Y, and Q values from minting
      const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
        [xHandle, yHandle, qHandle],
        defaultSigner,
        userAesKey,
        PROXY_URL
      );

      // Set yClear to the decrypted Y value for burning
      const yClear = decryptedY;

      const { xIT, qIT } = await buildSignedOprfBurnPayloads({
        decryptedX,
        decryptedQ,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });

      // Burn the OPRF token and transfer to user (self)
      const burnTx = await privateToken.burnToken(
        xIT,
        qIT,
        yClear,
        userAddress
      );
      const burnReceipt = await burnTx.wait();
      expect(burnReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await delay(DELAY_BALANCE_SYNC_MS);

      // Get the burn event
      const burnEvent = findParsedLogInReceipt(burnReceipt, privateToken, "OPRFBurned");

      expect(burnEvent).to.not.be.undefined;

      if (burnEvent) {
        const burnDecoded = privateToken.interface.parseLog(burnEvent);
        const burnedAmountHandle = burnDecoded?.args[2];

        expect(burnedAmountHandle).to.not.be.undefined;

        // Wait a bit more for MPC computation to complete before decryption
        await delay(DELAY_SHORT_MS);

        // Decrypt the burned amount (zero handle cannot be decrypted via proxy; treat as 0n)
        const decryptedBurnedAmount =
          burnedAmountHandle === 0n
            ? 0n
            : await decryptValueViaProxy(burnedAmountHandle, defaultSigner, userAesKey, PROXY_URL);
        console.log(`   Decrypted burned amount: ${decryptedBurnedAmount}`);
        expect(decryptedBurnedAmount).to.not.be.undefined;
        expect(decryptedBurnedAmount).to.equal(quantity);
      }
    });

    it("Should successfully merge many OPRF tokens into a single token", async function () {
      // Increase timeout for this test since it processes multiple tokens + MPC
      this.timeout(300000); // 5 minutes
      

      // Ensure user has enough private ERC20 balance for this test
      const additionalShieldAmount = hre.ethers.parseEther("150"); // Shield additional 150 tokens for 3 tokens
      await mintApproveAndShield({
        mockToken,
        privateToken,
        recipient: userAddress,
        amount: additionalShieldAmount,
      });
      await delay(DELAY_STANDARD_MS); // Wait for MPC computation

      // Mint 3 OPRF tokens with different quantities
      const quantities = [30n, 40n, 50n]; // Total should be 120n
      const mintedTokens: Array<{
        x: bigint;
        q: bigint;
        y: bigint;
      }> = [];

      // Mint each token and collect their values
      for (let i = 0; i < quantities.length; i++) {
        const quantity = quantities[i];
        
        const quantityIT = await buildSignedItUint256({
        value: quantity,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });
        // Mint OPRF token
        const mintTx = await privateToken.mintOPRFToken(quantityIT);
        const mintReceipt = await mintTx.wait();
        expect(mintReceipt?.status).to.equal(1);

        // Wait for MPC computation to complete
        await delay(DELAY_BALANCE_SYNC_MS);

        // Get the minted values from the event
        const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
        expect(mintHandles).to.not.be.undefined;
        const { xHandle, yHandle, qHandle } = mintHandles!;

        // Wait a bit for MPC computation to complete before decryption
        await delay(DELAY_SHORT_MS);

        // Decrypt X, Y, and Q values from minting
        const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
          [xHandle, yHandle, qHandle],
          defaultSigner,
          userAesKey,
          PROXY_URL
        );

        mintedTokens.push({
          x: decryptedX,
          q: decryptedQ,
          y: decryptedY
        });

      }

      const totalQuantity = mintedTokens.reduce((sum, token) => sum + token.q, 0n);

      // Prepare the tokens array for mergeMany
      // Re-encrypt each token's x and q values
      const tokensToMerge = await Promise.all(
        mintedTokens.map(async (token) => {
          const xSigned = await buildSignedItUint128({
            value: token.x,
            userAddress,
            userAesKeyHex,
            contractAddress: await privateToken.getAddress(),
            signer: defaultSigner,
          });
          const qSigned = await buildSignedItUint256({
            value: token.q,
            userAddress,
            userAesKeyHex,
            contractAddress: await privateToken.getAddress(),
            signer: defaultSigner,
          });
          return {
            x: { userAddress: xSigned.userAddress, ciphertext: xSigned.ciphertext, signature: xSigned.signature },
            q: { userAddress: qSigned.userAddress, ciphertext: qSigned.ciphertext, signature: qSigned.signature },
            y_clear: token.y,
          };
        })
      );

      // Call mergeMany
      const mergeManyTx = await privateToken.mergeMany(tokensToMerge);
      const mergeManyReceipt = await mergeManyTx.wait();
      expect(mergeManyReceipt?.status).to.equal(1);

      // Wait longer for MPC computation to complete (mergeMany processes multiple tokens)
      await delay(DELAY_MPC_DECRYPTION_MS);

      // Get the merge event
      const mergeEvent = findParsedLogInReceipt(mergeManyReceipt, privateToken, "OPRFMerged");

      expect(mergeEvent).to.not.be.undefined;

      const mergedMintHandles = getOprfMintedHandlesFromReceipt(mergeManyReceipt, privateToken);

      expect(mergedMintHandles).to.not.be.undefined;

      if (mergedMintHandles) {
        const { xHandle: xMergedHandle, yHandle: yMergedHandle, qHandle: qMergedHandle } = mergedMintHandles;

        expect(xMergedHandle).to.not.be.undefined;
        expect(yMergedHandle).to.not.be.undefined;
        expect(qMergedHandle).to.not.be.undefined;

        // Wait longer for MPC computation to complete before decryption
        await delay(DELAY_MPC_PROCESSING_MS);

        // Decrypt the merged values
        const [decryptedXMerged, decryptedYMerged, decryptedQMerged] = await decryptMultipleValuesViaProxy(
          [xMergedHandle, yMergedHandle, qMergedHandle],
          defaultSigner,
          userAesKey,
          PROXY_URL
        );

        // Verify the merged values are non-zero
        expect(decryptedXMerged).to.not.equal(0n);
        expect(decryptedYMerged).to.not.equal(0n);
        expect(decryptedQMerged).to.not.equal(0n);

        // Verify the merged quantity equals the sum of all input quantities
        expect(decryptedQMerged).to.equal(totalQuantity);

        // Verify that all input tokens were invalidated (burned)
        // Event signature: OPRFTokenInvalidated(address indexed user, gtUint128 x, gtUint256 q, uint128 y, uint8 reason)
        // args[0] = user, args[1] = x, args[2] = q, args[3] = y, args[4] = reason
        const invalidatedEvents = mergeManyReceipt?.logs.filter((log: any) => {
          try {
            const decoded = privateToken.interface.parseLog(log);
            if (decoded?.name === "OPRFTokenInvalidated") {
              // Convert to number for comparison (ethers.js returns BigNumber for uint8)
              const reason = Number(decoded?.args[4]);
              // Debug: log all invalidated events to see what we're getting
              console.log(`Found OPRFTokenInvalidated event - reason: ${reason}`);
              return reason === 3; // 3 = burned (reason is at index 4)
            }
            return false;
          } catch {
            return false;
          }
        });

        console.log(`Found ${invalidatedEvents.length} invalidation events (expected ${mintedTokens.length})`);

        // Should have one invalidation event per token
        expect(invalidatedEvents.length).to.equal(mintedTokens.length);

        console.log("MergeMany successful!");
        console.log(`   Merged ${mintedTokens.length} tokens into 1 token`);
        console.log(`   Total quantity preserved: ${decryptedQMerged.toString()}`);
      }
    });

    it("mergeMany with duplicate token entries should yield single merged quantity (no double-count)", async function () {
      // Increase timeout for this test since it processes multiple tokens
      this.timeout(120000); // 120 seconds

      // Ensure user has enough private ERC20 balance for this test
      const additionalShieldAmount = hre.ethers.parseEther("100"); // Shield additional 100 tokens
      await mintApproveAndShield({
        mockToken,
        privateToken,
        recipient: userAddress,
        amount: additionalShieldAmount,
      });
      await delay(DELAY_STANDARD_MS); // Wait for MPC computation

      // Mint a single OPRF token
      const quantity = 50n;
      
      const quantityIT = await buildSignedItUint256({
        value: quantity,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });
      // Mint OPRF token
      const mintTx = await privateToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await delay(DELAY_BALANCE_SYNC_MS);

      // Get the minted values from the event
      const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
      expect(mintHandles).to.not.be.undefined;
      const { xHandle, yHandle, qHandle } = mintHandles!;

      // Wait a bit for MPC computation to complete before decryption
      await delay(DELAY_SHORT_MS);

      // Decrypt X, Y, and Q values from minting
      const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
        [xHandle, yHandle, qHandle],
        defaultSigner,
        userAesKey,
        PROXY_URL
      );

      console.log(`\n=== Minted Single OPRF Token ===`);
      console.log(`X: ${decryptedX.toString()}`);
      console.log(`Q: ${decryptedQ.toString()}`);
      console.log(`Y: ${decryptedY.toString()}`);
      console.log(`Expected merged quantity: ${decryptedQ.toString()}`);
      console.log("==================================\n");

      const xSigned = await buildSignedItUint128({
        value: decryptedX,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });
      const qSigned = await buildSignedItUint256({
        value: decryptedQ,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });
      const tokenToMerge = {
        x: { userAddress: xSigned.userAddress, ciphertext: xSigned.ciphertext, signature: xSigned.signature },
        q: { userAddress: qSigned.userAddress, ciphertext: qSigned.ciphertext, signature: qSigned.signature },
        y_clear: decryptedY,
      };

      // ATTEMPT DOUBLE-SPEND: Pass the same token twice to mergeMany
      const tokensToMerge = [tokenToMerge, tokenToMerge]; // Same token twice!

      // Call mergeMany with duplicate tokens
      const mergeManyTx = await privateToken.mergeMany(tokensToMerge);
      const mergeManyReceipt = await mergeManyTx.wait();
      expect(mergeManyReceipt?.status).to.equal(1);

      // Wait longer for MPC computation to complete
      await delay(DELAY_MPC_DECRYPTION_MS);

      // Get the merge event
      const mergeEvent = findParsedLogInReceipt(mergeManyReceipt, privateToken, "OPRFMerged");

      expect(mergeEvent).to.not.be.undefined;

      // Also check for OPRFMinted event (the merged token)
      const mergedMintHandles = getOprfMintedHandlesFromReceipt(mergeManyReceipt, privateToken);

      expect(mergedMintHandles).to.not.be.undefined;

      if (mergedMintHandles) {
        const { xHandle: xMergedHandle, yHandle: yMergedHandle, qHandle: qMergedHandle } = mergedMintHandles;

        expect(xMergedHandle).to.not.be.undefined;
        expect(yMergedHandle).to.not.be.undefined;
        expect(qMergedHandle).to.not.be.undefined;

        // Wait longer for MPC computation to complete before decryption
        await delay(DELAY_MPC_PROCESSING_MS);

        // Decrypt the merged values
        const [decryptedXMerged, decryptedYMerged, decryptedQMerged] = await decryptMultipleValuesViaProxy(
          [xMergedHandle, yMergedHandle, qMergedHandle],
          defaultSigner,
          userAesKey,
          PROXY_URL
        );

        // Verify the merged values are non-zero
        expect(decryptedXMerged).to.not.equal(0n);
        expect(decryptedYMerged).to.not.equal(0n);
        expect(decryptedQMerged).to.not.equal(0n);

        // mergeMany burns each entry; duplicate struct references still only burn the same token once at MPC layer
        expect(decryptedQMerged).to.equal(decryptedQ);
      }
    });

    it("Should successfully transfer OPRF tokens to recipient with sufficient balance", async function () {
      this.timeout(300000); // 300 seconds (5 minutes) - MPC operations take time

      // ========== Setup: Prepare balances and recipient ==========
      const additionalShieldAmount = hre.ethers.parseEther("150");
      await mintApproveAndShield({
        mockToken,
        privateToken,
        recipient: userAddress,
        amount: additionalShieldAmount,
      });
      await delay(DELAY_STANDARD_MS);

      // Setup recipient wallet and get their encryption key
      const recipientWallet = Wallet.createRandom().connect(hre.ethers.provider);
      const recipientAddress = await recipientWallet.getAddress();
      
      await defaultSigner.sendTransaction({
        to: recipientAddress,
        value: hre.ethers.parseEther("0.01")
      }).then((tx: any) => tx.wait());

      const recipientAesKey = await getUserKeyViaProxy(recipientWallet as any, PROXY_URL);

      // ========== Step 1: Mint multiple OPRF tokens ==========
      const tokenQuantities = [30n, 40n, 50n]; // Total: 120 tokens
      const transferAmount = 100n; // Transfer 100 tokens to recipient (sender keeps 20)
      const expectedSenderRemainder = 20n; // 120 - 100 = 20
      
      interface MintedToken {
        x: bigint;
        q: bigint;
        y: bigint;
      }
      const mintedTokens: MintedToken[] = [];

      // Mint each OPRF token and decrypt its values
      for (let i = 0; i < tokenQuantities.length; i++) {
        const quantity = tokenQuantities[i];
        
        const quantityIT = buildUnsignedItUint256({
          value: quantity,
          userAddress,
          userAesKeyHex,
          contractAddress: await privateToken.getAddress(),
        });

        // Mint OPRF token
        const mintTx = await privateToken.mintOPRFToken(quantityIT);
        const mintReceipt = await mintTx.wait();
        expect(mintReceipt?.status).to.equal(1);

        // Wait for MPC computation to complete
        await delay(DELAY_BALANCE_SYNC_MS);

        // Get the minted values from the event
        const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
        expect(mintHandles).to.not.be.undefined;
        const { xHandle, yHandle, qHandle } = mintHandles!;

        // Wait a bit for MPC computation to complete before decryption
        await delay(DELAY_SHORT_MS);

        // Decrypt X, Y, and Q values from minting
        const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
          [xHandle, yHandle, qHandle],
          defaultSigner,
          userAesKey,
          PROXY_URL
        );

        mintedTokens.push({
          x: decryptedX,
          q: decryptedQ,
          y: decryptedY
        });
      }

      const totalQuantity = mintedTokens.reduce((sum, token) => sum + token.q, 0n);

      // Prepare tokens for transferOPRF
      const tokensToTransfer = await Promise.all(
        mintedTokens.map(async (token) => {
          const x = buildUnsignedItUint128({
            value: token.x,
            userAddress,
            userAesKeyHex,
            contractAddress: await privateToken.getAddress(),
          });
          const q = buildUnsignedItUint256({
            value: token.q,
            userAddress,
            userAesKeyHex,
            contractAddress: await privateToken.getAddress(),
          });
          return {
            x: { userAddress: x.userAddress, ciphertext: x.ciphertext },
            q: { userAddress: q.userAddress, ciphertext: q.ciphertext },
            y_clear: token.y,
          };
        })
      );

      const encryptedTransferAmount = buildUnsignedItUint256({
        value: transferAmount,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
      });

      // Execute transferOPRF
      const transferTx = await privateToken.transferOPRF(
        tokensToTransfer,
        encryptedTransferAmount,
        recipientAddress
      );
      const transferReceipt = await transferTx.wait();
      expect(transferReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await delay(DELAY_MPC_REDEEM_MS);

      // Validate OPRFTransferred event and ensure both parties can decrypt the transferred amount
      const transferredEventLog = findParsedLogInReceipt(transferReceipt, privateToken, "OPRFTransferred");
      expect(transferredEventLog).to.not.be.undefined;
      const transferredEvent = privateToken.interface.parseLog(transferredEventLog!);
      expect(transferredEvent?.args[0].toLowerCase()).to.equal(userAddress.toLowerCase());
      expect(transferredEvent?.args[1].toLowerCase()).to.equal(recipientAddress.toLowerCase());
      const transferredAmountHandle = transferredEvent?.args[2];
      expect(transferredAmountHandle).to.not.be.undefined;

      // Extract OPRFMinted events
      const oprfMintedEvents = getOprfMintedEventsFromReceipt(transferReceipt, privateToken);

      expect(oprfMintedEvents.length).to.equal(2);
      
      const recipientEvent = oprfMintedEvents.find((e: any) => 
        e.user.toLowerCase() === recipientAddress.toLowerCase()
      );
      const senderEvent = oprfMintedEvents.find((e: any) => 
        e.user.toLowerCase() === userAddress.toLowerCase()
      );

      expect(recipientEvent).to.not.be.undefined;
      expect(senderEvent).to.not.be.undefined;
      if (!recipientEvent || !senderEvent) {
        throw new Error("Expected both recipient and sender OPRFMinted events");
      }

      // transferOPRF emits OPRFTransferred and OPRFMinted; verify both event families

      // Decrypt and verify results
      await delay(DELAY_MPC_EXTENDED_MS);

      const [recipientQ, recipientX, recipientY] = await decryptMultipleValuesViaProxy(
        [recipientEvent.q, recipientEvent.x, recipientEvent.y],
        recipientWallet,
        recipientAesKey,
        PROXY_URL
      );

      const [senderQ, senderX, senderY] = await decryptMultipleValuesViaProxy(
        [senderEvent.q, senderEvent.x, senderEvent.y],
        defaultSigner,
        userAesKey,
        PROXY_URL
      );
      const transferredAmountForRecipient = await decryptValueViaProxy(
        transferredAmountHandle,
        recipientWallet,
        recipientAesKey,
        PROXY_URL
      );
      const transferredAmountForSender = await decryptValueViaProxy(
        transferredAmountHandle,
        defaultSigner,
        userAesKey,
        PROXY_URL
      );

      // Verify correctness
      // Verify token values are non-zero
      expect(recipientX).to.not.equal(0n);
      expect(recipientY).to.not.equal(0n);
      expect(senderX).to.not.equal(0n);
      expect(senderY).to.not.equal(0n);

      // Verify quantities match expectations
      expect(recipientQ).to.equal(transferAmount, "Recipient should receive the exact transfer amount");
      expect(senderQ).to.equal(expectedSenderRemainder, "Sender should keep the remainder");
      expect(recipientQ + senderQ).to.equal(totalQuantity, "Total should be preserved");
      expect(transferredAmountForRecipient).to.equal(transferAmount, "Recipient should decrypt transferred event amount");
      expect(transferredAmountForSender).to.equal(transferAmount, "Sender should decrypt transferred event amount");
      expect(transferredAmountForRecipient).to.equal(recipientQ, "Transferred amount should match recipient OPRFMinted amount");

      // Verify all input tokens were invalidated (burned); reason 3 = burned per contract
      const invalidatedEvents = findParsedLogsInReceipt(transferReceipt, privateToken, "OPRFTokenInvalidated").filter(
        (log) => Number(privateToken.interface.parseLog(log)!.args[4]) === 3
      );

      expect(invalidatedEvents.length).to.equal(mintedTokens.length, "All input tokens should be invalidated");
    });

    // Tests that transferOPRF correctly handles insufficient balance:
    // When transfer amount exceeds available tokens, recipient should get 0 and sender keeps all tokens
    it("transferOPRF with insufficient balance should return 0 to recipient", async function () {
      this.timeout(300000); // 5 minutes - MPC operations take time
      
      console.log("Step 1: Setup - preparing balances and recipient...");
      const additionalShieldAmount = hre.ethers.parseEther("150");
      await mintApproveAndShield({
        mockToken,
        privateToken,
        recipient: userAddress,
        amount: additionalShieldAmount,
      });
      await delay(DELAY_STANDARD_MS);

      const recipientWallet = Wallet.createRandom().connect(hre.ethers.provider);
      const recipientAddress = await recipientWallet.getAddress();
      
      await defaultSigner.sendTransaction({
        to: recipientAddress,
        value: hre.ethers.parseEther("0.01")
      }).then((tx: any) => tx.wait());

      const recipientAesKey = await getUserKeyViaProxy(recipientWallet as any, PROXY_URL);
      console.log("   Setup complete");

      console.log("Step 2: Minting 3 OPRF tokens...");
      const tokenQuantities = [30n, 40n, 50n]; // Total: 120 tokens
      const transferAmount = 150n; // Try to transfer 150 tokens (insufficient - more than available)
      const expectedRecipientAmount = 0n; // Recipient should get 0 when insufficient
      const expectedSenderAmount = 120n; // Sender should get all tokens back
      
      interface MintedToken {
        x: bigint;
        q: bigint;
        y: bigint;
      }
      const mintedTokens: MintedToken[] = [];

      for (let i = 0; i < tokenQuantities.length; i++) {
        const quantity = tokenQuantities[i];
        console.log(`   Minting token ${i + 1}/3 (qty: ${quantity})...`);

        const quantityIT = buildUnsignedItUint256({
          value: quantity,
          userAddress,
          userAesKeyHex,
          contractAddress: await privateToken.getAddress(),
        });

        const mintTx = await privateToken.mintOPRFToken(quantityIT);
        const mintReceipt = await mintTx.wait();
        expect(mintReceipt?.status).to.equal(1);

        await delay(DELAY_BALANCE_SYNC_MS);

        const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
        expect(mintHandles).to.not.be.undefined;
        const { xHandle, yHandle, qHandle } = mintHandles!;

        await delay(DELAY_SHORT_MS);

        const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
          [xHandle, yHandle, qHandle],
          defaultSigner,
          userAesKey,
          PROXY_URL
        );


        mintedTokens.push({
          x: decryptedX,
          q: decryptedQ,
          y: decryptedY
        });
        console.log(`   Token ${i + 1} minted and decrypted`);
      }

      const totalQuantity = mintedTokens.reduce((sum, token) => sum + token.q, 0n);
      console.log(`   All tokens minted. Total: ${totalQuantity}`);

      console.log("Step 3: Preparing tokens for transfer...");
      const tokensToTransfer = await Promise.all(
        mintedTokens.map(async (token) => {
          const x = buildUnsignedItUint128({
            value: token.x,
            userAddress,
            userAesKeyHex,
            contractAddress: await privateToken.getAddress(),
          });
          const q = buildUnsignedItUint256({
            value: token.q,
            userAddress,
            userAesKeyHex,
            contractAddress: await privateToken.getAddress(),
          });
          return {
            x: { userAddress: x.userAddress, ciphertext: x.ciphertext },
            q: { userAddress: q.userAddress, ciphertext: q.ciphertext },
            y_clear: token.y,
          };
        })
      );

      const encryptedTransferAmount = buildUnsignedItUint256({
        value: transferAmount,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
      });
      console.log("   Tokens prepared");

      console.log("Step 4: Executing transferOPRF (insufficient balance test)...");
      const transferTx = await privateToken.transferOPRF(
        tokensToTransfer,
        encryptedTransferAmount,
        recipientAddress
      );
      const transferReceipt = await transferTx.wait();
      expect(transferReceipt?.status).to.equal(1);
      console.log("   Transfer transaction confirmed");

      console.log("Step 5: Waiting for MPC computation (15s)...");
      await delay(DELAY_MPC_DECRYPTION_MS);

      const transferredEventLog = findParsedLogInReceipt(transferReceipt, privateToken, "OPRFTransferred");
      expect(transferredEventLog).to.not.be.undefined;
      const transferredEvent = privateToken.interface.parseLog(transferredEventLog!);
      expect(transferredEvent?.args[0].toLowerCase()).to.equal(userAddress.toLowerCase());
      expect(transferredEvent?.args[1].toLowerCase()).to.equal(recipientAddress.toLowerCase());
      const transferredAmountHandle = transferredEvent?.args[2];
      expect(transferredAmountHandle).to.not.be.undefined;

      console.log("Step 6: Extracting events...");
      const oprfMintedEvents = getOprfMintedEventsFromReceipt(transferReceipt, privateToken);

      expect(oprfMintedEvents.length).to.equal(2);
      
      const recipientEvent = oprfMintedEvents.find((e: any) => 
        e.user.toLowerCase() === recipientAddress.toLowerCase()
      );
      const senderEvent = oprfMintedEvents.find((e: any) => 
        e.user.toLowerCase() === userAddress.toLowerCase()
      );

      expect(recipientEvent).to.not.be.undefined;
      expect(senderEvent).to.not.be.undefined;
      if (!recipientEvent || !senderEvent) {
        throw new Error("Expected both recipient and sender OPRFMinted events");
      }
      console.log("   Events extracted");

      console.log("Step 7: Decrypting results (waiting 10s then decrypting 6 values)...");
      await delay(DELAY_MPC_PROCESSING_MS);

      const [recipientQ, recipientX, recipientY] = await decryptMultipleValuesViaProxy(
        [recipientEvent.q, recipientEvent.x, recipientEvent.y],
        recipientWallet,
        recipientAesKey,
        PROXY_URL
      );

      const [senderQ, senderX, senderY] = await decryptMultipleValuesViaProxy(
        [senderEvent.q, senderEvent.x, senderEvent.y],
        defaultSigner,
        userAesKey,
        PROXY_URL
      );
      const transferredAmountForRecipient = await decryptValueViaProxy(
        transferredAmountHandle,
        recipientWallet,
        recipientAesKey,
        PROXY_URL
      );
      const transferredAmountForSender = await decryptValueViaProxy(
        transferredAmountHandle,
        defaultSigner,
        userAesKey,
        PROXY_URL
      );
      console.log(`   Decryption complete. Recipient: ${recipientQ}, Sender: ${senderQ}`);

      console.log("Step 8: Verifying results...");
      console.log(`\n========== MUX LOGIC VERIFICATION ==========`);
      console.log(`Total tokens available: ${totalQuantity}`);
      console.log(`Attempted transfer: ${transferAmount}`);
      console.log(`Overflow expected: YES (${transferAmount} > ${totalQuantity})`);
      console.log(`Recipient received: ${recipientQ}`);
      console.log(`Sender remainder: ${senderQ}`);
      console.log(`Sum: ${recipientQ + senderQ}`);
      console.log(`=============================================\n`);
      
      // Verify token values are non-zero
      expect(recipientX).to.not.equal(0n);
      expect(recipientY).to.not.equal(0n);
      expect(senderX).to.not.equal(0n);
      expect(senderY).to.not.equal(0n);

      // transferOPRF: insufficient ⇒ overflowBit true ⇒ recipientAmount=0, senderAmount=totalBurned (see contract comments + redeemMany same mux pattern)
      expect(recipientQ).to.equal(
        expectedRecipientAmount,
        `Expected 0 to recipient when transfer amount (${transferAmount}) exceeds burned total (${totalQuantity}); got ${recipientQ}`
      );
      expect(senderQ).to.equal(
        expectedSenderAmount,
        `Expected sender to retain full burned total ${expectedSenderAmount} when insufficient; got ${senderQ}`
      );
      expect(recipientQ + senderQ).to.equal(totalQuantity, "Total should be preserved");
      expect(transferredAmountForRecipient).to.equal(
        expectedRecipientAmount,
        `Recipient should decrypt transferred event amount as ${expectedRecipientAmount}`
      );
      expect(transferredAmountForSender).to.equal(
        expectedRecipientAmount,
        `Sender should decrypt transferred event amount as ${expectedRecipientAmount}`
      );
      expect(transferredAmountForRecipient).to.equal(recipientQ, "Transferred amount should match recipient OPRFMinted amount");

      // Verify all input tokens were invalidated (burned); reason 3 = burned per contract
      const invalidatedEvents = findParsedLogsInReceipt(transferReceipt, privateToken, "OPRFTokenInvalidated").filter(
        (log) => Number(privateToken.interface.parseLog(log)!.args[4]) === 3
      );

      expect(invalidatedEvents.length).to.equal(mintedTokens.length, "All input tokens should be invalidated");
    });

    it("Should successfully redeem multiple OPRF tokens with sufficient balance", async function () {
      this.timeout(1200000); // 20 minutes — multiple mints + redeemMany + MPC can exceed 10m on remote networks

      console.log("\n[TEST] Starting redeemMany test...");
      
      // Setup: Prepare balances and recipient
      console.log("[TEST] Step 1: Setting up balances...");
      const additionalShieldAmount = hre.ethers.parseEther("150");
      await mintApproveAndShield({
        mockToken,
        privateToken,
        recipient: userAddress,
        amount: additionalShieldAmount,
      });
      await delay(DELAY_STANDARD_MS);
      console.log("[TEST] Step 1.1: Minted underlying, approved, and shielded");

      // Setup recipient wallet and get their encryption key
      console.log("[TEST] Step 2: Setting up recipient wallet...");
      const recipientWallet = Wallet.createRandom().connect(hre.ethers.provider);
      const recipientAddress = await recipientWallet.getAddress();
      console.log(`[TEST] Step 2.1: Created recipient wallet: ${recipientAddress}`);
      
      const fundTx = await defaultSigner.sendTransaction({
        to: recipientAddress,
        value: hre.ethers.parseEther("0.01")
      });
      await fundTx.wait();
      console.log("[TEST] Step 2.2: Funded recipient wallet");

      console.log("[TEST] Step 2.3: Getting recipient AES key...");
      const recipientAesKey = await getUserKeyViaProxy(recipientWallet as any, PROXY_URL);
      console.log("[TEST] Step 2.4: Got recipient AES key");

      // Mint multiple OPRF tokens
      console.log("[TEST] Step 3: Minting OPRF tokens...");
      const tokenQuantities = [30n, 40n, 50n]; // Total: 120 tokens
      const redeemAmount = 100n; // Redeem 100 tokens as private tokens (sender keeps 20 as OPRF)
      const expectedRemainder = 20n; // 120 - 100 = 20
      
      interface MintedToken {
        x: bigint;
        q: bigint;
        y: bigint;
      }
      const mintedTokens: MintedToken[] = [];

      for (let i = 0; i < tokenQuantities.length; i++) {
        console.log(`[TEST] Step 3.${i + 1}: Minting token ${i + 1}/${tokenQuantities.length} with quantity ${tokenQuantities[i]}`);
        const quantity = tokenQuantities[i];
        
        const quantityIT = await buildSignedItUint256({
        value: quantity,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });
        const mintTx = await privateToken.mintOPRFToken(quantityIT);
        const mintReceipt = await mintTx.wait();
        expect(mintReceipt?.status).to.equal(1);

        await delay(DELAY_MPC_PROCESSING_MS);

        const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
        expect(mintHandles).to.not.be.undefined;
        const { xHandle, yHandle, qHandle } = mintHandles!;

        await delay(DELAY_BALANCE_SYNC_MS);

        const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
          [xHandle, yHandle, qHandle],
          defaultSigner,
          userAesKey,
          PROXY_URL
        );

        mintedTokens.push({
          x: decryptedX,
          q: decryptedQ,
          y: decryptedY
        });
      }

      const totalQuantity = mintedTokens.reduce((sum, token) => sum + token.q, 0n);
      console.log(`[TEST] Step 3.4: Total minted quantity: ${totalQuantity}`);

      // Prepare tokens for redeemMany
      console.log("[TEST] Step 4: Preparing tokens for redeemMany...");
      const tokensToRedeem = await Promise.all(
        mintedTokens.map(async (token) => {
          const xSigned = await buildSignedItUint128({
            value: token.x,
            userAddress,
            userAesKeyHex,
            contractAddress: await privateToken.getAddress(),
            signer: defaultSigner,
          });
          const qSigned = await buildSignedItUint256({
            value: token.q,
            userAddress,
            userAesKeyHex,
            contractAddress: await privateToken.getAddress(),
            signer: defaultSigner,
          });
          return {
            x: { userAddress: xSigned.userAddress, ciphertext: xSigned.ciphertext, signature: xSigned.signature },
            q: { userAddress: qSigned.userAddress, ciphertext: qSigned.ciphertext, signature: qSigned.signature },
            y_clear: token.y,
          };
        })
      );

      // Prepare encrypted redeem amount
      const encryptedRedeemAmount = await buildSignedItUint256({
        value: redeemAmount,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
        signer: defaultSigner,
      });
      const recipientBalanceBeforeDecrypted = 0n;

      // Execute redeemMany
      console.log("[TEST] Step 5: Executing redeemMany transaction...");
      const redeemTx = await privateToken.redeemMany(
        tokensToRedeem,
        encryptedRedeemAmount,
        recipientAddress
      );
      console.log(`[TEST] Step 5.1: RedeemMany tx hash: ${redeemTx.hash}`);
      console.log(`[TEST] Step 5.2: Waiting for transaction confirmation (this may take a while)...`);
      const redeemReceipt = await redeemTx.wait();
      console.log(`[TEST] Step 5.3: RedeemMany tx confirmed in block ${redeemReceipt?.blockNumber}`);
      expect(redeemReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      console.log("[TEST] Step 6: Waiting 30s for MPC computation to complete...");
      await delay(DELAY_MPC_REDEEM_MS);
      console.log("[TEST] Step 6.1: Wait completed");

      // Extract events
      console.log("[TEST] Step 7: Extracting events from transaction...");
      const burnEvents = redeemReceipt?.logs.filter((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFBurned";
        } catch {
          return false;
        }
      });
      
      const burnEvent = burnEvents?.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          const eventRecipient = decoded?.args[1];
          return eventRecipient.toLowerCase() === recipientAddress.toLowerCase();
        } catch {
          return false;
        }
      });
      
      expect(burnEvent).to.not.be.undefined;

      const burnDecoded = privateToken.interface.parseLog(burnEvent!);
      const burnedUser = burnDecoded?.args[0];
      const burnedRecipient = burnDecoded?.args[1];
      const burnedAmountHandle = burnDecoded?.args[2];

      expect(burnedUser).to.equal(userAddress);
      expect(burnedRecipient).to.equal(recipientAddress);

      const mintedEvents = findParsedLogsInReceipt(redeemReceipt, privateToken, "OPRFMinted");

      // Decrypt and verify results
      console.log("[TEST] Step 8: Waiting 20s before decryption...");
      await delay(DELAY_MPC_EXTENDED_MS);
      console.log("[TEST] Step 8.1: Starting decryption...");

      let remainderQHandle: bigint | undefined;
      if (mintedEvents.length > 0) {
        const remainderEvent = findParsedLogInReceiptWhere(
          redeemReceipt,
          privateToken,
          "OPRFMinted",
          (p) => String(p.args?.[0]).toLowerCase() === userAddress.toLowerCase()
        );

        if (remainderEvent) {
          const remainderDecoded = privateToken.interface.parseLog(remainderEvent);
          remainderQHandle = remainderDecoded?.args[3];
        }
      }

      let decryptedBurnedAmount: bigint;
      let decryptedRemainderQ = 0n;
      
      if (remainderQHandle !== undefined) {
        console.log("[TEST] Step 8.2: Decrypting burned amount and remainder (batch)...");
        const [decryptedBurned, decryptedRemainder] = await decryptMultipleValuesViaProxy(
          [burnedAmountHandle, remainderQHandle],
          defaultSigner,
          userAesKey,
          PROXY_URL
        );
        decryptedBurnedAmount = decryptedBurned;
        decryptedRemainderQ = decryptedRemainder;
        console.log("[TEST] Step 8.3: Batch decryption completed");
      } else {
        console.log("[TEST] Step 8.2: Decrypting burned amount only...");
        decryptedBurnedAmount = await decryptValueViaProxy(burnedAmountHandle, defaultSigner, userAesKey, PROXY_URL);
        console.log("[TEST] Step 8.3: Burned amount decryption completed");
      }

      console.log("[TEST] Step 9: Getting recipient balance...");
      const recipientBalanceAfter = await privateToken["balanceOf(address)"](recipientAddress);
      await delay(DELAY_BALANCE_SYNC_MS);
      console.log("[TEST] Step 9.1: Decrypting recipient balance...");
      const recipientBalanceAfterDecrypted = await decryptValueViaProxy(recipientBalanceAfter, recipientWallet, recipientAesKey, PROXY_URL);
      console.log("[TEST] Step 9.2: Recipient balance decryption completed");

      // Verify correctness
      // Verify burned amount equals total quantity (all tokens were burned)
      expect(decryptedBurnedAmount).to.equal(totalQuantity, "Burned amount should equal total quantity burned");

      // Verify remainder is correct
      expect(decryptedRemainderQ).to.equal(expectedRemainder, "Remainder should equal total minus redeem amount");

      // Verify total is preserved: transferred amount + remainder = total burned
      // Note: decryptedBurnedAmount is totalBurned, not recipientAmount
      // So we verify: balanceIncrease (actual transferred) + remainder = totalBurned
      const balanceIncrease = recipientBalanceAfterDecrypted - recipientBalanceBeforeDecrypted;
      expect(balanceIncrease + decryptedRemainderQ).to.equal(decryptedBurnedAmount, "Transferred + remainder should equal total burned");

      // Verify recipient received the private tokens (actual transferred amount)
      // balanceIncrease is calculated above in the total preservation check
      expect(balanceIncrease).to.equal(redeemAmount, "Recipient should receive the redeemed amount as private tokens");

      // Verify all input tokens were invalidated (burned); reason 3 = burned per contract
      const invalidatedEvents = findParsedLogsInReceipt(redeemReceipt, privateToken, "OPRFTokenInvalidated").filter(
        (log) => Number(privateToken.interface.parseLog(log)!.args[4]) === 3
      );

      expect(invalidatedEvents.length).to.equal(mintedTokens.length, "All input tokens should be invalidated");
    });

    it("Should redeemManyToUnderlying and unshield redeemed amount to recipient", async function () {
      this.timeout(1200000); // 20 minutes — includes async unshield callback

      const additionalShieldAmount = hre.ethers.parseEther("150");
      await mintApproveAndShield({
        mockToken,
        privateToken,
        recipient: userAddress,
        amount: additionalShieldAmount,
      });
      await delay(DELAY_STANDARD_MS);

      const recipientWallet = Wallet.createRandom().connect(hre.ethers.provider);
      const recipientAddress = await recipientWallet.getAddress();

      await defaultSigner.sendTransaction({
        to: recipientAddress,
        value: hre.ethers.parseEther("0.01"),
      }).then((tx: any) => tx.wait());

      const recipientAesKey = await getUserKeyViaProxy(recipientWallet as any, PROXY_URL);

      const tokenQuantities = [30n, 40n, 50n]; // Total: 120
      const redeemAmount = 100n; // Unshield 100 to underlying
      const expectedRemainder = 20n;
      const mintedTokens: Array<{ x: bigint; q: bigint; y: bigint }> = [];

      for (let i = 0; i < tokenQuantities.length; i++) {
        const quantityIT = buildUnsignedItUint256({
          value: tokenQuantities[i],
          userAddress,
          userAesKeyHex,
          contractAddress: await privateToken.getAddress(),
        });

        const mintTx = await privateToken.mintOPRFToken(quantityIT);
        const mintReceipt = await mintTx.wait();
        expect(mintReceipt?.status).to.equal(1);

        await delay(DELAY_MPC_PROCESSING_MS);
        const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
        expect(mintHandles).to.not.be.undefined;
        const { xHandle, yHandle, qHandle } = mintHandles!;

        await delay(DELAY_BALANCE_SYNC_MS);
        const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
          [xHandle, yHandle, qHandle],
          defaultSigner,
          userAesKey,
          PROXY_URL
        );

        mintedTokens.push({ x: decryptedX, q: decryptedQ, y: decryptedY });
      }

      const totalQuantity = mintedTokens.reduce((sum, token) => sum + token.q, 0n);
      const recipientUnderlyingBefore = await mockToken.balanceOf(recipientAddress);

      const tokensToRedeem = await Promise.all(
        mintedTokens.map(async (token) => {
          const x = buildUnsignedItUint128({
            value: token.x,
            userAddress,
            userAesKeyHex,
            contractAddress: await privateToken.getAddress(),
          });
          const q = buildUnsignedItUint256({
            value: token.q,
            userAddress,
            userAesKeyHex,
            contractAddress: await privateToken.getAddress(),
          });
          return {
            x: { userAddress: x.userAddress, ciphertext: x.ciphertext },
            q: { userAddress: q.userAddress, ciphertext: q.ciphertext },
            y_clear: token.y,
          };
        })
      );

      const encryptedRedeemAmount = buildUnsignedItUint256({
        value: redeemAmount,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
      });

      const startBlock = await hre.ethers.provider.getBlockNumber();
      const redeemTx = await privateToken.redeemManyToUnderlying(
        tokensToRedeem,
        encryptedRedeemAmount,
        recipientAddress,
        false
      );
      const redeemReceipt = await redeemTx.wait();
      expect(redeemReceipt?.status).to.equal(1);

      await delay(DELAY_MPC_REDEEM_MS);

      const { successEvents, failedEvents } = await waitForUnshieldOutcome(privateToken, hre, startBlock, {
        timeoutMs: 180000,
        pollIntervalMs: 3000,
      });
      expect(failedEvents.length).to.equal(0, "Unshield callback should not fail");
      expect(successEvents.length).to.be.greaterThan(0, "Expected unshield success event");

      const burnEvent = findParsedLogInReceiptWhere(
        redeemReceipt,
        privateToken,
        "OPRFBurned",
        (p) => String(p.args?.[1]).toLowerCase() === recipientAddress.toLowerCase()
      );
      expect(burnEvent).to.not.be.undefined;
      const burnDecoded = privateToken.interface.parseLog(burnEvent!);
      const burnedAmountHandle = burnDecoded?.args[2];

      const remainderEvent = findParsedLogInReceiptWhere(
        redeemReceipt,
        privateToken,
        "OPRFMinted",
        (p) => String(p.args?.[0]).toLowerCase() === userAddress.toLowerCase()
      );
      expect(remainderEvent).to.not.be.undefined;
      const remainderDecoded = privateToken.interface.parseLog(remainderEvent!);
      const remainderQHandle = remainderDecoded?.args[3];

      const [decryptedBurnedAmount, decryptedRemainderQ] = await decryptMultipleValuesViaProxy(
        [burnedAmountHandle, remainderQHandle],
        defaultSigner,
        userAesKey,
        PROXY_URL
      );

      const recipientPrivateBalanceHandle = await privateToken["balanceOf(address)"](recipientAddress);
      await delay(DELAY_BALANCE_SYNC_MS);
      const recipientPrivateBalance =
        recipientPrivateBalanceHandle === 0n
          ? 0n
          : await decryptValueViaProxy(recipientPrivateBalanceHandle, recipientWallet, recipientAesKey, PROXY_URL);

      const recipientUnderlyingAfter = await mockToken.balanceOf(recipientAddress);
      const underlyingIncrease = recipientUnderlyingAfter - recipientUnderlyingBefore;

      expect(decryptedBurnedAmount).to.equal(totalQuantity, "Burned amount should equal total burned OPRF quantity");
      expect(decryptedRemainderQ).to.equal(expectedRemainder, "Sender remainder should be total minus redeemed amount");
      expect(recipientPrivateBalance).to.equal(0n, "Recipient private balance should net to zero after immediate unshield");
      expect(underlyingIncrease).to.equal(redeemAmount, "Recipient should receive redeemed amount as underlying tokens");
      expect(underlyingIncrease + decryptedRemainderQ).to.equal(decryptedBurnedAmount, "Total should be preserved");

      const invalidatedEvents = findParsedLogsInReceipt(redeemReceipt, privateToken, "OPRFTokenInvalidated").filter(
        (log) => Number(privateToken.interface.parseLog(log)!.args[4]) === 3
      );
      expect(invalidatedEvents.length).to.equal(mintedTokens.length, "All input tokens should be invalidated");
    });

    it.only("Should redeemManyToUnderlying with unwrap=true using local MockWETH", async function () {
      this.timeout(1200000);

      const wrapAmount = hre.ethers.parseEther("0.001"); // 0.001 ETH -> WETH
      const redeemAmount = hre.ethers.parseEther("0.0005"); // unwrap 0.0005 ETH
      const expectedRemainder = wrapAmount - redeemAmount;

      const MockWethFactory = await hre.ethers.getContractFactory("MockWETH", defaultSigner);
      const weth = await MockWethFactory.deploy();
      await weth.waitForDeployment();
      const wethAddress = await weth.getAddress();

      const wethBackedPrivateToken = await deployPrivateToken(hre, defaultSigner, {
        underlyingAddress: wethAddress,
        ownerAddress: userAddress,
        masterAddress: userAddress,
        name: "WETH Private Token",
        symbol: "pWETH",
        underlyingIsWrappedNative: true,
      });

      // Wrap small ETH amount before test execution.
      await (await weth.deposit({ value: wrapAmount })).wait();
      await (await weth.approve(await wethBackedPrivateToken.getAddress(), wrapAmount)).wait();
      await (await wethBackedPrivateToken.shield(wrapAmount)).wait();
      await delay(DELAY_BALANCE_SYNC_MS);

      const recipientWallet = Wallet.createRandom().connect(hre.ethers.provider);
      const recipientAddress = await recipientWallet.getAddress();
      const recipientAesKey = await getUserKeyViaProxy(recipientWallet as any, PROXY_URL);
      const recipientEthBefore = await hre.ethers.provider.getBalance(recipientAddress);
      const contractWethBefore = await weth.balanceOf(await wethBackedPrivateToken.getAddress());

      const quantityIT = buildUnsignedItUint256({
        value: wrapAmount,
        userAddress,
        userAesKeyHex,
        contractAddress: await wethBackedPrivateToken.getAddress(),
      });

      const mintTx = await wethBackedPrivateToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);
      await delay(DELAY_MPC_PROCESSING_MS);

      const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, wethBackedPrivateToken);
      expect(mintHandles).to.not.be.undefined;
      const { xHandle, yHandle, qHandle } = mintHandles!;

      await delay(DELAY_BALANCE_SYNC_MS);
      const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
        [xHandle, yHandle, qHandle],
        defaultSigner,
        userAesKey,
        PROXY_URL
      );
      expect(decryptedQ).to.equal(wrapAmount);

      const x = buildUnsignedItUint128({
        value: decryptedX,
        userAddress,
        userAesKeyHex,
        contractAddress: await wethBackedPrivateToken.getAddress(),
      });
      const q = buildUnsignedItUint256({
        value: decryptedQ,
        userAddress,
        userAesKeyHex,
        contractAddress: await wethBackedPrivateToken.getAddress(),
      });
      const tokensToRedeem = [
        {
          x: { userAddress: x.userAddress, ciphertext: x.ciphertext },
          q: { userAddress: q.userAddress, ciphertext: q.ciphertext },
          y_clear: decryptedY,
        },
      ];

      const encryptedRedeemAmount = buildUnsignedItUint256({
        value: redeemAmount,
        userAddress,
        userAesKeyHex,
        contractAddress: await wethBackedPrivateToken.getAddress(),
      });

      const startBlock = await hre.ethers.provider.getBlockNumber();
      const redeemTx = await wethBackedPrivateToken.redeemManyToUnderlying(
        tokensToRedeem,
        encryptedRedeemAmount,
        recipientAddress,
        true
      );
      const redeemReceipt = await redeemTx.wait();
      expect(redeemReceipt?.status).to.equal(1);

      const { successEvents, failedEvents } = await waitForUnshieldOutcome(wethBackedPrivateToken, hre, startBlock, {
        timeoutMs: 180000,
        pollIntervalMs: 3000,
      });
      expect(failedEvents.length).to.equal(0);
      expect(successEvents.length).to.be.greaterThan(0);
      const unshieldForRecipient = successEvents.find(
        (e: any) => String(e.args?.[0]).toLowerCase() === recipientAddress.toLowerCase()
      );
      expect(unshieldForRecipient).to.not.be.undefined;
      const unshieldAmount = unshieldForRecipient?.args?.[1];
      expect(unshieldAmount).to.equal(redeemAmount, "Unshield event amount should equal redeemed amount");

      const recipientEthAfter = await hre.ethers.provider.getBalance(recipientAddress);
      expect(recipientEthAfter - recipientEthBefore).to.equal(redeemAmount, "Recipient should receive native ETH");
      const contractWethAfter = await weth.balanceOf(await wethBackedPrivateToken.getAddress());
      expect(contractWethBefore - contractWethAfter).to.equal(redeemAmount, "Contract WETH should decrease by unwrapped amount");

      const recipientPrivateBalanceHandle = await wethBackedPrivateToken["balanceOf(address)"](recipientAddress);
      await delay(DELAY_BALANCE_SYNC_MS);
      const recipientPrivateBalance =
        recipientPrivateBalanceHandle === 0n
          ? 0n
          : await decryptValueViaProxy(recipientPrivateBalanceHandle, recipientWallet, recipientAesKey, PROXY_URL);
      expect(recipientPrivateBalance).to.equal(0n, "Recipient private balance should be zero after unwrap path");

      const burnEvent = findParsedLogInReceiptWhere(
        redeemReceipt,
        wethBackedPrivateToken,
        "OPRFBurned",
        (p) => String(p.args?.[1]).toLowerCase() === recipientAddress.toLowerCase()
      );
      expect(burnEvent).to.not.be.undefined;
      const burnDecoded = wethBackedPrivateToken.interface.parseLog(burnEvent!);
      const burnedAmountHandle = burnDecoded?.args[2];
      const decryptedBurnedAmount = await decryptValueViaProxy(burnedAmountHandle, defaultSigner, userAesKey, PROXY_URL);
      expect(decryptedBurnedAmount).to.equal(wrapAmount, "Burned amount should equal total redeemed token quantity");

      const remainderEvent = findParsedLogInReceiptWhere(
        redeemReceipt,
        wethBackedPrivateToken,
        "OPRFMinted",
        (p) => String(p.args?.[0]).toLowerCase() === userAddress.toLowerCase()
      );
      expect(remainderEvent).to.not.be.undefined;
      const remainderDecoded = wethBackedPrivateToken.interface.parseLog(remainderEvent!);
      const remainderQHandle = remainderDecoded?.args[3];
      const decryptedRemainderQ = await decryptValueViaProxy(remainderQHandle, defaultSigner, userAesKey, PROXY_URL);
      expect(decryptedRemainderQ).to.equal(expectedRemainder);
      expect(redeemAmount + decryptedRemainderQ).to.equal(decryptedBurnedAmount, "Unwrapped amount + remainder should preserve total");

      const invalidatedEvents = findParsedLogsInReceipt(redeemReceipt, wethBackedPrivateToken, "OPRFTokenInvalidated").filter(
        (log) => Number(wethBackedPrivateToken.interface.parseLog(log)!.args[4]) === 3
      );
      expect(invalidatedEvents.length).to.equal(1, "Input OPRF token should be invalidated");
    });

    it("unwrap=true should revert when underlyingIsWrappedNative=false before burning", async function () {
      this.timeout(600000);

      const MockWethFactory = await hre.ethers.getContractFactory("MockWETH", defaultSigner);
      const weth = await MockWethFactory.deploy();
      await weth.waitForDeployment();

      const nonWrappedConfiguredToken = await deployPrivateToken(hre, defaultSigner, {
        underlyingAddress: await weth.getAddress(),
        ownerAddress: userAddress,
        masterAddress: userAddress,
        name: "Not Wrapped Config",
        symbol: "NWC",
        underlyingIsWrappedNative: false,
      });

      const wrapAmount = hre.ethers.parseEther("0.0002");
      await (await weth.deposit({ value: wrapAmount })).wait();
      await (await weth.approve(await nonWrappedConfiguredToken.getAddress(), wrapAmount)).wait();
      await (await nonWrappedConfiguredToken.shield(wrapAmount)).wait();
      await delay(DELAY_BALANCE_SYNC_MS);

      const quantityIT = buildUnsignedItUint256({
        value: wrapAmount,
        userAddress,
        userAesKeyHex,
        contractAddress: await nonWrappedConfiguredToken.getAddress(),
      });
      const mintTx = await nonWrappedConfiguredToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);
      await delay(DELAY_MPC_PROCESSING_MS);

      const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, nonWrappedConfiguredToken)!;
      const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
        [mintHandles.xHandle, mintHandles.yHandle, mintHandles.qHandle],
        defaultSigner,
        userAesKey,
        PROXY_URL
      );

      const tokenInput = [{
        x: buildUnsignedItUint128({
          value: decryptedX,
          userAddress,
          userAesKeyHex,
          contractAddress: await nonWrappedConfiguredToken.getAddress(),
        }),
        q: buildUnsignedItUint256({
          value: decryptedQ,
          userAddress,
          userAesKeyHex,
          contractAddress: await nonWrappedConfiguredToken.getAddress(),
        }),
        y_clear: decryptedY,
      }].map((t) => ({
        x: { userAddress: t.x.userAddress, ciphertext: t.x.ciphertext },
        q: { userAddress: t.q.userAddress, ciphertext: t.q.ciphertext },
        y_clear: t.y_clear,
      }));

      const redeemAmountIT = buildUnsignedItUint256({
        value: hre.ethers.parseEther("0.0001"),
        userAddress,
        userAesKeyHex,
        contractAddress: await nonWrappedConfiguredToken.getAddress(),
      });

      await expect(
        nonWrappedConfiguredToken.redeemManyToUnderlying(tokenInput, redeemAmountIT, userAddress, true)
      ).to.be.revertedWith("Underlying unwrap not configured");
    });

    it("insufficient redeem with unwrap=true should emit UnshieldFailed and keep full remainder", async function () {
      this.timeout(900000);

      const MockWethFactory = await hre.ethers.getContractFactory("MockWETH", defaultSigner);
      const weth = await MockWethFactory.deploy();
      await weth.waitForDeployment();

      const wrappedToken = await deployPrivateToken(hre, defaultSigner, {
        underlyingAddress: await weth.getAddress(),
        ownerAddress: userAddress,
        masterAddress: userAddress,
        name: "Wrapped Insufficient",
        symbol: "WIN",
        underlyingIsWrappedNative: true,
      });

      const wrapAmount = hre.ethers.parseEther("0.0002");
      const requestedRedeem = hre.ethers.parseEther("0.0003"); // intentionally larger than burned
      await (await weth.deposit({ value: wrapAmount })).wait();
      await (await weth.approve(await wrappedToken.getAddress(), wrapAmount)).wait();
      await (await wrappedToken.shield(wrapAmount)).wait();
      await delay(DELAY_BALANCE_SYNC_MS);

      const quantityIT = buildUnsignedItUint256({
        value: wrapAmount,
        userAddress,
        userAesKeyHex,
        contractAddress: await wrappedToken.getAddress(),
      });
      const mintTx = await wrappedToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);
      await delay(DELAY_MPC_PROCESSING_MS);

      const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, wrappedToken)!;
      const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
        [mintHandles.xHandle, mintHandles.yHandle, mintHandles.qHandle],
        defaultSigner,
        userAesKey,
        PROXY_URL
      );

      const tokenInput = [{
        x: buildUnsignedItUint128({
          value: decryptedX,
          userAddress,
          userAesKeyHex,
          contractAddress: await wrappedToken.getAddress(),
        }),
        q: buildUnsignedItUint256({
          value: decryptedQ,
          userAddress,
          userAesKeyHex,
          contractAddress: await wrappedToken.getAddress(),
        }),
        y_clear: decryptedY,
      }].map((t) => ({
        x: { userAddress: t.x.userAddress, ciphertext: t.x.ciphertext },
        q: { userAddress: t.q.userAddress, ciphertext: t.q.ciphertext },
        y_clear: t.y_clear,
      }));

      const redeemAmountIT = buildUnsignedItUint256({
        value: requestedRedeem,
        userAddress,
        userAesKeyHex,
        contractAddress: await wrappedToken.getAddress(),
      });

      const recipientWallet = Wallet.createRandom().connect(hre.ethers.provider);
      const startBlock = await hre.ethers.provider.getBlockNumber();
      const tx = await wrappedToken.redeemManyToUnderlying(tokenInput, redeemAmountIT, await recipientWallet.getAddress(), true);
      const receipt = await tx.wait();
      expect(receipt?.status).to.equal(1);

      const { successEvents, failedEvents } = await waitForUnshieldOutcome(wrappedToken, hre, startBlock, {
        timeoutMs: 180000,
        pollIntervalMs: 3000,
      });
      expect(successEvents.length).to.equal(0, "No successful unshield expected when recipient amount is zero");
      expect(failedEvents.length).to.be.greaterThan(0, "Expected UnshieldFailed for zero unshield amount");

      const remainderEvent = findParsedLogInReceiptWhere(
        receipt,
        wrappedToken,
        "OPRFMinted",
        (p) => String(p.args?.[0]).toLowerCase() === userAddress.toLowerCase()
      );
      expect(remainderEvent).to.not.be.undefined;
      const remainderQHandle = wrappedToken.interface.parseLog(remainderEvent!).args[3];
      const remainderQ = await decryptValueViaProxy(remainderQHandle, defaultSigner, userAesKey, PROXY_URL);
      expect(remainderQ).to.equal(wrapAmount, "Sender should keep full amount as remainder");
    });

    it("recipient pre-existing private balance should be preserved in unwrap path", async function () {
      this.timeout(900000);

      const MockWethFactory = await hre.ethers.getContractFactory("MockWETH", defaultSigner);
      const weth = await MockWethFactory.deploy();
      await weth.waitForDeployment();

      const wrappedToken = await deployPrivateToken(hre, defaultSigner, {
        underlyingAddress: await weth.getAddress(),
        ownerAddress: userAddress,
        masterAddress: userAddress,
        name: "Wrapped Preserve",
        symbol: "WPR",
        underlyingIsWrappedNative: true,
      });

      const recipientWallet = Wallet.createRandom().connect(hre.ethers.provider);
      const recipientAddress = await recipientWallet.getAddress();
      await (await defaultSigner.sendTransaction({ to: recipientAddress, value: hre.ethers.parseEther("0.01") })).wait();
      const recipientAesKey = await getUserKeyViaProxy(recipientWallet as any, PROXY_URL);

      const preExistingPrivate = hre.ethers.parseEther("0.0001");
      const toRedeem = hre.ethers.parseEther("0.0003");
      const totalWrap = preExistingPrivate + toRedeem;

      await (await weth.deposit({ value: totalWrap })).wait();
      await (await weth.approve(await wrappedToken.getAddress(), totalWrap)).wait();
      await (await wrappedToken.shield(preExistingPrivate)).wait();
      await (await wrappedToken.transfer(recipientAddress, preExistingPrivate)).wait();
      await (await wrappedToken.shield(toRedeem)).wait();
      await delay(DELAY_BALANCE_SYNC_MS);

      const recipientPrivateBeforeHandle = await wrappedToken["balanceOf(address)"](recipientAddress);
      const recipientPrivateBefore = await decryptValueViaProxy(recipientPrivateBeforeHandle, recipientWallet, recipientAesKey, PROXY_URL);
      expect(recipientPrivateBefore).to.equal(preExistingPrivate);

      const quantityIT = buildUnsignedItUint256({
        value: toRedeem,
        userAddress,
        userAesKeyHex,
        contractAddress: await wrappedToken.getAddress(),
      });
      const mintTx = await wrappedToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);
      await delay(DELAY_MPC_PROCESSING_MS);

      const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, wrappedToken)!;
      const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
        [mintHandles.xHandle, mintHandles.yHandle, mintHandles.qHandle],
        defaultSigner,
        userAesKey,
        PROXY_URL
      );

      const tokenInput = [{
        x: buildUnsignedItUint128({
          value: decryptedX,
          userAddress,
          userAesKeyHex,
          contractAddress: await wrappedToken.getAddress(),
        }),
        q: buildUnsignedItUint256({
          value: decryptedQ,
          userAddress,
          userAesKeyHex,
          contractAddress: await wrappedToken.getAddress(),
        }),
        y_clear: decryptedY,
      }].map((t) => ({
        x: { userAddress: t.x.userAddress, ciphertext: t.x.ciphertext },
        q: { userAddress: t.q.userAddress, ciphertext: t.q.ciphertext },
        y_clear: t.y_clear,
      }));

      const redeemAmountIT = buildUnsignedItUint256({
        value: toRedeem,
        userAddress,
        userAesKeyHex,
        contractAddress: await wrappedToken.getAddress(),
      });

      const startBlock = await hre.ethers.provider.getBlockNumber();
      const tx = await wrappedToken.redeemManyToUnderlying(tokenInput, redeemAmountIT, recipientAddress, true);
      await tx.wait();
      await waitForUnshieldOutcome(wrappedToken, hre, startBlock, {
        timeoutMs: 180000,
        pollIntervalMs: 3000,
      });

      const recipientPrivateAfterHandle = await wrappedToken["balanceOf(address)"](recipientAddress);
      const recipientPrivateAfter = await decryptValueViaProxy(recipientPrivateAfterHandle, recipientWallet, recipientAesKey, PROXY_URL);
      expect(recipientPrivateAfter).to.equal(preExistingPrivate, "Pre-existing private balance must remain unchanged");
    });

    it("recipient contract rejecting native ETH should prevent successful unshield callback", async function () {
      this.timeout(900000);

      const MockWethFactory = await hre.ethers.getContractFactory("MockWETH", defaultSigner);
      const weth = await MockWethFactory.deploy();
      await weth.waitForDeployment();

      const RejectRecipientFactory = await hre.ethers.getContractFactory("RejectNativeRecipient", defaultSigner);
      const rejectRecipient = await RejectRecipientFactory.deploy();
      await rejectRecipient.waitForDeployment();
      const rejectRecipientAddress = await rejectRecipient.getAddress();

      const wrappedToken = await deployPrivateToken(hre, defaultSigner, {
        underlyingAddress: await weth.getAddress(),
        ownerAddress: userAddress,
        masterAddress: userAddress,
        name: "Wrapped Reject",
        symbol: "WRJ",
        underlyingIsWrappedNative: true,
      });

      const wrapAmount = hre.ethers.parseEther("0.0002");
      await (await weth.deposit({ value: wrapAmount })).wait();
      await (await weth.approve(await wrappedToken.getAddress(), wrapAmount)).wait();
      await (await wrappedToken.shield(wrapAmount)).wait();
      await delay(DELAY_BALANCE_SYNC_MS);

      const quantityIT = buildUnsignedItUint256({
        value: wrapAmount,
        userAddress,
        userAesKeyHex,
        contractAddress: await wrappedToken.getAddress(),
      });
      const mintTx = await wrappedToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);
      await delay(DELAY_MPC_PROCESSING_MS);

      const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, wrappedToken)!;
      const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
        [mintHandles.xHandle, mintHandles.yHandle, mintHandles.qHandle],
        defaultSigner,
        userAesKey,
        PROXY_URL
      );

      const tokensToRedeem = [{
        x: buildUnsignedItUint128({
          value: decryptedX,
          userAddress,
          userAesKeyHex,
          contractAddress: await wrappedToken.getAddress(),
        }),
        q: buildUnsignedItUint256({
          value: decryptedQ,
          userAddress,
          userAesKeyHex,
          contractAddress: await wrappedToken.getAddress(),
        }),
        y_clear: decryptedY,
      }].map((t) => ({
        x: { userAddress: t.x.userAddress, ciphertext: t.x.ciphertext },
        q: { userAddress: t.q.userAddress, ciphertext: t.q.ciphertext },
        y_clear: t.y_clear,
      }));

      const redeemAmountIT = buildUnsignedItUint256({
        value: wrapAmount,
        userAddress,
        userAesKeyHex,
        contractAddress: await wrappedToken.getAddress(),
      });

      const startBlock = await hre.ethers.provider.getBlockNumber();
      const tx = await wrappedToken.redeemManyToUnderlying(tokensToRedeem, redeemAmountIT, rejectRecipientAddress, true);
      await tx.wait();

      const { successEvents, failedEvents } = await waitForUnshieldOutcome(wrappedToken, hre, startBlock, {
        timeoutMs: 60000,
        pollIntervalMs: 3000,
      });

      expect(successEvents.length).to.equal(0, "No successful unshield event expected for rejecting recipient");
      expect(failedEvents.length).to.equal(0, "Callback reverts on native push failure, so UnshieldFailed is not emitted");
    });

    // Tests that redeemMany correctly handles insufficient balance:
    // When redeem amount exceeds available tokens, recipient should get 0 and sender keeps all tokens
    it("redeemMany with insufficient balance should return 0 to recipient", async function () {
      this.timeout(300000); // 5 minutes - MPC operations take time

      console.log("Step 1: Setup - preparing balances and recipient...");
      // ========== Setup: Prepare balances and recipient ==========
      const additionalShieldAmount = hre.ethers.parseEther("150");
      await mintApproveAndShield({
        mockToken,
        privateToken,
        recipient: userAddress,
        amount: additionalShieldAmount,
      });
      await delay(DELAY_STANDARD_MS);

      // Setup recipient wallet and get their encryption key
      const recipientWallet = Wallet.createRandom().connect(hre.ethers.provider);
      const recipientAddress = await recipientWallet.getAddress();
      
      await defaultSigner.sendTransaction({
        to: recipientAddress,
        value: hre.ethers.parseEther("0.01")
      }).then((tx: any) => tx.wait());

      const recipientAesKey = await getUserKeyViaProxy(recipientWallet as any, PROXY_URL);
      console.log("   Setup complete");

      const tokenQuantities = [30n, 40n, 50n]; // Total: 120 tokens
      const redeemAmount = 150n; // Try to redeem 150 tokens (insufficient - more than available)
      const expectedRedeemedAmount = 0n; // Should redeem 0 when insufficient
      const expectedRemainder = 120n; // Sender should get all tokens back as OPRF
      
      interface MintedToken {
        x: bigint;
        q: bigint;
        y: bigint;
      }
      const mintedTokens: MintedToken[] = [];

      console.log("Step 2: Minting OPRF tokens...");
      for (let i = 0; i < tokenQuantities.length; i++) {
        const quantity = tokenQuantities[i];

        const quantityIT = buildUnsignedItUint256({
          value: quantity,
          userAddress,
          userAesKeyHex,
          contractAddress: await privateToken.getAddress(),
        });

        console.log(`   Minting token ${i + 1}/${tokenQuantities.length} (qty: ${quantity})...`);
        const mintTx = await privateToken.mintOPRFToken(quantityIT);
        const mintReceipt = await mintTx.wait();
        expect(mintReceipt?.status).to.equal(1);

        await delay(DELAY_MPC_PROCESSING_MS);

        const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
        expect(mintHandles).to.not.be.undefined;
        const { xHandle, yHandle, qHandle } = mintHandles!;

        await delay(DELAY_BALANCE_SYNC_MS);

        const [decryptedX, decryptedY, decryptedQ] = await decryptMultipleValuesViaProxy(
          [xHandle, yHandle, qHandle],
          defaultSigner,
          userAesKey,
          PROXY_URL
        );
        console.log(`   Token ${i + 1} minted and decrypted`);


        mintedTokens.push({
          x: decryptedX,
          q: decryptedQ,
          y: decryptedY
        });
      }

      const totalQuantity = mintedTokens.reduce((sum, token) => sum + token.q, 0n);
      console.log(`   All tokens minted. Total: ${totalQuantity}`);

      console.log("Step 3: Preparing tokens for redeemMany...");
      const tokensToRedeem = await Promise.all(
        mintedTokens.map(async (token) => {
          const x = buildUnsignedItUint128({
            value: token.x,
            userAddress,
            userAesKeyHex,
            contractAddress: await privateToken.getAddress(),
          });
          const q = buildUnsignedItUint256({
            value: token.q,
            userAddress,
            userAesKeyHex,
            contractAddress: await privateToken.getAddress(),
          });
          return {
            x: { userAddress: x.userAddress, ciphertext: x.ciphertext },
            q: { userAddress: q.userAddress, ciphertext: q.ciphertext },
            y_clear: token.y,
          };
        })
      );
      console.log("   Tokens prepared");

      console.log("Step 4: Preparing encrypted redeem amount...");
      const encryptedRedeemAmount = buildUnsignedItUint256({
        value: redeemAmount,
        userAddress,
        userAesKeyHex,
        contractAddress: await privateToken.getAddress(),
      });

      const recipientBalanceBeforeDecrypted = 0n;

      console.log("Step 5: Executing redeemMany (insufficient balance test)...");
      const redeemTx = await privateToken.redeemMany(
        tokensToRedeem,
        encryptedRedeemAmount,
        recipientAddress
      );
      const redeemReceipt = await redeemTx.wait();
      expect(redeemReceipt?.status).to.equal(1);
      console.log("   Redeem transaction confirmed");

      console.log("Step 6: Waiting for MPC computation (30s)...");
      await delay(DELAY_MPC_REDEEM_MS);

      console.log("Step 7: Extracting events...");
      const burnEvent = findParsedLogInReceiptWhere(
        redeemReceipt,
        privateToken,
        "OPRFBurned",
        (p) => String(p.args?.[1]).toLowerCase() === recipientAddress.toLowerCase()
      );

      expect(burnEvent).to.not.be.undefined;

      const burnDecoded = privateToken.interface.parseLog(burnEvent!);
      const burnedAmountHandle = burnDecoded?.args[2];

      const mintedEvents = findParsedLogsInReceipt(redeemReceipt, privateToken, "OPRFMinted");
      console.log("   Events extracted");

      console.log("Step 8: Decrypting results...");
      await delay(DELAY_MPC_PROCESSING_MS);

      const decryptedBurnedAmount = await decryptValueViaProxy(burnedAmountHandle, defaultSigner, userAesKey, PROXY_URL);
      console.log(`   Decrypted burned amount: ${decryptedBurnedAmount}`);

      let decryptedRemainderQ = 0n;
      if (mintedEvents.length > 0) {
        const remainderEvent = findParsedLogInReceiptWhere(
          redeemReceipt,
          privateToken,
          "OPRFMinted",
          (p) => String(p.args?.[0]).toLowerCase() === userAddress.toLowerCase()
        );

        if (remainderEvent) {
          const remainderDecoded = privateToken.interface.parseLog(remainderEvent);
          const remainderQHandle = remainderDecoded?.args[3];
          decryptedRemainderQ = await decryptValueViaProxy(remainderQHandle, defaultSigner, userAesKey, PROXY_URL);
        }
      }

      const recipientBalanceAfter = await privateToken["balanceOf(address)"](recipientAddress);
      await delay(DELAY_BALANCE_SYNC_MS);
      const recipientBalanceAfterDecrypted = await decryptValueViaProxy(recipientBalanceAfter, recipientWallet, recipientAesKey, PROXY_URL);
      console.log(`   Decryption complete. Recipient balance: ${recipientBalanceAfterDecrypted}, Sender remainder: ${decryptedRemainderQ}`);

      console.log("Step 9: Verifying results...");
      const balanceIncrease = recipientBalanceAfterDecrypted - recipientBalanceBeforeDecrypted;

      // Display verification summary
      console.log(`\n========== REDEEMMANY MUX LOGIC VERIFICATION ==========`);
      console.log(`Total tokens available: ${totalQuantity}`);
      console.log(`Attempted redeem: ${redeemAmount}`);
      console.log(`Overflow expected: YES (${redeemAmount} > ${totalQuantity})`);
      console.log(`Recipient balance increase: ${balanceIncrease}`);
      console.log(`Sender remainder (OPRF): ${decryptedRemainderQ}`);
      console.log(`Sum: ${balanceIncrease + decryptedRemainderQ}`);
      console.log(`=====================================================\n`);

      // Verify burned amount equals total quantity (all tokens were burned)
      expect(decryptedBurnedAmount).to.equal(totalQuantity, "Burned amount should equal total quantity");

      // Verify remainder contains all tokens (sender gets everything back when insufficient)
      expect(decryptedRemainderQ).to.equal(expectedRemainder, "Sender should receive all tokens back as OPRF remainder");

      // Verify total is preserved
      expect(balanceIncrease + decryptedRemainderQ).to.equal(decryptedBurnedAmount, "Total should be preserved");

      // Verify recipient did not receive any private tokens
      expect(balanceIncrease).to.equal(expectedRedeemedAmount, "Recipient should receive 0 when balance is insufficient");

      // Verify all input tokens were invalidated (burned); reason 3 = burned per contract
      const invalidatedEvents = findParsedLogsInReceipt(redeemReceipt, privateToken, "OPRFTokenInvalidated").filter(
        (log) => Number(privateToken.interface.parseLog(log)!.args[4]) === 3
      );

      expect(invalidatedEvents.length).to.equal(mintedTokens.length, "All input tokens should be invalidated");
    });
  });
});
