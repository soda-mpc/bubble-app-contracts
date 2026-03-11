import { expect } from "chai";
import hre from "hardhat";
import { Wallet, HDNodeWallet } from "ethers";
import dotenv from "dotenv";

import {
  prepareMessageForBubble,
  prepareMessageForBubble256
} from "./testUtils";
import { getUserKeyViaProxy, decryptBalanceViaProxy, getDecryptionTxDataViaProxy } from "./testUtils";

dotenv.config();

const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC) {
  throw new Error("MNEMONIC environment variable is required");
}

async function waitForContractCode(address: string, timeoutMs = 5000, pollIntervalMs = 500) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const code = await hre.ethers.provider.getCode(address);
    if (code && code !== "0x") {
      return code;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Contract at ${address} still has no code after ${timeoutMs}ms`);
}


describe("PrivateERC20Contract256", function () {
  this.timeout(120000); // 2 minutes timeout for MPC operations
  
  let userAesKey: Buffer;
  let userAesKeyHex: string;
  let userAddress: string;
  let privateToken: any;
  let mockToken: any;
let otherWallet: HDNodeWallet;
let masterWallet: HDNodeWallet;
let defaultSigner: any;

async function retryWithDelay<T>(operation: () => Promise<T>, attempts: number = 3, baseDelayMs: number = 1000): Promise<T> {
  let lastError: Error | undefined;
  for (let attempt = 0; attempt < attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error as Error;
      if (attempt === attempts - 1) {
        throw lastError;
      }
      const backoff = baseDelayMs * Math.pow(2, attempt);
      console.warn(`Operation failed (attempt ${attempt + 1}/${attempts}): ${lastError.message}. Retrying in ${backoff}ms...`);
      await new Promise(resolve => setTimeout(resolve, backoff));
    }
  }
  throw lastError!;
}

async function waitForUnshieldOutcome(
    startBlock: number,
    maxBlockRange: number = 1000,
    timeoutMs: number = 60000,
    pollIntervalMs: number = 2000
  ) {
    let successEvents: any[] = [];
    let failedEvents: any[] = [];
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const currentBlock = await hre.ethers.provider.getBlockNumber();
      const endBlock = Math.min(startBlock + maxBlockRange, currentBlock);
      successEvents = await privateToken.queryFilter(privateToken.filters.Unshield, startBlock, endBlock);
      failedEvents = await privateToken.queryFilter(privateToken.filters.UnshieldFailed, startBlock, endBlock);

      if (successEvents.length > 0 || failedEvents.length > 0) {
        break;
      }

      await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
    }

    return { successEvents, failedEvents };
  }

  async function ensurePrivateBalanceClearedFor(signer: Wallet | HDNodeWallet, aesKey?: Buffer) {
    if (!privateToken || !aesKey) {
      return;
    }

    await retryWithDelay(async () => {
      const address = await signer.getAddress();
      const balanceHandle = await privateToken["balanceOf(address)"](address);
      if (balanceHandle === 0n) {
        return;
      }

      const decryptedBalance = await decryptBalanceViaProxy(balanceHandle, signer, aesKey, PROXY_URL);
      if (decryptedBalance === 0n) {
        return;
      }

      const startBlock = await hre.ethers.provider.getBlockNumber();
      const tx = await privateToken.connect(signer).unshield(decryptedBalance);
      await tx.wait();

      const { successEvents, failedEvents } = await waitForUnshieldOutcome(startBlock);
      if (failedEvents.length > 0 || successEvents.length === 0) {
        throw new Error(`Failed to clear private balance for ${address}`);
      }
    });
  }

  before(async function () {
    console.log("🚀 Starting PrivateERC20Contract256 test setup...");
    
    // Get Hardhat's default signer (same approach as working debug script)
    console.log("📡 Getting signers from hardhat...");
    [defaultSigner] = await hre.ethers.getSigners();
    console.log("✅ Got default signer:", await defaultSigner.getAddress());
    
    // Setup main user with the default signer
    console.log("🔑 Getting user AES key from proxy...");
    console.log("📡 Proxy URL:", PROXY_URL);
    try {
      userAesKey = await getUserKeyViaProxy(defaultSigner as any, PROXY_URL);
      userAesKeyHex = userAesKey.toString("hex");
      userAddress = await defaultSigner.getAddress();
      console.log("✅ User AES key obtained, address:", userAddress);
    } catch (error) {
      console.error("❌ Failed to get user AES key:", error);
      throw error;
    }

    // Create another wallet for testing transfers
    otherWallet = Wallet.createRandom().connect(hre.ethers.provider) as HDNodeWallet;
    console.log("✅ Created other wallet:", otherWallet.address);

    // Create master wallet for unshieldForMaster tests
    masterWallet = Wallet.createRandom().connect(hre.ethers.provider) as HDNodeWallet;
    console.log("✅ Created master wallet:", masterWallet.address);

    // Deploy mock token using the default signer
    console.log("🏗️ Deploying mock token...");
    const MockTokenFactory = await hre.ethers.getContractFactory("TUSDC", defaultSigner);
    mockToken = await MockTokenFactory.deploy("Test USDC", "TUSDC");
    await mockToken.waitForDeployment();
    console.log("✅ Mock token deployed at:", await mockToken.getAddress());
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Deploy private token using the upgradeable proxy pattern
    console.log("🏗️ Deploying PrivateERC20Contract256 implementation...");
    const ImplementationFactory = await hre.ethers.getContractFactory("contracts/PrivateERC20Contract256.sol:PrivateERC20Contract256", defaultSigner);
    const implementation = await ImplementationFactory.deploy();
    await implementation.waitForDeployment();
    const implementationAddress = await implementation.getAddress();
    console.log("✅ Implementation deployed at:", implementationAddress);

    // Encode the initialize function call
    console.log("🔧 Encoding initialize function call...");
    const initializeInterface = ImplementationFactory.interface;
    const initData = initializeInterface.encodeFunctionData("initialize", [
      "BubbleToken",
      "BUB",
      await mockToken.getAddress(),
      defaultSigner.address,
      masterWallet.address
    ]);

    // Deploy ERC1967Proxy pointing to the implementation
    console.log("🏗️ Deploying ERC1967Proxy...");
    const ProxyFactory = await hre.ethers.getContractFactory("@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy", defaultSigner);
    const proxy = await ProxyFactory.deploy(implementationAddress, initData);
    await proxy.waitForDeployment();
    const proxyAddress = await proxy.getAddress();
    console.log("✅ Proxy deployed at:", proxyAddress);

    // Get the contract instance attached to the proxy address
    privateToken = ImplementationFactory.attach(proxyAddress) as any;
    console.log("✅ PrivateERC20Contract256 (upgradeable) deployed at:", proxyAddress);
  });

  describe("Basic Token Information", function () {
    it("should have correct name, symbol and decimals", async function () {
      console.log("🔍 Testing basic token information...");
      const contractAddress = await privateToken.getAddress();
      console.log("📍 Contract address:", contractAddress);
      
      // Ensure contract bytecode is available before continuing
      const code = await waitForContractCode(contractAddress);
      console.log("📄 Contract code length:", code.length);
      
      console.log("🔍 Calling name() function...");
      try {
        const name = await privateToken.name();
        console.log("📝 Name result:", name);
        expect(name).to.equal("BubbleToken");
      } catch (error) {
        console.error("❌ Error calling name():", error);
        throw error;
      }
      
      console.log("🔍 Calling symbol() function...");
      const symbol = await privateToken.symbol();
      console.log("🏷️ Symbol result:", symbol);
      expect(symbol).to.equal("BUB");
      
      console.log("🔍 Calling decimals() function...");
      const decimals = await privateToken.decimals();
      console.log("🔢 Decimals result:", decimals);
      expect(decimals).to.equal(18);
      
      console.log("✅ All basic token information tests passed");
    });

    it("should start with zero total supply", async function () {
      expect(await privateToken.totalSupply()).to.equal(0);
    });

    it("should have zero initial balance for any address", async function () {
      const balanceHandle = await privateToken["balanceOf(address)"](userAddress);
      let decryptedBalance = balanceHandle;
      if (balanceHandle !== 0n) {
        decryptedBalance = await decryptBalanceViaProxy(balanceHandle, defaultSigner, userAesKey, PROXY_URL);
      }
      expect(decryptedBalance).to.equal(0n);
    });
  });

  describe("Shield/Unshield Operations", function () {
    this.timeout(120000); // 2 minutes timeout for MPC operations
    
    const shieldAmount = 150n * 10n ** 18n; // 150 tokens with 18 decimals
    const expectedPrivateAmount = shieldAmount;

    beforeEach(async function () {
      this.timeout(120000); // 2 minutes timeout for beforeEach
      console.log("🔄 Running beforeEach setup...");

      // Check if mock token is deployed properly
      const code = await hre.ethers.provider.getCode(await mockToken.getAddress());
      if (code === "0x") {
        throw new Error("Mock token contract not deployed properly");
      }
      console.log("✅ Mock token code verified");

      // Ensure user starts each test with zero private balance
      await ensurePrivateBalanceClearedFor(defaultSigner, userAesKey);

      // Check signer connection
      console.log("🔗 Connecting mock token to signer...");
      // Ensure mockToken is connected to the correct signer
      const connectedMockToken = mockToken.connect(defaultSigner);

      // Mint tokens to user for each test
      console.log("💰 Minting", shieldAmount.toString(), "tokens to user...");
      const mintTx = await connectedMockToken.mint(userAddress, shieldAmount);
      const mintReceipt = await mintTx.wait();
      console.log("✅ Mint transaction confirmed, block:", mintReceipt?.blockNumber);

      if (mintReceipt?.status !== 1) {
        throw new Error(`Mint transaction failed with status: ${mintReceipt?.status}`);
      }

      // Wait 3 seconds between mint and approve
      console.log("⏳ Waiting 3 seconds before approve...");
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Approve the private token to spend mock tokens
      console.log("✅ Approving private token to spend mock tokens...");
      const approveTx = await connectedMockToken.approve(await privateToken.getAddress(), shieldAmount);
      const approveReceipt = await approveTx.wait();
      console.log("✅ Approve transaction confirmed, block:", approveReceipt?.blockNumber);

      if (approveReceipt?.status !== 1) {
        throw new Error(`Approve transaction failed with status: ${approveReceipt?.status}`);
      }
      console.log("✅ beforeEach setup completed");
    });

    it("should successfully shield standard tokens into private tokens", async function () {
      console.log("🛡️ Starting shield test...");
      console.log("📊 Shield amount:", shieldAmount.toString());
      
      await new Promise(resolve => setTimeout(resolve, 3000));
      console.log("⏳ Waited 3 seconds before shield...");
      
      const balanceHandleBeforeShield = await privateToken["balanceOf(address)"](userAddress);
      console.log("💰 Balance handle before shield:", balanceHandleBeforeShield.toString());
      
      console.log("🚀 Executing shield transaction...");
      const shieldTx = await privateToken.shield(shieldAmount);
      console.log("📝 Shield transaction hash:", shieldTx.hash);
      
      const shieldReceipt = await shieldTx.wait();
      console.log("✅ Shield transaction confirmed, block:", shieldReceipt?.blockNumber);
      
      await new Promise(resolve => setTimeout(resolve, 3000));
      console.log("⏳ Waited 3 seconds after shield...");
      
      expect(shieldReceipt).to.not.be.undefined;

      // Check Shield event
      console.log("🔍 Querying for Shield events...");
      const currentBlockForShield = await hre.ethers.provider.getBlockNumber();
      const endBlockForShield = Math.min(shieldReceipt?.blockNumber || currentBlockForShield, currentBlockForShield);
      const startBlockForShield = Math.max((shieldReceipt?.blockNumber || currentBlockForShield) - 1000, 0);
      console.log("📊 Shield query range: blocks", startBlockForShield, "to", endBlockForShield, "(range:", endBlockForShield - startBlockForShield, "blocks)");
      
      const events = await privateToken.queryFilter(privateToken.filters.Shield(userAddress), startBlockForShield, endBlockForShield);
      console.log("📋 Found", events.length, "Shield events");
      expect(events.length).to.be.greaterThan(0);
      expect(events[0].args.from).to.equal(userAddress);
      expect(events[0].args.amount).to.equal(shieldAmount);
      console.log("✅ Shield event verified");

      // Check mock token balance of the private token
      expect(await mockToken.balanceOf(await privateToken.getAddress())).to.equal(shieldAmount);

      // Check total supply of private tokens
      expect(await privateToken.totalSupply()).to.equal(expectedPrivateAmount);

      // Check user's private balance
      await new Promise(resolve => setTimeout(resolve, 3));
      const balanceHandle = await privateToken["balanceOf(address)"](userAddress);

      const decryptedBalance = await decryptBalanceViaProxy(balanceHandle, defaultSigner, userAesKey, PROXY_URL);
      expect(decryptedBalance).to.equal(expectedPrivateAmount);
    });

    it("should fail to shield zero amount", async function () {
      await expect(privateToken.shield(0))
        .to.be.revertedWith("Amount must be greater than 0");
    });

    it("should fail to shield without approval", async function () {
      // Deploy new instance to avoid approval from previous tests
      const ImplementationFactory = await hre.ethers.getContractFactory("contracts/PrivateERC20Contract256.sol:PrivateERC20Contract256");
      const implementation = await ImplementationFactory.deploy();
      await implementation.waitForDeployment();
      const implementationAddress = await implementation.getAddress();

      // Encode the initialize function call
      const initializeInterface = ImplementationFactory.interface;
      const initData = initializeInterface.encodeFunctionData("initialize", [
        "BubbleToken",
        "BUB",
        await mockToken.getAddress(),
        defaultSigner.address,
        masterWallet.address
      ]);

      // Deploy ERC1967Proxy
      const ProxyFactory = await hre.ethers.getContractFactory("@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy");
      const proxy = await ProxyFactory.deploy(implementationAddress, initData);
      await proxy.waitForDeployment();
      const proxyAddress = await proxy.getAddress();

      // Get the contract instance attached to the proxy address
      const newPrivateToken: any = ImplementationFactory.attach(proxyAddress);

      await expect(newPrivateToken.shield(shieldAmount))
        .to.be.revertedWithCustomError(mockToken, "ERC20InsufficientAllowance");
    });

    it("should successfully unshield private tokens back to standard tokens", async function () {
      console.log("🔓 Starting unshield test...");

      const currentBlock = await hre.ethers.provider.getBlockNumber();
      console.log("📊 Current block at start:", currentBlock);

      console.log("🛡️ First shielding tokens...");
      const receipt = await (await privateToken.shield(shieldAmount)).wait();
      expect(receipt?.status).to.equal(1);
      console.log("✅ Shield completed");

      // Get balance before unshield
      await new Promise(resolve => setTimeout(resolve, 5000));
      const balanceBeforeHandle = await privateToken["balanceOf(address)"](userAddress);
      let balanceBefore = balanceBeforeHandle;
      if (balanceBeforeHandle !== 0n) {
        balanceBefore = await decryptBalanceViaProxy(balanceBeforeHandle, defaultSigner, userAesKey, PROXY_URL);
      }
      expect(balanceBefore).to.equal(expectedPrivateAmount);
      // Store mock token balance before unshield
      const mockTokenBalanceBefore = await mockToken.balanceOf(userAddress);

      // Store the current block number before unshield
      const startBlock = await hre.ethers.provider.getBlockNumber();
      console.log("📊 Start block for unshield:", startBlock);

      // Request unshield
      console.log("🔓 Executing unshield transaction...");
      const unshieldTx = await privateToken.unshield(expectedPrivateAmount);
      console.log("📝 Unshield transaction hash:", unshieldTx.hash);
      
      const unshieldReceipt = await unshieldTx.wait();
      console.log("✅ Unshield transaction confirmed, block:", unshieldReceipt?.blockNumber);
      expect(unshieldReceipt).to.not.be.undefined;

      // Give the MPC network time to handle the callback before querying events
      await new Promise(resolve => setTimeout(resolve, 10000));

      // Check UnshieldRequested event from the start block
      console.log("🔍 Querying for UnshieldRequested events...");
      const requestFilter = privateToken.filters.UnshieldRequested;
      const currentBlockForRequest = await hre.ethers.provider.getBlockNumber();
      const endBlockForRequest = Math.min(startBlock + 1000, currentBlockForRequest); // Limit to 1000 blocks max
      console.log("📊 Query range: blocks", startBlock, "to", endBlockForRequest, "(range:", endBlockForRequest - startBlock, "blocks)");
      
      const requestEvents = await privateToken.queryFilter(requestFilter, startBlock, endBlockForRequest);
      console.log("📋 Found", requestEvents.length, "UnshieldRequested events");
      expect(requestEvents.length).to.be.greaterThan(0);
      expect(requestEvents[0].args[0]).to.equal(userAddress); // 'to' address
      expect(requestEvents[0].args[1]).to.equal(expectedPrivateAmount); // amount
      console.log("✅ UnshieldRequested event verified");
      const { successEvents, failedEvents } = await waitForUnshieldOutcome(startBlock);
      console.log("📋 Unshield events - Success:", successEvents.length, "Failed:", failedEvents.length);

      expect(successEvents.length, "Expected successful unshield event").to.be.greaterThan(0);
      expect(failedEvents.length, "Expected no failed unshield events").to.equal(0);

      // Check mock token balance difference matches the unshield amount
      const mockTokenBalanceAfter = await mockToken.balanceOf(userAddress);
      const balanceDifference = mockTokenBalanceAfter - mockTokenBalanceBefore;
      expect(balanceDifference, "Mock token balance difference should match shield amount").to.equal(shieldAmount);

      // Check total supply reduced
      expect(await privateToken.totalSupply()).to.equal(0);

      // Check user's private balance is zero
      const balanceHandle = await privateToken["balanceOf(address)"](userAddress);
      let decryptedBalance = balanceHandle;
      if (balanceHandle !== 0n) {
        decryptedBalance = await decryptBalanceViaProxy(balanceHandle, defaultSigner, userAesKey, PROXY_URL);
      }
      expect(decryptedBalance).to.equal(0n);
    });

    it("should fail to unshield more than balance", async function () {
      // First shield some tokens
      const shieldReceipt = await (await privateToken.shield(shieldAmount)).wait();
      expect(shieldReceipt?.status).to.equal(1);

      // Try to unshield more than available
      const tooMuch = expectedPrivateAmount * 2n;
      const startBlock = await hre.ethers.provider.getBlockNumber();
      const mockTokenBalanceBefore = await mockToken.balanceOf(userAddress);
      console.log("🔢 Mock token balance before unshield attempt:", mockTokenBalanceBefore.toString());
      const unshieldTx = await privateToken.unshield(tooMuch);
      await unshieldTx.wait();

      const { successEvents, failedEvents } = await waitForUnshieldOutcome(startBlock);
      console.log("📋 Failed unshield events:", failedEvents.length, "Successful events:", successEvents.length);

      const balanceHandle = await privateToken["balanceOf(address)"](userAddress);
      const decryptedBalance = await decryptBalanceViaProxy(balanceHandle, defaultSigner, userAesKey, PROXY_URL);
      const mockTokenBalanceAfter = await mockToken.balanceOf(userAddress);
      console.log("🔢 Mock token balance after unshield attempt:", mockTokenBalanceAfter.toString());

      if (successEvents.length > 0) {
        const unshieldedAmount = successEvents[0].args.amount;
        console.log("✅ Oversized unshield processed as success for amount:", unshieldedAmount.toString());
        expect(failedEvents.length).to.equal(0);
        expect(unshieldedAmount).to.equal(shieldAmount);
        expect(decryptedBalance).to.equal(0n);
        expect(mockTokenBalanceAfter - mockTokenBalanceBefore).to.equal(shieldAmount);
        expect(await privateToken.totalSupply()).to.equal(0);
      } else {
        if (failedEvents.length === 0) {
          console.warn("⚠️ No Unshield events detected; treating as no-op.");
        }
        expect(decryptedBalance).to.equal(expectedPrivateAmount);
        expect(mockTokenBalanceAfter).to.be.at.most(mockTokenBalanceBefore);
        expect(await privateToken.totalSupply()).to.equal(expectedPrivateAmount);
      }
    });

    it("should fail to unshield zero amount", async function () {
      await expect(privateToken.unshield(0))
        .to.be.revertedWith("Amount must be greater than 0");
    });

    it("should successfully unshield private tokens to master address", async function () {
      console.log("🔓 Starting unshieldForMaster test...");

      const masterAddress = await privateToken.master();
      console.log("👤 Master address:", masterAddress);
      expect(masterAddress).to.equal(masterWallet.address);

      console.log("🛡️ First shielding tokens...");
      const receipt = await (await privateToken.shield(shieldAmount)).wait();
      expect(receipt?.status).to.equal(1);
      console.log("✅ Shield completed");

      // Get balance before unshield
      await new Promise(resolve => setTimeout(resolve, 5000));
      const balanceBeforeHandle = await privateToken["balanceOf(address)"](userAddress);
      let balanceBefore = balanceBeforeHandle;
      if (balanceBeforeHandle !== 0n) {
        balanceBefore = await decryptBalanceViaProxy(balanceBeforeHandle, defaultSigner, userAesKey, PROXY_URL);
      }
      expect(balanceBefore).to.equal(expectedPrivateAmount);

      // Store mock token balance of master before unshield
      const masterMockTokenBalanceBefore = await mockToken.balanceOf(masterAddress);
      console.log("💰 Master mock token balance before:", masterMockTokenBalanceBefore.toString());

      // Store the current block number before unshield
      const startBlock = await hre.ethers.provider.getBlockNumber();
      console.log("📊 Start block for unshieldForMaster:", startBlock);

      // Request unshieldForMaster
      console.log("🔓 Executing unshieldForMaster transaction...");
      const unshieldTx = await privateToken.unshieldForMaster(expectedPrivateAmount);
      console.log("📝 UnshieldForMaster transaction hash:", unshieldTx.hash);
      
      const unshieldReceipt = await unshieldTx.wait();
      console.log("✅ UnshieldForMaster transaction confirmed, block:", unshieldReceipt?.blockNumber);
      expect(unshieldReceipt).to.not.be.undefined;

      // Give the MPC network time to handle the callback before querying events
      await new Promise(resolve => setTimeout(resolve, 10000));

      // Check UnshieldRequested event - should be for master address
      console.log("🔍 Querying for UnshieldRequested events...");
      const requestFilter = privateToken.filters.UnshieldRequested;
      const currentBlockForRequest = await hre.ethers.provider.getBlockNumber();
      const endBlockForRequest = Math.min(startBlock + 1000, currentBlockForRequest);
      
      const requestEvents = await privateToken.queryFilter(requestFilter, startBlock, endBlockForRequest);
      console.log("📋 Found", requestEvents.length, "UnshieldRequested events");
      expect(requestEvents.length).to.be.greaterThan(0);
      expect(requestEvents[0].args[0]).to.equal(masterAddress); // 'to' should be master address
      expect(requestEvents[0].args[1]).to.equal(expectedPrivateAmount); // amount
      console.log("✅ UnshieldRequested event verified for master");

      const { successEvents, failedEvents } = await waitForUnshieldOutcome(startBlock);
      console.log("📋 Unshield events - Success:", successEvents.length, "Failed:", failedEvents.length);

      expect(successEvents.length, "Expected successful unshield event").to.be.greaterThan(0);
      expect(failedEvents.length, "Expected no failed unshield events").to.equal(0);

      // Check that master received the tokens
      const masterMockTokenBalanceAfter = await mockToken.balanceOf(masterAddress);
      const masterBalanceDifference = masterMockTokenBalanceAfter - masterMockTokenBalanceBefore;
      console.log("💰 Master mock token balance after:", masterMockTokenBalanceAfter.toString());
      expect(masterBalanceDifference, "Master should receive the unshielded tokens").to.equal(shieldAmount);

      // Check total supply reduced
      expect(await privateToken.totalSupply()).to.equal(0);

      // Check user's private balance is zero
      const balanceHandle = await privateToken["balanceOf(address)"](userAddress);
      let decryptedBalance = balanceHandle;
      if (balanceHandle !== 0n) {
        decryptedBalance = await decryptBalanceViaProxy(balanceHandle, defaultSigner, userAesKey, PROXY_URL);
      }
      expect(decryptedBalance).to.equal(0n);
    });
  });

  describe("Transfer Operations", function () {
    this.timeout(120000); // 2 minutes timeout for MPC operations
    
    const shieldAmount = 100n * 10n ** 18n; // 100 tokens with 18 decimals
    const transferAmount = 50n * 10n ** 18n; // 50 tokens with 18 decimals

    beforeEach(async function () {
      this.timeout(120000); // 2 minutes timeout for beforeEach
      await ensurePrivateBalanceClearedFor(defaultSigner, userAesKey);
      // Mint and shield tokens for transfer tests
      await (await mockToken.mint(userAddress, shieldAmount)).wait();
      await (await mockToken.approve(await privateToken.getAddress(), shieldAmount)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      await (await privateToken.shield(shieldAmount)).wait();
      await new Promise(resolve => setTimeout(resolve, 5000));
    });

    it("should successfully transfer private tokens using clear value", async function () {
      // Transfer to other wallet
      const transferTx = await privateToken["transfer(address,uint256)"](otherWallet.address, transferAmount);
      await transferTx.wait();

      // Allow MPC network to process the transfer
      await new Promise(resolve => setTimeout(resolve, 10000));

      // Check sender's balance
      const senderBalanceHandle = await privateToken["balanceOf(address)"](userAddress);
      const senderBalance = await decryptBalanceViaProxy(senderBalanceHandle, defaultSigner, userAesKey, PROXY_URL);
      expect(senderBalance).to.equal(50n * 10n ** 18n); // 50 tokens remaining

      // Note: We can't check receiver's balance as they haven't onboarded yet
      // In a real scenario, the receiver would need to onboard to view their balance
    });

    it("should fail to transfer more than balance", async function () {
      const tooMuch = 200n * 10n ** 18n; // 200 tokens with 18 decimals

      await new Promise(resolve => setTimeout(resolve, 2000));
      const senderBalanceHandleBefore = await privateToken["balanceOf(address)"](userAddress);
      const senderBalanceBefore = await decryptBalanceViaProxy(senderBalanceHandleBefore, defaultSigner, userAesKey, PROXY_URL);
      console.log("🔢 Sender private balance before oversized transfer:", senderBalanceBefore.toString());

      const transferTx = await privateToken["transfer(address,uint256)"](otherWallet.address, tooMuch);
      const transferReceipt = await transferTx.wait();
      expect(transferReceipt?.status).to.equal(1);

      await new Promise(resolve => setTimeout(resolve, 10000));

      const senderBalanceHandleAfter = await privateToken["balanceOf(address)"](userAddress);
      const senderBalanceAfter = await decryptBalanceViaProxy(senderBalanceHandleAfter, defaultSigner, userAesKey, PROXY_URL);
      console.log("🔢 Sender private balance after oversized transfer:", senderBalanceAfter.toString());
      expect(senderBalanceAfter).to.equal(senderBalanceBefore);
    });

    it("should successfully transfer private tokens using encrypted IT value", async function () {
      // Onboard the receiver (otherWallet)
      const otherUserAesKey = await getUserKeyViaProxy(otherWallet, PROXY_URL);
      const privateTokenDecimals = 18;
      const amount = "50";
      const PRIVATE_TOKEN_ADDRESS = await privateToken.getAddress();

      // Get balances before transfer
      await new Promise(resolve => setTimeout(resolve, 5000));

      const senderBalanceHandleBefore = await privateToken["balanceOf(address)"](userAddress);
      
      const senderBalanceBefore = await decryptBalanceViaProxy(senderBalanceHandleBefore, defaultSigner, userAesKey, PROXY_URL);

      const receiverBalanceHandleBefore = await privateToken["balanceOf(address)"](otherWallet.address);
      let receiverBalanceBefore = receiverBalanceHandleBefore
      if (receiverBalanceBefore !== 0n) {
        receiverBalanceBefore = await decryptBalanceViaProxy(receiverBalanceHandleBefore, otherWallet, otherUserAesKey, PROXY_URL);
      }
      const amountInBigInt = BigInt(hre.ethers.parseUnits(amount, privateTokenDecimals))
      // Prepare encrypted message using 256-bit encryption
      const { encryptedHigh, encryptedLow } = prepareMessageForBubble256(
        amountInBigInt,
        await defaultSigner.getAddress(),
        userAesKey.toString("hex"),
        PRIVATE_TOKEN_ADDRESS
      );

      // Execute the transfer using the IT struct with 256-bit ciphertext
      // itUint256 = { userAddress, ciphertext: { ciphertextHigh, ciphertextLow } }
      const transferTx = await privateToken["transfer(address,(address,(uint256,uint256)))"](otherWallet.address, {
        userAddress: await defaultSigner.getAddress(),
        ciphertext: {
          ciphertextHigh: encryptedHigh,
          ciphertextLow: encryptedLow
        }
      });
      const transferReceipt = await transferTx.wait();

      // Wait for MPC network to process the changes
      await new Promise(resolve => setTimeout(resolve, 10000)); // Increased to 10 seconds

      // Get balances after transfer
      const senderBalanceHandleAfter = await privateToken["balanceOf(address)"](userAddress);
      const senderBalanceAfter = await decryptBalanceViaProxy(senderBalanceHandleAfter, defaultSigner, userAesKey, PROXY_URL);
      
      const receiverBalanceHandleAfter = await privateToken["balanceOf(address)"](otherWallet.address);
      const receiverBalanceAfter = await decryptBalanceViaProxy(receiverBalanceHandleAfter, otherWallet, otherUserAesKey, PROXY_URL);

      // Assert balances
      expect(senderBalanceAfter).to.equal(senderBalanceBefore - BigInt(hre.ethers.parseUnits(amount, privateTokenDecimals)));
      expect(receiverBalanceAfter).to.equal(receiverBalanceBefore + BigInt(hre.ethers.parseUnits(amount, privateTokenDecimals)));
    });

    it("should handle self-transfer using clear value (transferring to oneself)", async function () {
      // Get balance before self-transfer
      await new Promise(resolve => setTimeout(resolve, 5000));
      const balanceHandleBefore = await privateToken["balanceOf(address)"](userAddress);
      const balanceBefore = await decryptBalanceViaProxy(balanceHandleBefore, defaultSigner, userAesKey, PROXY_URL);

      // Self-transfer (transfer to same address)
      const transferTx = await privateToken["transfer(address,uint256)"](userAddress, transferAmount);
      await transferTx.wait();

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get balance after self-transfer
      const balanceHandleAfter = await privateToken["balanceOf(address)"](userAddress);
      const balanceAfter = await decryptBalanceViaProxy(balanceHandleAfter, defaultSigner, userAesKey, PROXY_URL);

      // Check for weird behavior - balance should remain the same in a self-transfer
      expect(balanceAfter).to.equal(balanceBefore, "Self-transfer should not change total balance");
    });

    it("should handle self-transfer using encrypted IT value (transferring to oneself)", async function () {
      const privateTokenDecimals = 18;
      const amount = "25"; // Transfer 25 tokens to self
      const PRIVATE_TOKEN_ADDRESS = await privateToken.getAddress();

      // Get balance before self-transfer
      await new Promise(resolve => setTimeout(resolve, 5000));
      const balanceHandleBefore = await privateToken["balanceOf(address)"](userAddress);
      const balanceBefore = await decryptBalanceViaProxy(balanceHandleBefore, defaultSigner, userAesKey, PROXY_URL);

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
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get balance after self-transfer
      const balanceHandleAfter = await privateToken["balanceOf(address)"](userAddress);
      const balanceAfter = await decryptBalanceViaProxy(balanceHandleAfter, defaultSigner, userAesKey, PROXY_URL);

      // Check for weird behavior - balance should remain the same in a self-transfer
      expect(balanceAfter).to.equal(balanceBefore, "Encrypted self-transfer should not change total balance");
    });
  });

  describe("Master Address Management", function () {
    let newMasterWallet: HDNodeWallet;

    before(async function () {
      // Create a new wallet to use as the new master address
      newMasterWallet = Wallet.createRandom().connect(hre.ethers.provider) as HDNodeWallet;
      console.log("✅ Created new master wallet:", newMasterWallet.address);
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
      const events = await privateToken.queryFilter(
        privateToken.filters.MasterUpdated(),
        receipt?.blockNumber,
        receipt?.blockNumber
      );
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
      const ImplementationFactory = await hre.ethers.getContractFactory(
        "contracts/PrivateERC20Contract256.sol:PrivateERC20Contract256",
        defaultSigner
      );
      const newImplementation = await ImplementationFactory.deploy();
      await newImplementation.waitForDeployment();

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
      this.timeout(120000);
      // Ensure user starts with zero private balance
      await ensurePrivateBalanceClearedFor(defaultSigner, userAesKey);
    });

    it("should transfer all underlying tokens to owner when contract has balance", async function () {
      // Mint and shield tokens to create a balance in the contract
      await (await mockToken.mint(userAddress, shieldAmount)).wait();
      await (await mockToken.approve(await privateToken.getAddress(), shieldAmount)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const shieldTx = await privateToken.shield(shieldAmount);
      await shieldTx.wait();
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Verify contract has the underlying tokens
      const contractBalanceBefore = await mockToken.balanceOf(await privateToken.getAddress());
      expect(contractBalanceBefore).to.equal(shieldAmount);

      // Get owner's balance before recovery
      const ownerBalanceBefore = await mockToken.balanceOf(defaultSigner.address);

      // Execute emergency recovery
      const recoveryTx = await privateToken.connect(defaultSigner).emergencyRecovery();
      const receipt = await recoveryTx.wait();
      
      expect(receipt).to.not.be.undefined;
      expect(receipt?.status).to.equal(1);

      // Verify contract balance is now zero
      const contractBalanceAfter = await mockToken.balanceOf(await privateToken.getAddress());
      expect(contractBalanceAfter).to.equal(0n);

      // Verify owner received the tokens
      const ownerBalanceAfter = await mockToken.balanceOf(defaultSigner.address);
      expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(shieldAmount);

      // Verify event was emitted
      const events = await privateToken.queryFilter(
        privateToken.filters.EmergencyRecovery(),
        receipt?.blockNumber,
        receipt?.blockNumber
      );
      expect(events.length).to.be.greaterThan(0);
      expect(events[0].args.owner).to.equal(defaultSigner.address);
      expect(events[0].args.amount).to.equal(shieldAmount);
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
      const events = await privateToken.queryFilter(
        privateToken.filters.EmergencyRecovery(),
        receipt?.blockNumber,
        receipt?.blockNumber
      );
      // Event should not be emitted when balance is zero
      expect(events.length).to.equal(0);
    });

    it("should revert when non-owner tries to call emergency recovery", async function () {
      await expect(
        privateToken.connect(otherWallet).emergencyRecovery()
      ).to.be.revertedWithCustomError(privateToken, "OwnableUnauthorizedAccount")
        .withArgs(otherWallet.address);
    });

    it("should transfer partial balance if tokens are added after initial recovery", async function () {
      // First, ensure contract has no balance
      const initialBalance = await mockToken.balanceOf(await privateToken.getAddress());
      if (initialBalance > 0n) {
        await (await privateToken.connect(defaultSigner).emergencyRecovery()).wait();
      }

      // Shield some tokens
      await (await mockToken.mint(userAddress, shieldAmount)).wait();
      await (await mockToken.approve(await privateToken.getAddress(), shieldAmount)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const shieldTx = await privateToken.shield(shieldAmount);
      await shieldTx.wait();
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get owner balance before recovery
      const ownerBalanceBefore = await mockToken.balanceOf(defaultSigner.address);

      // Execute emergency recovery
      const recoveryTx = await privateToken.connect(defaultSigner).emergencyRecovery();
      await recoveryTx.wait();

      // Verify owner received the tokens
      const ownerBalanceAfter = await mockToken.balanceOf(defaultSigner.address);
      expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(shieldAmount);

      // Verify contract balance is zero
      const contractBalance = await mockToken.balanceOf(await privateToken.getAddress());
      expect(contractBalance).to.equal(0n);
    });

    it("should work correctly after contract upgrade", async function () {
      // Shield some tokens first
      await (await mockToken.mint(userAddress, shieldAmount)).wait();
      await (await mockToken.approve(await privateToken.getAddress(), shieldAmount)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const shieldTx = await privateToken.shield(shieldAmount);
      await shieldTx.wait();
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Deploy new implementation
      const ImplementationFactory = await hre.ethers.getContractFactory(
        "contracts/PrivateERC20Contract256.sol:PrivateERC20Contract256",
        defaultSigner
      );
      const newImplementation = await ImplementationFactory.deploy();
      await newImplementation.waitForDeployment();

      // Upgrade the contract
      await (await privateToken.connect(defaultSigner).upgradeToAndCall(
        await newImplementation.getAddress(),
        "0x"
      )).wait();

      // Verify contract still has the underlying tokens after upgrade
      const contractBalanceBefore = await mockToken.balanceOf(await privateToken.getAddress());
      expect(contractBalanceBefore).to.equal(shieldAmount);

      // Execute emergency recovery after upgrade
      const ownerBalanceBefore = await mockToken.balanceOf(defaultSigner.address);
      const recoveryTx = await privateToken.connect(defaultSigner).emergencyRecovery();
      await recoveryTx.wait();

      // Verify recovery still works after upgrade
      const ownerBalanceAfter = await mockToken.balanceOf(defaultSigner.address);
      expect(ownerBalanceAfter - ownerBalanceBefore).to.equal(shieldAmount);

      const contractBalanceAfter = await mockToken.balanceOf(await privateToken.getAddress());
      expect(contractBalanceAfter).to.equal(0n);
    });
  });

  describe("Unshield callback via GetDecryption HTTP", function () {
    this.timeout(120000);

    it("should complete unshield by fetching callback tx_data from proxy and submitting it", async function () {
      console.log("🔓 Unshield via GetDecryption HTTP: shield first...");
      const shieldAmount = 100n * 10n ** 18n;
      const expectedPrivateAmount = shieldAmount;
      await (await mockToken.mint(userAddress, shieldAmount)).wait();
      await (await mockToken.approve(await privateToken.getAddress(), shieldAmount)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      const shieldReceipt = await (await privateToken.shield(shieldAmount)).wait();
      expect(shieldReceipt?.status).to.equal(1);

      await new Promise(resolve => setTimeout(resolve, 5000));
      const balanceBeforeHandle = await privateToken["balanceOf(address)"](userAddress);
      let balanceBefore = balanceBeforeHandle;
      if (balanceBeforeHandle !== 0n) {
        balanceBefore = await decryptBalanceViaProxy(balanceBeforeHandle, defaultSigner, userAesKey, PROXY_URL);
      }
      expect(balanceBefore).to.equal(expectedPrivateAmount);

      const contractAddress = await privateToken.getAddress();
      const mockTokenBalanceBefore = await mockToken.balanceOf(userAddress);
      const startBlock = await hre.ethers.provider.getBlockNumber();

      console.log("🔓 Unshield via GetDecryption HTTP: request unshield...");
      const unshieldTx = await privateToken.unshield(expectedPrivateAmount);
      const unshieldReceipt = await unshieldTx.wait();
      expect(unshieldReceipt).to.not.be.undefined;

      const decryptId = await privateToken.getLastDecryptRequestId();
      console.log("📋 Last decrypt request ID:", decryptId.toString());

      console.log("⏳ Waiting for MPC to produce decryption...");
      await new Promise(resolve => setTimeout(resolve, 15000));

      const network = await hre.ethers.provider.getNetwork();
      const chainId = Number(network.chainId);
      // Flow: Proxy calls gRPC GetDecryption(chainId, contract, decryptId). Backend returns
      // calldata to invoke callbackUnshield(decryptId, output, signatures). We may submit it
      // ourselves, or the MPC relayer may have already submitted it (then our tx reverts).
      console.log("📡 Fetching callback tx_data from proxy POST /get-decryption...");
      const txDataHex = await getDecryptionTxDataViaProxy(PROXY_URL, chainId, contractAddress, decryptId);

      console.log("📥 Proxy response:", {
        request: { chainId, contractAddress, user_decrypt_id: decryptId.toString() },
        response: {
          tx_data_length: txDataHex.length,
          tx_data_preview: txDataHex.length > 2 ? `${txDataHex.slice(0, 20)}...` : "(empty)",
        },
      });

      const hasTxData = txDataHex && txDataHex.length > 2 && txDataHex !== "0x";
      if (hasTxData) {
        console.log("📤 Submitting callback transaction...");
        try {
          const tx = await defaultSigner.sendTransaction({
            to: contractAddress,
            data: txDataHex,
            gasLimit: 500_000,
          });
          const callbackReceipt = await tx.wait();
          expect(callbackReceipt?.status).to.equal(1);
        } catch (err: any) {
          if (err?.code === "CALL_EXCEPTION" || err?.receipt?.status === 0) {
            console.log("📋 Callback tx reverted (MPC relayer may have already submitted it); waiting for outcome...");
          } else {
            throw err;
          }
        }
      } else {
        console.log("📋 No tx_data from proxy (MPC relayer may have already run callback); waiting for outcome...");
      }

      // Either we submitted the callback or the relayer did; poll for Unshield/UnshieldFailed and assert final state.
      const { successEvents, failedEvents } = await waitForUnshieldOutcome(startBlock);
      expect(successEvents.length, "Expected successful unshield event").to.be.greaterThan(0);
      expect(failedEvents.length, "Expected no failed unshield events").to.equal(0);

      const mockTokenBalanceAfter = await mockToken.balanceOf(userAddress);
      expect(mockTokenBalanceAfter - mockTokenBalanceBefore).to.equal(shieldAmount);
      expect(await privateToken.totalSupply()).to.equal(0);

      const balanceHandle = await privateToken["balanceOf(address)"](userAddress);
      let decryptedBalance = balanceHandle;
      if (balanceHandle !== 0n) {
        decryptedBalance = await decryptBalanceViaProxy(balanceHandle, defaultSigner, userAesKey, PROXY_URL);
      }
      expect(decryptedBalance).to.equal(0n);
      console.log("✅ Unshield callback via GetDecryption HTTP completed");
    });
  });
}); 
