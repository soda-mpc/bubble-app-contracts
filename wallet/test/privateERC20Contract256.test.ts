import { expect } from "chai";
import hre from "hardhat";
import { Wallet, HDNodeWallet } from "ethers";
import dotenv from "dotenv";

import { prepareMessageForBubble256, getUserKeyViaProxy, getDecryptionTxDataViaProxy, decryptValueViaProxy } from "./helpers/bubbleCryptoTransport";
import {
  createRandomWalletsAndFund,
  delay,
  DELAY_BALANCE_SYNC_MS,
  DELAY_MPC_DECRYPTION_MS,
  DELAY_MPC_PROCESSING_MS,
  DELAY_SHORT_MS,
  DELAY_STANDARD_MS,
  deployMockToken,
  deployPrivateToken,
  deployPrivateTokenImplementation,
  ensurePrivateBalanceClearedFor,
  findEventsFromStartBlockByName,
  findParsedLogInReceipt,
  getEventsInReceiptBlock,
  getPrivateTokenBalance,
  mintAndApprove,
  waitForContractCode,
  waitForUnshieldOutcome,
  skipUnlessBubbleNetwork,
} from "./helpers/testHelpers";

dotenv.config();

const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";

describe("PrivateERC20Contract256", function () {
  before(async function () {
    await skipUnlessBubbleNetwork(this);
  });

  this.timeout(120000); // 2 minutes timeout for MPC operations
  
  let userAesKey: Buffer;
  let userAesKeyHex: string;
  let userAddress: string;
  let privateToken: any;
  let mockToken: any;
let otherWallet: HDNodeWallet;
let masterWallet: HDNodeWallet;
let defaultSigner: any;

  before(async function () {
    // Get Hardhat's default signer
    [defaultSigner] = await hre.ethers.getSigners();

    // Setup main user with the default signer
    userAesKey = await getUserKeyViaProxy(defaultSigner as any, PROXY_URL);
    userAesKeyHex = userAesKey.toString("hex");
    userAddress = await defaultSigner.getAddress();

    [otherWallet, masterWallet] = await createRandomWalletsAndFund({
      hre,
      sender: defaultSigner,
      count: 2,
      amountWei: hre.ethers.parseEther("0.01"),
    }) as [HDNodeWallet, HDNodeWallet];

    mockToken = await deployMockToken(hre, defaultSigner);
    await delay(DELAY_STANDARD_MS);

    // Deploy private token using the upgradeable proxy pattern
    privateToken = await deployPrivateToken(hre, defaultSigner, {
      underlyingAddress: await mockToken.getAddress(),
      ownerAddress: defaultSigner.address,
      masterAddress: masterWallet.address,
    });
  });

  describe("Basic Token Information", function () {
    it("should have correct name, symbol and decimals", async function () {
      const contractAddress = await privateToken.getAddress();

      // Ensure contract bytecode is available before continuing
      await waitForContractCode(contractAddress, hre);
      const name = await privateToken.name();
      expect(name).to.equal("BubbleToken");

      const symbol = await privateToken.symbol();
      expect(symbol).to.equal("BUB");

      const decimals = await privateToken.decimals();
      expect(decimals).to.equal(await mockToken.decimals());
    });

    it("should start with zero total supply", async function () {
      expect(await privateToken.totalSupply()).to.equal(0);
    });

    it("should have zero initial balance for any address", async function () {
      const decryptedBalance = await getPrivateTokenBalance({
        privateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(decryptedBalance).to.equal(0n);
    });
  });

  describe("Shield/Unshield Operations", function () {
    this.timeout(120000); // 2 minutes timeout for MPC operations
    
    const shieldAmount = 150n * 10n ** 18n; // 150 tokens with 18 decimals
    const expectedPrivateAmount = shieldAmount;

    beforeEach(async function () {
      this.timeout(120000); // 2 minutes timeout for beforeEach

      // Check if mock token is deployed properly
      const code = await hre.ethers.provider.getCode(await mockToken.getAddress());
      if (code === "0x") {
        throw new Error("Mock token contract not deployed properly");
      }

      // Ensure user starts each test with zero private balance
      await ensurePrivateBalanceClearedFor({
        privateToken,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
        hre,
      });

      const connectedMockToken = mockToken.connect(defaultSigner);
      await mintAndApprove({
        mockToken: connectedMockToken,
        privateToken,
        userAddress,
        amount: shieldAmount,
      });
    });

    it("should successfully shield standard tokens into private tokens", async function () {
      await delay(DELAY_STANDARD_MS);

      const balanceBeforeShield = await getPrivateTokenBalance({
        privateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(balanceBeforeShield).to.equal(0n);

      const shieldTx = await privateToken.shield(shieldAmount);

      const shieldReceipt = await shieldTx.wait();

      await delay(DELAY_STANDARD_MS);

      expect(shieldReceipt).to.not.be.undefined;

      // Check Shield event (same window as before: [receiptBlock - 1000, min(receiptBlock, head)])
      const receiptBlock = shieldReceipt?.blockNumber ?? (await hre.ethers.provider.getBlockNumber());
      const startBlockForShield = Math.max(receiptBlock - 1000, 0);
      const { events } = await findEventsFromStartBlockByName(
        privateToken,
        hre,
        "Shield",
        startBlockForShield,
        { maxBlockRange: receiptBlock - startBlockForShield, indexedArgs: [userAddress] }
      );
      expect(events.length).to.be.greaterThan(0);
      expect(events[0].args.from).to.equal(userAddress);
      expect(events[0].args.amount).to.equal(shieldAmount);

      // Check mock token balance of the private token
      expect(await mockToken.balanceOf(await privateToken.getAddress())).to.equal(shieldAmount);

      // Check total supply of private tokens
      expect(await privateToken.totalSupply()).to.equal(expectedPrivateAmount);

      // Check user's private balance after shield
      const balanceAfterShield = await getPrivateTokenBalance({
        privateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(balanceAfterShield).to.equal(expectedPrivateAmount);
    });

    it("should fail to shield zero amount", async function () {
      await expect(privateToken.shield(0))
        .to.be.revertedWith("Amount must be greater than 0");
    });

    it("should fail to shield without approval", async function () {
      // Deploy new instance to avoid approval from previous tests
      const newPrivateToken = await deployPrivateToken(hre, defaultSigner, {
        underlyingAddress: await mockToken.getAddress(),
        ownerAddress: defaultSigner.address,
        masterAddress: masterWallet.address,
      });

      await expect(newPrivateToken.shield(shieldAmount))
        .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientAllowance");
    });

    it("should use underlying decimals for 6-decimal private tokens", async function () {
      const sixDecimalToken = await deployMockToken(hre, defaultSigner, "Six Decimal USDC", "SUSDC");
      await (await sixDecimalToken.setDecimals(6)).wait();
      const sixDecimalPrivateToken = await deployPrivateToken(hre, defaultSigner, {
        underlyingAddress: await sixDecimalToken.getAddress(),
        ownerAddress: defaultSigner.address,
        masterAddress: masterWallet.address,
        name: "Private Six Decimal USDC",
        symbol: "pSUSDC",
      });

      expect(await sixDecimalPrivateToken.decimals()).to.equal(6);
      expect(await sixDecimalToken.decimals()).to.equal(6);

      const underlyingAmount = hre.ethers.parseUnits("1.5", 6);
      const expectedPrivateAmount = underlyingAmount;

      await mintAndApprove({
        mockToken: sixDecimalToken.connect(defaultSigner),
        privateToken: sixDecimalPrivateToken,
        userAddress,
        amount: underlyingAmount,
      });

      await (await sixDecimalPrivateToken.shield(underlyingAmount)).wait();
      await delay(DELAY_BALANCE_SYNC_MS);

      expect(await sixDecimalToken.balanceOf(await sixDecimalPrivateToken.getAddress())).to.equal(underlyingAmount);
      expect(await sixDecimalPrivateToken.totalSupply()).to.equal(expectedPrivateAmount);

      const privateBalance = await getPrivateTokenBalance({
        privateToken: sixDecimalPrivateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(privateBalance).to.equal(expectedPrivateAmount);
    });

    it("should unshield 6-decimal private amounts one-to-one with underlying amounts", async function () {
      this.timeout(300000);
      const sixDecimalToken = await deployMockToken(hre, defaultSigner, "Six Decimal USDC", "SUSDC");
      await (await sixDecimalToken.setDecimals(6)).wait();
      const sixDecimalPrivateToken = await deployPrivateToken(hre, defaultSigner, {
        underlyingAddress: await sixDecimalToken.getAddress(),
        ownerAddress: defaultSigner.address,
        masterAddress: masterWallet.address,
        name: "Private Six Decimal USDC",
        symbol: "pSUSDC",
      });

      const underlyingAmount = hre.ethers.parseUnits("1.5", 6);
      const privateAmount = underlyingAmount;

      await mintAndApprove({
        mockToken: sixDecimalToken.connect(defaultSigner),
        privateToken: sixDecimalPrivateToken,
        userAddress,
        amount: underlyingAmount,
      });
      await (await sixDecimalPrivateToken.shield(underlyingAmount)).wait();
      await delay(DELAY_BALANCE_SYNC_MS);

      const underlyingBalanceBefore = await sixDecimalToken.balanceOf(userAddress);
      const startBlock = await hre.ethers.provider.getBlockNumber();

      await (await sixDecimalPrivateToken.unshield(privateAmount)).wait();

      const { successEvents, failedEvents } = await waitForUnshieldOutcome(sixDecimalPrivateToken, hre, startBlock, {
        timeoutMs: 180000,
      });
      expect(successEvents.length, "Expected successful unshield event").to.be.greaterThan(0);
      expect(failedEvents.length, "Expected no failed unshield events").to.equal(0);

      const underlyingBalanceAfter = await sixDecimalToken.balanceOf(userAddress);
      expect(underlyingBalanceAfter - underlyingBalanceBefore).to.equal(underlyingAmount);
      expect(await sixDecimalPrivateToken.totalSupply()).to.equal(0n);
    });

    it("should allow transferring and unshielding the smallest 6-decimal private unit", async function () {
      this.timeout(300000);
      const sixDecimalToken = await deployMockToken(hre, defaultSigner, "Six Decimal USDC", "SUSDC");
      await (await sixDecimalToken.setDecimals(6)).wait();
      const sixDecimalPrivateToken = await deployPrivateToken(hre, defaultSigner, {
        underlyingAddress: await sixDecimalToken.getAddress(),
        ownerAddress: defaultSigner.address,
        masterAddress: masterWallet.address,
        name: "Private Six Decimal USDC",
        symbol: "pSUSDC",
      });

      const underlyingAmount = hre.ethers.parseUnits("1.5", 6);
      const smallestUnit = 1n;

      await mintAndApprove({
        mockToken: sixDecimalToken.connect(defaultSigner),
        privateToken: sixDecimalPrivateToken,
        userAddress,
        amount: underlyingAmount,
      });
      await (await sixDecimalPrivateToken.shield(underlyingAmount)).wait();
      await delay(DELAY_BALANCE_SYNC_MS);

      await (await sixDecimalPrivateToken["transfer(address,uint256)"](otherWallet.address, smallestUnit)).wait();

      const otherUnderlyingBalanceBefore = await sixDecimalToken.balanceOf(otherWallet.address);
      const startBlock = await hre.ethers.provider.getBlockNumber();
      await (await sixDecimalPrivateToken.connect(otherWallet).unshield(smallestUnit)).wait();

      const { successEvents, failedEvents } = await waitForUnshieldOutcome(sixDecimalPrivateToken, hre, startBlock, {
        timeoutMs: 180000,
      });
      expect(successEvents.length, "Expected successful unshield event").to.be.greaterThan(0);
      expect(failedEvents.length, "Expected no failed unshield events").to.equal(0);

      const otherUnderlyingBalanceAfter = await sixDecimalToken.balanceOf(otherWallet.address);
      expect(otherUnderlyingBalanceAfter - otherUnderlyingBalanceBefore).to.equal(smallestUnit);
    });

    it("should successfully unshield private tokens back to standard tokens", async function () {
      const receipt = await (await privateToken.shield(shieldAmount)).wait();
      expect(receipt?.status).to.equal(1);

      // Get balance before unshield
      await delay(DELAY_BALANCE_SYNC_MS);
      const balanceBefore = await getPrivateTokenBalance({
        privateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(balanceBefore).to.equal(expectedPrivateAmount);
      // Store mock token balance before unshield
      const mockTokenBalanceBefore = await mockToken.balanceOf(userAddress);

      // Store the current block number before unshield
      const startBlock = await hre.ethers.provider.getBlockNumber();

      // Request unshield
      const unshieldTx = await privateToken.unshield(expectedPrivateAmount);

      const unshieldReceipt = await unshieldTx.wait();
      expect(unshieldReceipt).to.not.be.undefined;

      // Give the MPC network time to handle the callback before querying events
      await delay(DELAY_MPC_PROCESSING_MS);

      // Check UnshieldRequested event from the start block
      const { events: requestEvents } = await findEventsFromStartBlockByName(
        privateToken,
        hre,
        "UnshieldRequested",
        startBlock
      );
      expect(requestEvents.length).to.be.greaterThan(0);
      expect(requestEvents[0].args[0]).to.equal(userAddress); // 'to' address
      expect(requestEvents[0].args[1]).to.equal(expectedPrivateAmount); // amount
      const { successEvents, failedEvents } = await waitForUnshieldOutcome(privateToken, hre, startBlock);

      expect(successEvents.length, "Expected successful unshield event").to.be.greaterThan(0);
      expect(failedEvents.length, "Expected no failed unshield events").to.equal(0);

      // Check mock token balance difference matches the unshield amount
      const mockTokenBalanceAfter = await mockToken.balanceOf(userAddress);
      const balanceDifference = mockTokenBalanceAfter - mockTokenBalanceBefore;
      expect(balanceDifference, "Mock token balance difference should match shield amount").to.equal(shieldAmount);

      // Check total supply reduced
      expect(await privateToken.totalSupply()).to.equal(0);

      // Check user's private balance is zero
      const decryptedBalance = await getPrivateTokenBalance({
        privateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(decryptedBalance).to.equal(0n);
    });

    it("should fail to unshield more than balance", async function () {
      // First shield some tokens
      const shieldReceipt = await (await privateToken.shield(shieldAmount)).wait();
      expect(shieldReceipt?.status).to.equal(1);

      // Request unshield for more than balance: _unshieldTo computes amountToUnshield = 0 (see contract
      // comments on checkedSubWithOverflowBit), so callback emits UnshieldFailed, not Unshield.
      const tooMuch = expectedPrivateAmount * 2n;
      const startBlock = await hre.ethers.provider.getBlockNumber();
      const mockTokenBalanceBefore = await mockToken.balanceOf(userAddress);
      const unshieldTx = await privateToken.unshield(tooMuch);
      await unshieldTx.wait();

      const { successEvents, failedEvents } = await waitForUnshieldOutcome(privateToken, hre, startBlock);

      expect(
        successEvents.length,
        "Oversized unshield must not complete as Unshield(success); amount to unshield decrypts to 0"
      ).to.equal(0);
      expect(failedEvents.length, "Expected UnshieldFailed when requested amount exceeds balance").to.be.greaterThan(0);

      const decryptedBalance = await getPrivateTokenBalance({
        privateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });
      const mockTokenBalanceAfter = await mockToken.balanceOf(userAddress);

      expect(decryptedBalance).to.equal(expectedPrivateAmount);
      expect(mockTokenBalanceAfter).to.equal(mockTokenBalanceBefore);
      expect(await privateToken.totalSupply()).to.equal(expectedPrivateAmount);
    });

    it("should fail to unshield zero amount", async function () {
      await expect(privateToken.unshield(0))
        .to.be.revertedWith("Amount must be greater than 0");
    });

    it("should successfully unshield private tokens to master address", async function () {
      const masterAddress = await privateToken.master();
      expect(masterAddress).to.equal(masterWallet.address);

      const receipt = await (await privateToken.shield(shieldAmount)).wait();
      expect(receipt?.status).to.equal(1);

      // Get balance before unshield
      await delay(DELAY_BALANCE_SYNC_MS);
      const balanceBefore = await getPrivateTokenBalance({
        privateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(balanceBefore).to.equal(expectedPrivateAmount);

      // Store mock token balance of master before unshield
      const masterMockTokenBalanceBefore = await mockToken.balanceOf(masterAddress);

      // Store the current block number before unshield
      const startBlock = await hre.ethers.provider.getBlockNumber();

      // Request unshieldForMaster
      const unshieldTx = await privateToken.unshieldForMaster(expectedPrivateAmount);

      const unshieldReceipt = await unshieldTx.wait();
      expect(unshieldReceipt).to.not.be.undefined;

      // Give the MPC network time to handle the callback before querying events
      await delay(DELAY_MPC_PROCESSING_MS);

      // Check UnshieldRequested event - should be for master address
      const { events: requestEvents } = await findEventsFromStartBlockByName(
        privateToken,
        hre,
        "UnshieldRequested",
        startBlock
      );
      expect(requestEvents.length).to.be.greaterThan(0);
      expect(requestEvents[0].args[0]).to.equal(masterAddress); // 'to' should be master address
      expect(requestEvents[0].args[1]).to.equal(expectedPrivateAmount); // amount

      const { successEvents, failedEvents } = await waitForUnshieldOutcome(privateToken, hre, startBlock);

      expect(successEvents.length, "Expected successful unshield event").to.be.greaterThan(0);
      expect(failedEvents.length, "Expected no failed unshield events").to.equal(0);

      // Check that master received the tokens
      const masterMockTokenBalanceAfter = await mockToken.balanceOf(masterAddress);
      const masterBalanceDifference = masterMockTokenBalanceAfter - masterMockTokenBalanceBefore;
      expect(masterBalanceDifference, "Master should receive the unshielded tokens").to.equal(shieldAmount);

      // Check total supply reduced
      expect(await privateToken.totalSupply()).to.equal(0);

      // Check user's private balance is zero
      const decryptedBalance = await getPrivateTokenBalance({
        privateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(decryptedBalance).to.equal(0n);
    });
  });

  describe("Transfer Operations", function () {
    this.timeout(120000); // 2 minutes timeout for MPC operations
    
    const shieldAmount = 100n * 10n ** 18n; // 100 tokens with 18 decimals
    const transferAmount = 50n * 10n ** 18n; // 50 tokens with 18 decimals

    beforeEach(async function () {
      this.timeout(300000); // MPC callback paths can exceed 2 minutes on shared infra
      await ensurePrivateBalanceClearedFor({
        privateToken,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
        hre,
      });
      // Mint and shield tokens for transfer tests
      await mintAndApprove({ mockToken, privateToken, userAddress, amount: shieldAmount });
      await (await privateToken.shield(shieldAmount)).wait();
      await delay(DELAY_BALANCE_SYNC_MS);
    });

    it("should successfully transfer private tokens using clear value", async function () {
      // Transfer to other wallet
      const transferTx = await privateToken["transfer(address,uint256)"](otherWallet.address, transferAmount);
      await transferTx.wait();

      // Allow MPC network to process the transfer
      await delay(DELAY_MPC_PROCESSING_MS);

      // Check sender's balance
      const senderBalance = await getPrivateTokenBalance({
        privateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(senderBalance).to.equal(50n * 10n ** 18n); // 50 tokens remaining

      // Note: We can't check receiver's balance as they haven't onboarded yet
      // In a real scenario, the receiver would need to onboard to view their balance
    });

    it("should fail to transfer more than balance", async function () {
      const tooMuch = 200n * 10n ** 18n; // 200 tokens with 18 decimals

      await delay(DELAY_SHORT_MS);
      const senderBalanceBefore = await getPrivateTokenBalance({
        privateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });

      const transferTx = await privateToken["transfer(address,uint256)"](otherWallet.address, tooMuch);
      const transferReceipt = await transferTx.wait();
      expect(transferReceipt?.status).to.equal(1);

      await delay(DELAY_MPC_PROCESSING_MS);

      const senderBalanceAfter = await getPrivateTokenBalance({
        privateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(senderBalanceAfter).to.equal(senderBalanceBefore);
    });

    it("should successfully transfer private tokens using encrypted IT value", async function () {
      // Onboard the receiver (otherWallet)
      const otherUserAesKey = await getUserKeyViaProxy(otherWallet, PROXY_URL);
      const privateTokenDecimals = 18;
      const amount = "50";
      const PRIVATE_TOKEN_ADDRESS = await privateToken.getAddress();

      // Get balances before transfer
      await delay(DELAY_BALANCE_SYNC_MS);

      const senderBalanceBefore = await getPrivateTokenBalance({
        privateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });
      const receiverBalanceBefore = await getPrivateTokenBalance({
        privateToken,
        address: otherWallet.address,
        signer: otherWallet,
        aesKey: otherUserAesKey,
        proxyUrl: PROXY_URL,
      });
      const amountInBigInt = BigInt(hre.ethers.parseUnits(amount, privateTokenDecimals))
      // Prepare encrypted message using 256-bit encryption
      const { encryptedHigh, encryptedLow } = prepareMessageForBubble256(
        amountInBigInt,
        await defaultSigner.getAddress(),
        userAesKey.toString("hex"),
        PRIVATE_TOKEN_ADDRESS
      );

      const transferTx = await privateToken["transfer(address,(address,(uint256,uint256)))"](otherWallet.address, {
        userAddress: await defaultSigner.getAddress(),
        ciphertext: {
          ciphertextHigh: encryptedHigh,
          ciphertextLow: encryptedLow
        }
      });
      await transferTx.wait();

      // Wait for MPC network to process the changes
      await delay(DELAY_MPC_PROCESSING_MS);

      // Get balances after transfer
      const senderBalanceAfter = await getPrivateTokenBalance({
        privateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });
      const receiverBalanceAfter = await getPrivateTokenBalance({
        privateToken,
        address: otherWallet.address,
        signer: otherWallet,
        aesKey: otherUserAesKey,
        proxyUrl: PROXY_URL,
      });

      // Assert balances
      expect(senderBalanceAfter).to.equal(senderBalanceBefore - BigInt(hre.ethers.parseUnits(amount, privateTokenDecimals)));
      expect(receiverBalanceAfter).to.equal(receiverBalanceBefore + BigInt(hre.ethers.parseUnits(amount, privateTokenDecimals)));
    });

    it("should emit PrivateTransfer and allow sender and recipient to decrypt the transfer amount", async function () {
      const otherUserAesKey = await getUserKeyViaProxy(otherWallet, PROXY_URL);
      const privateTokenDecimals = 18;
      const amount = "50";
      const PRIVATE_TOKEN_ADDRESS = await privateToken.getAddress();
      const amountInBigInt = BigInt(hre.ethers.parseUnits(amount, privateTokenDecimals));

      const { encryptedHigh, encryptedLow } = prepareMessageForBubble256(
        amountInBigInt,
        await defaultSigner.getAddress(),
        userAesKey.toString("hex"),
        PRIVATE_TOKEN_ADDRESS
      );

      const transferTx = await privateToken["transfer(address,(address,(uint256,uint256)))"](otherWallet.address, {
        userAddress: await defaultSigner.getAddress(),
        ciphertext: {
          ciphertextHigh: encryptedHigh,
          ciphertextLow: encryptedLow
        }
      });
      const transferReceipt = await transferTx.wait();
      expect(transferReceipt?.status).to.equal(1);

      const privateTransferLog = findParsedLogInReceipt(transferReceipt, privateToken, "PrivateTransfer");
      expect(privateTransferLog).to.not.be.undefined;
      const privateTransferEvent = privateToken.interface.parseLog(privateTransferLog!);
      expect(privateTransferEvent?.args[0].toLowerCase()).to.equal(userAddress.toLowerCase());
      expect(privateTransferEvent?.args[1].toLowerCase()).to.equal(otherWallet.address.toLowerCase());
      const transferredAmountHandle = privateTransferEvent?.args[2];
      expect(transferredAmountHandle).to.not.be.undefined;

      await delay(DELAY_MPC_PROCESSING_MS);

      const recipientAmount = await decryptValueViaProxy(
        transferredAmountHandle,
        otherWallet,
        otherUserAesKey,
        PROXY_URL
      );
      const senderAmount = await decryptValueViaProxy(
        transferredAmountHandle,
        defaultSigner,
        userAesKey,
        PROXY_URL
      );

      expect(recipientAmount).to.equal(amountInBigInt);
      expect(senderAmount).to.equal(amountInBigInt);
    });

    it("should emit zero PrivateTransfer amount when encrypted transfer exceeds balance", async function () {
      const otherUserAesKey = await getUserKeyViaProxy(otherWallet, PROXY_URL);
      const privateTokenDecimals = 18;
      const tooMuch = "200";
      const PRIVATE_TOKEN_ADDRESS = await privateToken.getAddress();
      const tooMuchInBigInt = BigInt(hre.ethers.parseUnits(tooMuch, privateTokenDecimals));

      const { encryptedHigh, encryptedLow } = prepareMessageForBubble256(
        tooMuchInBigInt,
        await defaultSigner.getAddress(),
        userAesKey.toString("hex"),
        PRIVATE_TOKEN_ADDRESS
      );

      const transferTx = await privateToken["transfer(address,(address,(uint256,uint256)))"](otherWallet.address, {
        userAddress: await defaultSigner.getAddress(),
        ciphertext: {
          ciphertextHigh: encryptedHigh,
          ciphertextLow: encryptedLow
        }
      });
      const transferReceipt = await transferTx.wait();
      expect(transferReceipt?.status).to.equal(1);

      const privateTransferLog = findParsedLogInReceipt(transferReceipt, privateToken, "PrivateTransfer");
      expect(privateTransferLog).to.not.be.undefined;
      const privateTransferEvent = privateToken.interface.parseLog(privateTransferLog!);
      const transferredAmountHandle = privateTransferEvent?.args[2];
      expect(transferredAmountHandle).to.not.be.undefined;

      await delay(DELAY_MPC_PROCESSING_MS);

      const recipientAmount = await decryptValueViaProxy(
        transferredAmountHandle,
        otherWallet,
        otherUserAesKey,
        PROXY_URL
      );
      const senderAmount = await decryptValueViaProxy(
        transferredAmountHandle,
        defaultSigner,
        userAesKey,
        PROXY_URL
      );

      expect(recipientAmount).to.equal(0n);
      expect(senderAmount).to.equal(0n);
    });

    it("should handle self-transfer using clear value (transferring to oneself)", async function () {
      // Get balance before self-transfer
      await delay(DELAY_BALANCE_SYNC_MS);
      const balanceBefore = await getPrivateTokenBalance({
        privateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });

      // Self-transfer (transfer to same address)
      const transferTx = await privateToken["transfer(address,uint256)"](userAddress, transferAmount);
      await transferTx.wait();

      // Wait for processing
      await delay(DELAY_BALANCE_SYNC_MS);

      // Get balance after self-transfer
      const balanceAfter = await getPrivateTokenBalance({
        privateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });

      // Check for weird behavior - balance should remain the same in a self-transfer
      expect(balanceAfter).to.equal(balanceBefore, "Self-transfer should not change total balance");
    });

    it("should handle self-transfer using encrypted IT value (transferring to oneself)", async function () {
      const privateTokenDecimals = 18;
      const amount = "25"; // Transfer 25 tokens to self
      const PRIVATE_TOKEN_ADDRESS = await privateToken.getAddress();

      // Get balance before self-transfer
      await delay(DELAY_BALANCE_SYNC_MS);
      const balanceBefore = await getPrivateTokenBalance({
        privateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });

      const amountInBigInt = BigInt(hre.ethers.parseUnits(amount, privateTokenDecimals))
      // Prepare encrypted message for self-transfer using 256-bit encryption
      const { encryptedHigh, encryptedLow } = prepareMessageForBubble256(
        amountInBigInt,
        await defaultSigner.getAddress(),
        userAesKey.toString("hex"),
        PRIVATE_TOKEN_ADDRESS
      );

      // Execute the self-transfer using the IT struct with 256-bit ciphertext
      // itUint256 = { userAddress, ciphertext: { ciphertextHigh, ciphertextLow } }
      const transferTx = await privateToken["transfer(address,(address,(uint256,uint256)))"](userAddress, {
        userAddress: await defaultSigner.getAddress(),
        ciphertext: {
          ciphertextHigh: encryptedHigh,
          ciphertextLow: encryptedLow
        }
      });
      await transferTx.wait();

      // Wait for processing
      await delay(DELAY_BALANCE_SYNC_MS);

      // Get balance after self-transfer
      const balanceAfter = await getPrivateTokenBalance({
        privateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });

      // Check for weird behavior - balance should remain the same in a self-transfer
      expect(balanceAfter).to.equal(balanceBefore, "Encrypted self-transfer should not change total balance");
    });
  });

  describe("Master Address Management", function () {
    let newMasterWallet: HDNodeWallet;

    before(async function () {
      // Create a new wallet to use as the new master address
      newMasterWallet = Wallet.createRandom().connect(hre.ethers.provider) as HDNodeWallet;
    });

    beforeEach(async function () {
      // Reset master to original value before each test to ensure test isolation
      const currentMaster = await privateToken.master();
      if (currentMaster !== masterWallet.address) {
        await (await privateToken.connect(defaultSigner).setMaster(masterWallet.address)).wait();
      }
    });

    it("should return the initial master address", async function () {
      const masterAddress = await privateToken.master();
      expect(masterAddress).to.equal(masterWallet.address);
    });

    it("should allow owner to update master address", async function () {
      const newMasterAddress = newMasterWallet.address;
      
      // Get current master before update
      const oldMasterAddress = await privateToken.master();
      
      // Update master address
      const tx = await privateToken.connect(defaultSigner).setMaster(newMasterAddress);
      const receipt = await tx.wait();
      
      expect(receipt).to.not.be.undefined;
      expect(receipt?.status).to.equal(1);

      // Verify master address was updated
      const updatedMaster = await privateToken.master();
      expect(updatedMaster).to.equal(newMasterAddress);

      // Verify event was emitted
      const events = await getEventsInReceiptBlock(privateToken, privateToken.filters.MasterUpdated(), receipt);
      expect(events.length).to.be.greaterThan(0);
      expect(events[0].args.oldMaster).to.equal(oldMasterAddress);
      expect(events[0].args.newMaster).to.equal(newMasterAddress);
    });

    it("should revert when non-owner tries to update master address", async function () {
      const newMasterAddress = newMasterWallet.address;
      
      await expect(
        privateToken.connect(otherWallet).setMaster(newMasterAddress)
      ).to.be.revertedWithCustomError(privateToken, "OwnableUnauthorizedAccount")
        .withArgs(otherWallet.address);
    });

    it("should revert when trying to set master to zero address", async function () {
      await expect(
        privateToken.connect(defaultSigner).setMaster(hre.ethers.ZeroAddress)
      ).to.be.revertedWith("Master cannot be zero address");
    });

    it("should allow owner to update master address multiple times", async function () {
      // Create another new master wallet
      const anotherMasterWallet = Wallet.createRandom().connect(hre.ethers.provider) as HDNodeWallet;
      
      // First update
      const firstTx = await privateToken.connect(defaultSigner).setMaster(anotherMasterWallet.address);
      await firstTx.wait();
      
      let currentMaster = await privateToken.master();
      expect(currentMaster).to.equal(anotherMasterWallet.address);

      // Second update back to original
      const secondTx = await privateToken.connect(defaultSigner).setMaster(masterWallet.address);
      await secondTx.wait();
      
      currentMaster = await privateToken.master();
      expect(currentMaster).to.equal(masterWallet.address);
    });

    it("should preserve master address after upgrade", async function () {
      // Set a new master
      const testMasterWallet = Wallet.createRandom().connect(hre.ethers.provider) as HDNodeWallet;
      await (await privateToken.connect(defaultSigner).setMaster(testMasterWallet.address)).wait();
      
      const masterBeforeUpgrade = await privateToken.master();
      expect(masterBeforeUpgrade).to.equal(testMasterWallet.address);

      // Deploy new implementation
      const newImplementation = await deployPrivateTokenImplementation(hre, defaultSigner);

      // Upgrade the contract
      await (await privateToken.connect(defaultSigner).upgradeToAndCall(
        await newImplementation.getAddress(),
        "0x"
      )).wait();

      // Verify master address is preserved
      const masterAfterUpgrade = await privateToken.master();
      expect(masterAfterUpgrade).to.equal(testMasterWallet.address);
    });
  });

  describe("Emergency Recovery", function () {
    const shieldAmount = 100n * 10n ** 18n; // 100 tokens with 18 decimals

    beforeEach(async function () {
      this.timeout(300000);
      // Fresh instance prevents cross-test state from previous emergency actions.
      privateToken = await deployPrivateToken(hre, defaultSigner, {
        underlyingAddress: await mockToken.getAddress(),
        ownerAddress: defaultSigner.address,
        masterAddress: masterWallet.address,
      });
    });

    it("should transfer all underlying tokens to owner and reset total supply", async function () {
      // Mint and shield tokens to create a balance in the contract
      await mintAndApprove({ mockToken, privateToken, userAddress, amount: shieldAmount });
      await (await privateToken.shield(shieldAmount)).wait();
      await delay(DELAY_BALANCE_SYNC_MS);

      const contractBalanceBefore = await mockToken.balanceOf(await privateToken.getAddress());
      expect(contractBalanceBefore).to.be.gte(shieldAmount);
      expect(await privateToken.totalSupply()).to.equal(shieldAmount);
      
      const ownerBalanceBefore = await mockToken.balanceOf(defaultSigner.address);

      const recoveryTx = await privateToken.connect(defaultSigner).emergencyRecovery();
      const receipt = await recoveryTx.wait();
      
      expect(receipt).to.not.be.undefined;
      expect(receipt?.status).to.equal(1);

      const contractBalanceAfter = await mockToken.balanceOf(await privateToken.getAddress());
      expect(contractBalanceAfter).to.equal(0n);
      expect(await privateToken.totalSupply()).to.equal(0n);

      const ownerBalanceAfter = await mockToken.balanceOf(defaultSigner.address);
      expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(contractBalanceBefore);

      const events = await getEventsInReceiptBlock(privateToken, privateToken.filters.EmergencyRecovery(), receipt);
      expect(events.length).to.be.greaterThan(0);
      expect(events[0].args.owner).to.equal(defaultSigner.address);
      expect(events[0].args.amount).to.equal(contractBalanceBefore);
    });

    it("should return zero when contract has no underlying tokens", async function () {
      // Ensure contract has no balance
      const contractBalance = await mockToken.balanceOf(await privateToken.getAddress());
      if (contractBalance > 0n) {
        // If there's a balance, recover it first
        await (await privateToken.connect(defaultSigner).emergencyRecovery()).wait();
      }

      // Execute emergency recovery when balance is zero
      const recoveryTx = await privateToken.connect(defaultSigner).emergencyRecovery();
      const receipt = await recoveryTx.wait();
      
      expect(receipt).to.not.be.undefined;
      expect(receipt?.status).to.equal(1);

      // Verify no event was emitted (or event with zero amount)
      const events = await getEventsInReceiptBlock(privateToken, privateToken.filters.EmergencyRecovery(), receipt);
      // Event should not be emitted when balance is zero
      expect(events.length).to.equal(0);
      expect(await privateToken.totalSupply()).to.equal(0n);
    });

    it("should revert when non-owner tries to call emergency recovery", async function () {
      await expect(
        privateToken.connect(otherWallet).emergencyRecovery()
      ).to.be.revertedWithCustomError(privateToken, "OwnableUnauthorizedAccount")
        .withArgs(otherWallet.address);
    });

    it("should recover full balance including externally added tokens", async function () {
      await mintAndApprove({ mockToken, privateToken, userAddress, amount: shieldAmount });
      await (await privateToken.shield(shieldAmount)).wait();
      await delay(DELAY_BALANCE_SYNC_MS);

      const excessAmount = 25n * 10n ** 18n;
      await (await mockToken.mint(await privateToken.getAddress(), excessAmount)).wait();
      
      const contractBalanceBefore = await mockToken.balanceOf(await privateToken.getAddress());
      expect(contractBalanceBefore).to.be.gte(shieldAmount + excessAmount);
      expect(await privateToken.totalSupply()).to.equal(shieldAmount);
      
      const ownerBalanceBefore = await mockToken.balanceOf(defaultSigner.address);

      const recoveryTx = await privateToken.connect(defaultSigner).emergencyRecovery();
      const receipt = await recoveryTx.wait();

      const ownerBalanceAfter = await mockToken.balanceOf(defaultSigner.address);
      expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(contractBalanceBefore);

      const contractBalance = await mockToken.balanceOf(await privateToken.getAddress());
      expect(contractBalance).to.equal(0n);
      expect(await privateToken.totalSupply()).to.equal(0n);
      
      const events = await getEventsInReceiptBlock(privateToken, privateToken.filters.EmergencyRecovery(), receipt);
      expect(events.length).to.be.greaterThan(0);
      expect(events[0].args.owner).to.equal(defaultSigner.address);
      expect(events[0].args.amount).to.equal(contractBalanceBefore);
    });

    it("should work correctly after contract upgrade", async function () {
      this.timeout(300000);
      // Shield some tokens first
      await mintAndApprove({ mockToken, privateToken, userAddress, amount: shieldAmount });
      await (await privateToken.shield(shieldAmount)).wait();
      await delay(DELAY_BALANCE_SYNC_MS);

      // Deploy new implementation
      const newImplementation = await deployPrivateTokenImplementation(hre, defaultSigner);

      // Upgrade the contract
      await (await privateToken.connect(defaultSigner).upgradeToAndCall(
        await newImplementation.getAddress(),
        "0x"
      )).wait();

      // Verify contract still has the underlying tokens after upgrade
      const contractBalanceBefore = await mockToken.balanceOf(await privateToken.getAddress());
      expect(contractBalanceBefore).to.be.gte(shieldAmount);
      
      const excessAmount = 25n * 10n ** 18n;
      await (await mockToken.mint(await privateToken.getAddress(), excessAmount)).wait();

      const ownerBalanceBefore = await mockToken.balanceOf(defaultSigner.address);
      const recoveryTx = await privateToken.connect(defaultSigner).emergencyRecovery();
      await recoveryTx.wait();

      const ownerBalanceAfter = await mockToken.balanceOf(defaultSigner.address);
      expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(contractBalanceBefore + excessAmount);

      const contractBalanceAfter = await mockToken.balanceOf(await privateToken.getAddress());
      expect(contractBalanceAfter).to.equal(0n);
      expect(await privateToken.totalSupply()).to.equal(0n);
    });
  });

  describe("Unshield callback via GetDecryption HTTP", function () {
    this.timeout(300000);

    it("should complete unshield by fetching callback tx_data from proxy and submitting it", async function () {
      this.timeout(300000);
      const callbackPrivateToken = await deployPrivateToken(hre, defaultSigner, {
        underlyingAddress: await mockToken.getAddress(),
        ownerAddress: defaultSigner.address,
        masterAddress: masterWallet.address,
      });

      const shieldAmount = 100n * 10n ** 18n;
      const totalSupplyBefore = await callbackPrivateToken.totalSupply();
      const balanceBeforeShield = await getPrivateTokenBalance({
        privateToken: callbackPrivateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });
      await mintAndApprove({ mockToken, privateToken: callbackPrivateToken, userAddress, amount: shieldAmount });
      await (await callbackPrivateToken.shield(shieldAmount)).wait();

      await delay(DELAY_BALANCE_SYNC_MS);
      const balanceBefore = await getPrivateTokenBalance({
        privateToken: callbackPrivateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(balanceBefore - balanceBeforeShield).to.equal(shieldAmount);

      const contractAddress = await callbackPrivateToken.getAddress();
      const mockTokenBalanceBefore = await mockToken.balanceOf(userAddress);
      const startBlock = await hre.ethers.provider.getBlockNumber();

      const unshieldTx = await callbackPrivateToken.unshield(shieldAmount);
      const unshieldReceipt = await unshieldTx.wait();
      expect(unshieldReceipt).to.not.be.undefined;

      const decryptId = await callbackPrivateToken.getLastDecryptRequestId();

      await delay(DELAY_MPC_DECRYPTION_MS);

      const network = await hre.ethers.provider.getNetwork();
      const chainId = Number(network.chainId);
      // Flow: Proxy calls gRPC GetDecryption(chainId, contract, decryptId). Backend returns
      // calldata to invoke callbackUnshield(decryptId, output, signatures). We may submit it
      // ourselves, or the MPC relayer may have already submitted it (then our tx reverts).
      const txDataHex = await getDecryptionTxDataViaProxy(PROXY_URL, chainId, contractAddress, decryptId);

      const hasTxData = txDataHex && txDataHex.length > 2 && txDataHex !== "0x";
      if (hasTxData) {
        try {
          const tx = await defaultSigner.sendTransaction({
            to: contractAddress,
            data: txDataHex,
            gasLimit: 500_000,
          });
          const callbackReceipt = await tx.wait();
          expect(callbackReceipt?.status).to.equal(1);
        } catch (err: any) {
          const relayerLikelySubmitted =
            err?.code === "CALL_EXCEPTION" || err?.receipt?.status === 0;
          if (!relayerLikelySubmitted) throw err;
        }
      }

      // Either we submitted the callback or the relayer did; poll for Unshield/UnshieldFailed and assert final state.
      const { successEvents, failedEvents } = await waitForUnshieldOutcome(callbackPrivateToken, hre, startBlock, {
        timeoutMs: 180000,
      });
      expect(successEvents.length, "Expected successful unshield event").to.be.greaterThan(0);
      expect(failedEvents.length, "Expected no failed unshield events").to.equal(0);

      const mockTokenBalanceAfter = await mockToken.balanceOf(userAddress);
      expect(mockTokenBalanceAfter - mockTokenBalanceBefore).to.equal(shieldAmount);
      expect(await callbackPrivateToken.totalSupply()).to.equal(totalSupplyBefore);

      const decryptedBalance = await getPrivateTokenBalance({
        privateToken: callbackPrivateToken,
        address: userAddress,
        signer: defaultSigner,
        aesKey: userAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(decryptedBalance).to.equal(balanceBeforeShield);
    });
  });
}); 
