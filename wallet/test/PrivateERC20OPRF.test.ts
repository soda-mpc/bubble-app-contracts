import { expect } from "chai";
import hre from "hardhat";
import fetch from "node-fetch";
import { Wallet, getBytes, HDNodeWallet } from "ethers";
import crypto from "crypto";
import dotenv from "dotenv";

import {
  generateRSAKeyPair,
  reconstructUserKey,
  decryptUint
} from "soda-sdk";
import {
  prepareMessageForBubble,
  prepareMessageForBubble128,
  prepareMessageForBubble256
} from "./testUtils";
import { decryptValueViaProxy, decryptMultipleValuesViaProxy, getUserKeyViaProxy } from "./testUtils";

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
    console.log("🚀 Starting PrivateERC20Contract OPRF test setup...");
    
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

    // Deploy mock token using the default signer
    console.log("🏗️ Deploying mock token...");
    const MockTokenFactory = await hre.ethers.getContractFactory("TUSDC", defaultSigner);
    mockToken = await MockTokenFactory.deploy("Test USDC", "TUSDC");
    await mockToken.waitForDeployment();
    console.log("✅ Mock token deployed at:", await mockToken.getAddress());
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Deploy PrivateERC20Contract256 implementation
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
      "Test Private Token",
      "TPT",
      await mockToken.getAddress(),
      defaultSigner.address,
      defaultSigner.address // master address
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
    
    // Ensure contract bytecode is available before continuing
    const code = await waitForContractCode(proxyAddress);
    console.log("📄 Contract code length:", code.length);
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Give the user some private ERC20 tokens by shielding some underlying tokens
    console.log("💰 Setting up initial token balance...");
    const underlyingAmount = hre.ethers.parseEther("1000"); // 1000 tokens
    const transferTx = await mockToken.transfer(userAddress, underlyingAmount);
    await transferTx.wait();
    
    // Approve the private token contract to spend underlying tokens
    const approveTx = await mockToken.approve(await privateToken.getAddress(), underlyingAmount);
    await approveTx.wait();
    
    // Shield some tokens to get private ERC20 tokens
    const shieldAmount = hre.ethers.parseEther("100"); // Shield 100 tokens
    const shieldTx = await privateToken.shield(shieldAmount);
    await shieldTx.wait();
    
    // Wait for MPC computation to complete
    await new Promise(resolve => setTimeout(resolve, 5000));
    console.log("✅ Initial setup completed");
  });

  describe("OPRF Token tests", function () {
    it("Should successfully mint OPRF tokens with encrypted parameters", async function () {
      // Skip if not on sepolia-base
      const network = await hre.ethers.provider.getNetwork();

      const quantity = 50n;

      // Prepare encrypted quantity parameter using the 256-bit approach
      const { encryptedHigh: qtyHigh, encryptedLow: qtyLow, messageBytes: qtyMessageBytes } = prepareMessageForBubble256(
        quantity,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQtyMessage = await defaultSigner.signMessage(qtyMessageBytes);

      // For itUint256: ciphertext is ctUint256 struct with ciphertextHigh and ciphertextLow
      // Use the pre-split values from prepareMessageForBubble256
      const quantityIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qtyHigh,
          ciphertextLow: qtyLow
        },
        signature: signedQtyMessage
      };

      // Mint OPRF token
      const tx = await privateToken.mintOPRFToken(quantityIT);
      const receipt = await tx.wait();
      expect(receipt?.status).to.equal(1);
      
      // Add delay to allow MPC computation to complete
      await new Promise(resolve => setTimeout(resolve, 5000)); // 5 second delay
      
      // Check that the OPRFMinted event was emitted
      const event = receipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMinted";
        } catch {
          return false;
        }
      });
      
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

        // Wait for MPC computation to complete before decryption
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        // Decrypt the values off-chain
        const decryptedX = await decryptValueViaProxy(xHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedY = await decryptValueViaProxy(yHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedQ = await decryptValueViaProxy(qGTHandle, defaultSigner, userAesKey, PROXY_URL);
        
        // Verify the decrypted values are correct
        expect(decryptedX).to.not.equal(0n);
        expect(decryptedY).to.not.equal(0n);
        expect(decryptedQ).to.equal(quantity);
      }
    });

    it("Should mint OPRF tokens for actual transferred amount when insufficient balance", async function () {

      // Ensure user has enough private ERC20 balance for this test
      const additionalShieldAmount = hre.ethers.parseEther("50"); // Shield additional 50 tokens
      await mockToken.transfer(userAddress, additionalShieldAmount);
      await mockToken.approve(await privateToken.getAddress(), additionalShieldAmount);
      await privateToken.shield(additionalShieldAmount);
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for MPC computation

      const requestedQuantity = 200n; // Try to mint more than user has
      
      // Prepare encrypted quantity parameter for the requested amount
      const { encryptedHigh: qtyHigh, encryptedLow: qtyLow, messageBytes: qtyMessageBytes } = prepareMessageForBubble256(
        requestedQuantity,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQtyMessage = await defaultSigner.signMessage(qtyMessageBytes);

      const quantityIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qtyHigh,
          ciphertextLow: qtyLow
        },
        signature: signedQtyMessage
      };

      // Mint OPRF token - should succeed but mint for actual transferred amount
      const tx = await privateToken.mintOPRFToken(quantityIT);
      const receipt = await tx.wait();
      
      expect(receipt?.status).to.equal(1);
      
      // Add delay to allow MPC computation to complete
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Check that the OPRFMinted event was emitted
      const event = receipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMinted";
        } catch {
          return false;
        }
      });
      
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
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Decrypt the values off-chain
        const decryptedX = await decryptValueViaProxy(xHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedY = await decryptValueViaProxy(yHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedQ = await decryptValueViaProxy(qGTHandle, defaultSigner, userAesKey, PROXY_URL);
        
        // Verify the decrypted values are non-zero (indicating successful OPRF computation)
        expect(decryptedX).to.not.equal(0n);
        expect(decryptedY).to.not.equal(0n);
        
        // Verify the decrypted qGT matches the actual transferred amount (not the requested amount)
        console.log("Actual Transferred Amount:", decryptedQ.toString());
        console.log("Requested Amount:", requestedQuantity.toString());
        
        // The actual amount should be less than or equal to the requested amount
        expect(decryptedQ).to.be.at.most(requestedQuantity);
        
        // The actual amount should be greater than 0 (some tokens were transferred)
        expect(decryptedQ).to.be.greaterThan(0n);
        
        console.log("✅ Successfully minted OPRF tokens for actual transferred amount:", decryptedQ.toString());
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
      const { encryptedHigh: qtyHigh, encryptedLow: qtyLow, messageBytes: qtyMessageBytes } = prepareMessageForBubble256(
        requestedQuantity,
        newUserAddress,
        newUserAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQtyMessage = await newWallet.signMessage(qtyMessageBytes);

      const quantityIT = {
        userAddress: newUserAddress,
        ciphertext: {
          ciphertextHigh: qtyHigh,
          ciphertextLow: qtyLow
        },
        signature: signedQtyMessage
      };

      // Mint OPRF token - should succeed but mint 0 tokens
      const tx = await privateTokenWithNewUser.mintOPRFToken(quantityIT);
      const receipt = await tx.wait();
      
      expect(receipt?.status).to.equal(1);
      
      // Add delay to allow MPC computation to complete
      await new Promise(resolve => setTimeout(resolve, 5000));
      
      // Check that the OPRFMinted event was emitted
      const event = receipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMinted";
        } catch {
          return false;
        }
      });
      
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
        await new Promise(resolve => setTimeout(resolve, 2000));
        
        // Decrypt the values off-chain
        const decryptedX = await decryptValueViaProxy(xHandle, newWallet, newUserAesKey, PROXY_URL);
        const decryptedY = await decryptValueViaProxy(yHandle, newWallet, newUserAesKey, PROXY_URL);
        const decryptedQ = await decryptValueViaProxy(qGTHandle, newWallet, newUserAesKey, PROXY_URL);
        
        // Verify the decrypted qGT is 0 (no tokens were transferred)
        expect(decryptedQ).to.equal(0n);
      }
    });

    it("Should successfully split OPRF tokens with encrypted parameters", async function () {

      // Ensure user has enough private ERC20 balance for this test
      const additionalShieldAmount = hre.ethers.parseEther("50"); // Shield additional 50 tokens
      await mockToken.transfer(userAddress, additionalShieldAmount);
      await mockToken.approve(await privateToken.getAddress(), additionalShieldAmount);
      await privateToken.shield(additionalShieldAmount);
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for MPC computation

      const quantity = 50n;
      // yClear will be set after we decrypt the minted values
      const qSplit = 20n; // Amount to split off as payment (uint256) - following user_contract.sol example
      
      // Mint an OPRF token (no approval needed since mintOPRFToken uses direct transfer)
      const { encryptedHigh: qtyHigh, encryptedLow: qtyLow, messageBytes: qtyMessageBytes } = prepareMessageForBubble256(
        quantity,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQtyMessage = await defaultSigner.signMessage(qtyMessageBytes);

      const quantityIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qtyHigh,
          ciphertextLow: qtyLow
        },
        signature: signedQtyMessage
      };


      // Mint OPRF token
      const mintTx = await privateToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get the minted values from the event
      const mintEvent = mintReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMinted";
        } catch {
          return false;
        }
      });

      expect(mintEvent).to.not.be.undefined;
      const mintDecoded = privateToken.interface.parseLog(mintEvent!);
      const xHandle = mintDecoded?.args[1];
      const yHandle = mintDecoded?.args[2];
      const qHandle = mintDecoded?.args[3];

      // Wait a bit for MPC computation to complete before decryption
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Decrypt X, Y, and Q values from minting
      const decryptedX = await decryptValueViaProxy(xHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedY = await decryptValueViaProxy(yHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedQ = await decryptValueViaProxy(qHandle, defaultSigner, userAesKey, PROXY_URL);

      // Set yClear to the decrypted Y value for splitting
      // Check if the value fits in uint128 range
      if (decryptedY > BigInt(2**128 - 1)) {
        throw new Error(`Y value ${decryptedY} is too large for uint128`);
      }
      
      // Keep as BigInt - ethers.js will handle the conversion to uint128
      const yClear = decryptedY;

      // For splitting, we need to re-encrypt the decrypted X value using prepareMessageForBubble128 (for itUint128)
      
      // Check if X value fits in uint128 range
      if (decryptedX > BigInt(2**128 - 1)) {
        throw new Error(`X value ${decryptedX} is too large for uint128`);
      }
      
      const { encryptedInt: xEncrypted, messageBytes: xMessageBytes } = prepareMessageForBubble128(
        decryptedX, // Use the full decrypted X value from minting
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedXMessage = await defaultSigner.signMessage(xMessageBytes);

      // Use the decrypted Q value for splitting
      const { encryptedHigh: qHigh, encryptedLow: qLow, messageBytes: qMessageBytes } = prepareMessageForBubble256(
        decryptedQ, // Use the decrypted Q value from minting
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQMessage = await defaultSigner.signMessage(qMessageBytes);

      const { encryptedHigh: qSplitHigh, encryptedLow: qSplitLow, messageBytes: qSplitMessageBytes } = prepareMessageForBubble256(
        qSplit, // Now using 80n instead of 300n
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQSplitMessage = await defaultSigner.signMessage(qSplitMessageBytes);

      const xIT = {
        userAddress: userAddress,
        ciphertext: xEncrypted, // itUint128 uses single ciphertext (ctUint128 which is uint256)
        signature: signedXMessage
      };
      const qIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qHigh,
          ciphertextLow: qLow
        },
        signature: signedQMessage
      };
      const qSplitIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qSplitHigh,
          ciphertextLow: qSplitLow
        },
        signature: signedQSplitMessage
      };


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
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get the split event
      const splitEvent = splitReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFSplit";
        } catch {
          return false;
        }
      });

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
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Decrypt the split values using the same approach as existing tests
        const decryptedXrRemainder = await decryptValueViaProxy(xrRemainderHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedQRemainder = await decryptValueViaProxy(qRemainderHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedYRemainder = await decryptValueViaProxy(yRemainderHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedXrPay = await decryptValueViaProxy(xrPayHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedQPay = await decryptValueViaProxy(qPayHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedYPay = await decryptValueViaProxy(yPayHandle, defaultSigner, userAesKey, PROXY_URL);



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
      await mockToken.transfer(userAddress, additionalShieldAmount);
      await mockToken.approve(await privateToken.getAddress(), additionalShieldAmount);
      await privateToken.shield(additionalShieldAmount);
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for MPC computation

      const quantity = 50n;
      const qSplit = 80n; // Try to split more than we have (80 > 50)
      
      // Mint an OPRF token (no approval needed since mintOPRFToken uses direct transfer)
      const { encryptedHigh: qtyHigh, encryptedLow: qtyLow, messageBytes: qtyMessageBytes } = prepareMessageForBubble256(
        quantity,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQtyMessage = await defaultSigner.signMessage(qtyMessageBytes);

      const quantityIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qtyHigh,
          ciphertextLow: qtyLow
        },
        signature: signedQtyMessage
      };

      // Mint OPRF token
      const mintTx = await privateToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get the minted values from the event
      const mintEvent = mintReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMinted";
        } catch {
          return false;
        }
      });

      expect(mintEvent).to.not.be.undefined;
      const mintDecoded = privateToken.interface.parseLog(mintEvent!);
      const xHandle = mintDecoded?.args[1];
      const yHandle = mintDecoded?.args[2];
      const qHandle = mintDecoded?.args[3];

      // Wait a bit for MPC computation to complete before decryption
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Decrypt X, Y, and Q values from minting
      const decryptedX = await decryptValueViaProxy(xHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedY = await decryptValueViaProxy(yHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedQ = await decryptValueViaProxy(qHandle, defaultSigner, userAesKey, PROXY_URL);

      // Set yClear to the decrypted Y value for splitting
      if (decryptedY > BigInt(2**128 - 1)) {
        throw new Error(`Y value ${decryptedY} is too large for uint128`);
      }
      const yClear = decryptedY;

      // For splitting, we need to re-encrypt the decrypted X value using prepareMessageForBubble128 (for itUint128)
      if (decryptedX > BigInt(2**128 - 1)) {
        throw new Error(`X value ${decryptedX} is too large for uint128`);
      }
      
      const { encryptedInt: xEncrypted, messageBytes: xMessageBytes } = prepareMessageForBubble128(
        decryptedX,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedXMessage = await defaultSigner.signMessage(xMessageBytes);

      const { encryptedHigh: qHigh, encryptedLow: qLow, messageBytes: qMessageBytes } = prepareMessageForBubble256(
        decryptedQ,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQMessage = await defaultSigner.signMessage(qMessageBytes);

      const { encryptedHigh: qSplitHigh, encryptedLow: qSplitLow, messageBytes: qSplitMessageBytes } = prepareMessageForBubble256(
        qSplit,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQSplitMessage = await defaultSigner.signMessage(qSplitMessageBytes);

      const xIT = {
        userAddress: userAddress,
        ciphertext: xEncrypted,
        signature: signedXMessage
      };
      const qIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qHigh,
          ciphertextLow: qLow
        },
        signature: signedQMessage
      };
      const qSplitIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qSplitHigh,
          ciphertextLow: qSplitLow
        },
        signature: signedQSplitMessage
      };

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
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get the split event
      const splitEvent = splitReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFSplit";
        } catch {
          return false;
        }
      });

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
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Decrypt the split values
        const decryptedXrRemainder = await decryptValueViaProxy(xrRemainderHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedQRemainder = await decryptValueViaProxy(qRemainderHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedYRemainder = await decryptValueViaProxy(yRemainderHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedXrPay = await decryptValueViaProxy(xrPayHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedQPay = await decryptValueViaProxy(qPayHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedYPay = await decryptValueViaProxy(yPayHandle, defaultSigner, userAesKey, PROXY_URL);

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
      await mockToken.transfer(userAddress, additionalShieldAmount);
      await mockToken.approve(await privateToken.getAddress(), additionalShieldAmount);
      await privateToken.shield(additionalShieldAmount);
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for MPC computation

      const quantity = 50n;
      const qSplit = 20n; // Amount to split off as payment
      
      // Mint an OPRF token (no approval needed since mintOPRFToken uses direct transfer)
      const { encryptedHigh: qtyHigh, encryptedLow: qtyLow, messageBytes: qtyMessageBytes } = prepareMessageForBubble256(
        quantity,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQtyMessage = await defaultSigner.signMessage(qtyMessageBytes);

      const quantityIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qtyHigh,
          ciphertextLow: qtyLow
        },
        signature: signedQtyMessage
      };

      // Mint OPRF token
      const mintTx = await privateToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get the minted values from the event
      const mintEvent = mintReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMinted";
        } catch {
          return false;
        }
      });

      expect(mintEvent).to.not.be.undefined;
      const mintDecoded = privateToken.interface.parseLog(mintEvent!);
      const xHandle = mintDecoded?.args[1];
      const yHandle = mintDecoded?.args[2];
      const qHandle = mintDecoded?.args[3];

      // Wait a bit for MPC computation to complete before decryption
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Decrypt X, Y, and Q values from minting
      const decryptedX = await decryptValueViaProxy(xHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedY = await decryptValueViaProxy(yHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedQ = await decryptValueViaProxy(qHandle, defaultSigner, userAesKey, PROXY_URL);

      // Set yClear to the decrypted Y value for splitting
      if (decryptedY > BigInt(2**128 - 1)) {
        throw new Error(`Y value ${decryptedY} is too large for uint128`);
      }
      const yClear = decryptedY;

      // Re-encrypt the decrypted values using a temporary account (matches frontend anonymous flow)
      if (decryptedX > BigInt(2**128 - 1)) {
        throw new Error(`X value ${decryptedX} is too large for uint128`);
      }

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

      const { encryptedInt: xEncrypted, messageBytes: xMessageBytes } = prepareMessageForBubble128(
        decryptedX,
        tempAddress,
        tempAesKeyHex,
        await privateToken.getAddress()
      );
      const signedXMessage = await tempWallet.signMessage(xMessageBytes);

      const { encryptedHigh: qHigh, encryptedLow: qLow, messageBytes: qMessageBytes } = prepareMessageForBubble256(
        decryptedQ,
        tempAddress,
        tempAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQMessage = await tempWallet.signMessage(qMessageBytes);

      const { encryptedHigh: qSplitHigh, encryptedLow: qSplitLow, messageBytes: qSplitMessageBytes } = prepareMessageForBubble256(
        qSplit,
        tempAddress,
        tempAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQSplitMessage = await tempWallet.signMessage(qSplitMessageBytes);

      const xIT = {
        userAddress: tempAddress,
        ciphertext: xEncrypted,
        signature: signedXMessage
      };
      const qIT = {
        userAddress: tempAddress,
        ciphertext: {
          ciphertextHigh: qHigh,
          ciphertextLow: qLow
        },
        signature: signedQMessage
      };
      const qSplitIT = {
        userAddress: tempAddress,
        ciphertext: {
          ciphertextHigh: qSplitHigh,
          ciphertextLow: qSplitLow
        },
        signature: signedQSplitMessage
      };

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
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get the split event
      const splitEvent = splitReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFSplit";
        } catch {
          return false;
        }
      });

      expect(splitEvent).to.not.be.undefined;
      const splitDecoded = privateToken.interface.parseLog(splitEvent!);
      const xrRemainderHandle = splitDecoded?.args[1];
      const qRemainderHandle = splitDecoded?.args[2];
      const yRemainderHandle = splitDecoded?.args[3];
      const xrPayHandle = splitDecoded?.args[4];
      const qPayHandle = splitDecoded?.args[5];
      const yPayHandle = splitDecoded?.args[6];

      // Wait a bit more for MPC computation to complete before decryption
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Decrypt the split values
      const decryptedXrRemainder = await decryptValueViaProxy(xrRemainderHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedQRemainder = await decryptValueViaProxy(qRemainderHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedYRemainder = await decryptValueViaProxy(yRemainderHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedXrPay = await decryptValueViaProxy(xrPayHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedQPay = await decryptValueViaProxy(qPayHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedYPay = await decryptValueViaProxy(yPayHandle, defaultSigner, userAesKey, PROXY_URL);

      console.log("Split Results:");
      console.log("  Remainder Quantity:", decryptedQRemainder.toString());
      console.log("  Payment Quantity:", decryptedQPay.toString());
      console.log("  Total (should equal original):", (decryptedQRemainder + decryptedQPay).toString());

      // Now prepare for merging - re-encrypt the split values

      // Re-encrypt xrRemainder
      const { encryptedInt: xrRemainderEncrypted, messageBytes: xrRemainderMessageBytes } = prepareMessageForBubble128(
        decryptedXrRemainder,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedXrRemainderMessage = await defaultSigner.signMessage(xrRemainderMessageBytes);

      // Re-encrypt qRemainder
      const { encryptedHigh: qRemainderHigh, encryptedLow: qRemainderLow, messageBytes: qRemainderMessageBytes } = prepareMessageForBubble256(
        decryptedQRemainder,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQRemainderMessage = await defaultSigner.signMessage(qRemainderMessageBytes);

      // Re-encrypt xrPay
      const { encryptedInt: xrPayEncrypted, messageBytes: xrPayMessageBytes } = prepareMessageForBubble128(
        decryptedXrPay,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedXrPayMessage = await defaultSigner.signMessage(xrPayMessageBytes);

      // Re-encrypt qPay
      const { encryptedHigh: qPayHigh, encryptedLow: qPayLow, messageBytes: qPayMessageBytes } = prepareMessageForBubble256(
        decryptedQPay,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQPayMessage = await defaultSigner.signMessage(qPayMessageBytes);

      const xrRemainderIT = {
        userAddress: userAddress,
        ciphertext: xrRemainderEncrypted,
        signature: signedXrRemainderMessage
      };
      const qRemainderIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qRemainderHigh,
          ciphertextLow: qRemainderLow
        },
        signature: signedQRemainderMessage
      };
      const xrPayIT = {
        userAddress: userAddress,
        ciphertext: xrPayEncrypted,
        signature: signedXrPayMessage
      };
      const qPayIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qPayHigh,
          ciphertextLow: qPayLow
        },
        signature: signedQPayMessage
      };

      const yRemainderClear = decryptedYRemainder;
      const yPayClear = decryptedYPay;
      
      // Merge the OPRF token
      const mergeTx = await privateToken.mergeToken(
        xrRemainderIT,
        qRemainderIT,
        yRemainderClear,
        xrPayIT,
        qPayIT,
        yPayClear
      );
      const mergeReceipt = await mergeTx.wait();
      expect(mergeReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get the merge event
      const mergeEvent = mergeReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMerged";
        } catch {
          return false;
        }
      });

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
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Decrypt the merged values
        const decryptedXrMerged = await decryptValueViaProxy(xrMergedHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedQMerged = await decryptValueViaProxy(qMergedHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedYMerged = await decryptValueViaProxy(yMergedHandle, defaultSigner, userAesKey, PROXY_URL);

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
      await mockToken.transfer(userAddress, additionalShieldAmount);
      await mockToken.approve(await privateToken.getAddress(), additionalShieldAmount);
      await privateToken.shield(additionalShieldAmount);
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for MPC computation

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
      const { encryptedHigh: qtyHigh, encryptedLow: qtyLow, messageBytes: qtyMessageBytes } = prepareMessageForBubble256(
        quantity,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQtyMessage = await defaultSigner.signMessage(qtyMessageBytes);

      const quantityIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qtyHigh,
          ciphertextLow: qtyLow
        },
        signature: signedQtyMessage
      };

      // Mint OPRF token
      const mintTx = await privateToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get the minted values from the event
      const mintEvent = mintReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMinted";
        } catch {
          return false;
        }
      });

      expect(mintEvent).to.not.be.undefined;
      const mintDecoded = privateToken.interface.parseLog(mintEvent!);
      const xHandle = mintDecoded?.args[1];
      const yHandle = mintDecoded?.args[2];
      const qHandle = mintDecoded?.args[3];

      // Wait a bit for MPC computation to complete before decryption
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Decrypt X, Y, and Q values from minting
      const decryptedX = await decryptValueViaProxy(xHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedY = await decryptValueViaProxy(yHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedQ = await decryptValueViaProxy(qHandle, defaultSigner, userAesKey, PROXY_URL);

      // Set yClear to the decrypted Y value for splitting
      if (decryptedY > BigInt(2**128 - 1)) {
        throw new Error(`Y value ${decryptedY} is too large for uint128`);
      }
      const yClear = decryptedY;

      // Re-encrypt the decrypted X value for splitting
      if (decryptedX > BigInt(2**128 - 1)) {
        throw new Error(`X value ${decryptedX} is too large for uint128`);
      }
      
      const { encryptedInt: xEncrypted, messageBytes: xMessageBytes } = prepareMessageForBubble128(
        decryptedX,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedXMessage = await defaultSigner.signMessage(xMessageBytes);

      // Re-encrypt the decrypted Q value for splitting
      const { encryptedHigh: qHigh, encryptedLow: qLow, messageBytes: qMessageBytes } = prepareMessageForBubble256(
        decryptedQ,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQMessage = await defaultSigner.signMessage(qMessageBytes);

      const { encryptedHigh: qSplitHigh, encryptedLow: qSplitLow, messageBytes: qSplitMessageBytes } = prepareMessageForBubble256(
        qSplit,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQSplitMessage = await defaultSigner.signMessage(qSplitMessageBytes);

      const xIT = {
        userAddress: userAddress,
        ciphertext: xEncrypted,
        signature: signedXMessage
      };
      const qIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qHigh,
          ciphertextLow: qLow
        },
        signature: signedQMessage
      };
      const qSplitIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qSplitHigh,
          ciphertextLow: qSplitLow
        },
        signature: signedQSplitMessage
      };

      // Create temp wallet for anonymous split (matches frontend behavior)
      const tempWallet = Wallet.createRandom().connect(hre.ethers.provider);
      const tempAddress = await tempWallet.getAddress();
      const fundTempTx = await defaultSigner.sendTransaction({
        to: tempAddress,
        value: hre.ethers.parseEther("0.01")
      });
      await fundTempTx.wait();
      
      const tempAesKey = await getUserKeyViaProxy(tempWallet as any, PROXY_URL);

      // Split the OPRF token for the recipient
      const splitTx = await privateToken.connect(tempWallet).splitTokenForRecipient(
        xIT,
        qIT,
        yClear,
        qSplitIT,
        recipientAddress
      );
      const splitReceipt = await splitTx.wait();
      expect(splitReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get the split event
      const splitEvent = splitReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFSplitForRecipient";
        } catch {
          return false;
        }
      });

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
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Decrypt the remainder values (should be decryptable by original user)
        const decryptedXrRemainder = await decryptValueViaProxy(xrRemainderHandle, tempWallet, tempAesKey, PROXY_URL);
        const decryptedQRemainder = await decryptValueViaProxy(qRemainderHandle, tempWallet, tempAesKey, PROXY_URL);
        const decryptedYRemainder = await decryptValueViaProxy(yRemainderHandle, tempWallet, tempAesKey, PROXY_URL);

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

        // Decrypt the payment values (should be decryptable by recipient)
        const decryptedXrPay = await decryptValueViaProxy(xrPayHandle, recipientWallet, recipientAesKey, PROXY_URL);
        const decryptedQPay = await decryptValueViaProxy(qPayHandle, recipientWallet, recipientAesKey, PROXY_URL);
        const decryptedYPay = await decryptValueViaProxy(yPayHandle, recipientWallet, recipientAesKey, PROXY_URL);

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
      await mockToken.transfer(userAddress, additionalShieldAmount);
      await mockToken.approve(await privateToken.getAddress(), additionalShieldAmount);
      await privateToken.shield(additionalShieldAmount);
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for MPC computation

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
      const { encryptedHigh: qtyHigh, encryptedLow: qtyLow, messageBytes: qtyMessageBytes } = prepareMessageForBubble256(
        quantity,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQtyMessage = await defaultSigner.signMessage(qtyMessageBytes);

      const quantityIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qtyHigh,
          ciphertextLow: qtyLow
        },
        signature: signedQtyMessage
      };

      const mintTx = await privateToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get minted values
      const mintEvent = mintReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMinted";
        } catch {
          return false;
        }
      });
      const mintDecoded = privateToken.interface.parseLog(mintEvent!);
      const xHandle = mintDecoded?.args[1];
      const yHandle = mintDecoded?.args[2];
      const qHandle = mintDecoded?.args[3];

      await new Promise(resolve => setTimeout(resolve, 2000));

      // Decrypt minted values
      const decryptedX = await decryptValueViaProxy(xHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedY = await decryptValueViaProxy(yHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedQ = await decryptValueViaProxy(qHandle, defaultSigner, userAesKey, PROXY_URL);
      
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

      const { encryptedInt: xEncrypted, messageBytes: xMessageBytes } = prepareMessageForBubble128(
        decryptedX,
        tempAddress, // Temp account address (frontend behavior)
        tempAesKeyHex, // Temp account's key
        await privateToken.getAddress()
      );
      // But sign with temp account (this is what frontend does)
      const signedXMessage = await tempWallet.signMessage(xMessageBytes);

      const { encryptedHigh: qHigh, encryptedLow: qLow, messageBytes: qMessageBytes } = prepareMessageForBubble256(
        decryptedQ,
        tempAddress, // Temp account address
        tempAesKeyHex, // Temp account's key
        await privateToken.getAddress()
      );
      const signedQMessage = await tempWallet.signMessage(qMessageBytes);

      const { encryptedHigh: qSplitHigh, encryptedLow: qSplitLow, messageBytes: qSplitMessageBytes } = prepareMessageForBubble256(
        qSplit,
        tempAddress, // Temp account address
        tempAesKeyHex, // Temp account's key
        await privateToken.getAddress()
      );
      const signedQSplitMessage = await tempWallet.signMessage(qSplitMessageBytes);

      const xIT = {
        userAddress: tempAddress,
        ciphertext: xEncrypted,
        signature: signedXMessage
      };
      const qIT = {
        userAddress: tempAddress,
        ciphertext: {
          ciphertextHigh: qHigh,
          ciphertextLow: qLow
        },
        signature: signedQMessage
      };
      const qSplitIT = {
        userAddress: tempAddress,
        ciphertext: {
          ciphertextHigh: qSplitHigh,
          ciphertextLow: qSplitLow
        },
        signature: signedQSplitMessage
      };

      const splitTx = await privateToken.connect(tempWallet).splitTokenForRecipient(
        xIT,
        qIT,
        yClear,
        qSplitIT,
        recipientAddress
      );
      const splitReceipt = await splitTx.wait();
      expect(splitReceipt?.status).to.equal(1);
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get split values from OPRFMinted events (same approach as frontend)
      // The contract emits two OPRFMinted events: one for remainder (msg.sender) and one for payment (recipient)
      const oprfMintedEvents = splitReceipt?.logs.filter((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMinted";
        } catch {
          return false;
        }
      }).map((log: any) => {
        const decoded = privateToken.interface.parseLog(log);
        return {
          user: decoded?.args[0],
          x: decoded?.args[1],
          y: decoded?.args[2],
          q: decoded?.args[3]
        };
      });

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

      await new Promise(resolve => setTimeout(resolve, 2000));

      // Decrypt remainder values
      const decryptedXrRemainder = await decryptValueViaProxy(xrRemainderHandle, tempWallet, tempAesKey, PROXY_URL);
      const decryptedQRemainder = await decryptValueViaProxy(qRemainderHandle, tempWallet, tempAesKey, PROXY_URL);
      const decryptedYRemainder = await decryptValueViaProxy(yRemainderHandle, tempWallet, tempAesKey, PROXY_URL);

      // Get recipient's AES key
      const recipientAesKey = await getUserKeyViaProxy(recipientWallet as any, PROXY_URL);

      // Decrypt recipient's values
      const decryptedXrPay = await decryptValueViaProxy(xrPayHandle, recipientWallet, recipientAesKey, PROXY_URL);
      const decryptedQPay = await decryptValueViaProxy(qPayHandle, recipientWallet, recipientAesKey, PROXY_URL);
      const decryptedYPay = await decryptValueViaProxy(yPayHandle, recipientWallet, recipientAesKey, PROXY_URL);

      // Step 3: Recipient burns their OPRF token portion
      // No key needed - contract manages it internally
      const { encryptedInt: recipientXEncrypted, messageBytes: recipientXMessageBytes } = prepareMessageForBubble128(
        decryptedXrPay, // Use the xrPay from the split
        recipientAddress,
        recipientAesKey.toString("hex"), // Recipient encrypts with their own AES key
        await privateToken.getAddress()
      );
      const signedRecipientXMessage = await recipientWallet.signMessage(recipientXMessageBytes);

      const { encryptedHigh: recipientQHigh, encryptedLow: recipientQLow, messageBytes: recipientQMessageBytes } = prepareMessageForBubble256(
        decryptedQPay, // Use the qPay from the split
        recipientAddress,
        recipientAesKey.toString("hex"), // Recipient encrypts with their own AES key
        await privateToken.getAddress()
      );
      const signedRecipientQMessage = await recipientWallet.signMessage(recipientQMessageBytes);

      const recipientXIT = {
        userAddress: recipientAddress,
        ciphertext: recipientXEncrypted,
        signature: signedRecipientXMessage
      };
      const recipientQIT = {
        userAddress: recipientAddress,
        ciphertext: {
          ciphertextHigh: recipientQHigh,
          ciphertextLow: recipientQLow
        },
        signature: signedRecipientQMessage
      };

      // Step 3: Burn the split OPRF token and transfer tokens to recipient
      const burnTx = await privateToken.connect(recipientWallet).burnToken(
        recipientXIT,
        recipientQIT,
        decryptedYPay, // Use the yPay from the split
        recipientAddress // Recipient to receive the tokens
      );
      const burnReceipt = await burnTx.wait();
      expect(burnReceipt?.status).to.equal(1);
      
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Verify the burn event (now includes recipient)
      const burnEvent = burnReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFBurned";
        } catch {
          return false;
        }
      });
      expect(burnEvent).to.not.be.undefined;

      const burnDecoded = privateToken.interface.parseLog(burnEvent!);
      const burnedUser = burnDecoded?.args[0];
      const burnedRecipient = burnDecoded?.args[1];
      const burnedAmountHandle = burnDecoded?.args[2];

      expect(burnedUser).to.equal(recipientAddress);
      expect(burnedRecipient).to.equal(recipientAddress);

      await new Promise(resolve => setTimeout(resolve, 2000));
      const decryptedBurnedAmount = await decryptValueViaProxy(burnedAmountHandle, recipientWallet, recipientAesKey, PROXY_URL);

      // Verify quantities are preserved
      expect(decryptedQRemainder + decryptedQPay).to.equal(quantity);
      expect(decryptedQPay).to.equal(qSplit);
      expect(decryptedQRemainder).to.equal(quantity - qSplit);
      
      expect(decryptedBurnedAmount).to.equal(decryptedQPay);
      
      // Verify recipient received the tokens by checking their balance
      const recipientBalanceHandle = await privateToken["balanceOf(address)"](recipientAddress);
      await new Promise(resolve => setTimeout(resolve, 2000));
      const recipientBalanceDecrypted = await decryptValueViaProxy(recipientBalanceHandle, recipientWallet, recipientAesKey, PROXY_URL);
      expect(recipientBalanceDecrypted).to.be.greaterThan(0n);
    });

    it("Should successfully withdraw private ERC20 tokens from contract", async function () {

      // Ensure user has enough private ERC20 balance for this test
      const additionalShieldAmount = hre.ethers.parseEther("50"); // Shield additional 50 tokens
      await mockToken.transfer(userAddress, additionalShieldAmount);
      await mockToken.approve(await privateToken.getAddress(), additionalShieldAmount);
      await privateToken.shield(additionalShieldAmount);
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for MPC computation

      // Create a recipient wallet
      const recipientWallet = Wallet.createRandom().connect(hre.ethers.provider);
      const recipientAddress = await recipientWallet.getAddress();
      
      // Fund the recipient wallet with ETH for gas
      const fundTx = await defaultSigner.sendTransaction({
        to: recipientAddress,
        value: hre.ethers.parseEther("0.01") // 0.01 ETH for gas
      });
      await fundTx.wait();

      const withdrawAmount = 30n; // Amount to withdraw

      // Prepare encrypted amount parameter
      const { encryptedHigh: amountHigh, encryptedLow: amountLow, messageBytes: amountMessageBytes } = prepareMessageForBubble256(
        withdrawAmount,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedAmountMessage = await defaultSigner.signMessage(amountMessageBytes);

      const amountIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: amountHigh,
          ciphertextLow: amountLow
        },
        signature: signedAmountMessage
      };

      // Check balances before withdrawal
      const contractBalanceBefore = await privateToken["balanceOf(address)"](await privateToken.getAddress());
      const recipientBalanceBefore = await privateToken["balanceOf(address)"](recipientAddress);
      // Withdraw private ERC20 tokens from contract to recipient
      const withdrawTx = await privateToken.withdrawPrivateTokens(
        amountIT,
        recipientAddress
      );
      const withdrawReceipt = await withdrawTx.wait();
      expect(withdrawReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Verify the withdrawal event
      const withdrawalEvent = withdrawReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "PrivateTokensWithdrawn";
        } catch {
          return false;
        }
      });
      expect(withdrawalEvent).to.not.be.undefined;

      if (withdrawalEvent) {
        const withdrawalDecoded = privateToken.interface.parseLog(withdrawalEvent);
        const withdrawnUser = withdrawalDecoded?.args[0];
        const withdrawnRecipient = withdrawalDecoded?.args[1];
        const withdrawnAmountHandle = withdrawalDecoded?.args[2];

        expect(withdrawnUser).to.equal(userAddress);
        expect(withdrawnRecipient).to.equal(recipientAddress);

        // Wait a bit more for MPC computation to complete before decryption
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Decrypt the withdrawn amount
        const decryptedWithdrawnAmount = await decryptValueViaProxy(withdrawnAmountHandle, defaultSigner, userAesKey, PROXY_URL);
        expect(decryptedWithdrawnAmount).to.equal(withdrawAmount);
      }
    });

    it("Should successfully burn OPRF token and verify burned amount equals quantity", async function () {

      // Ensure user has enough private ERC20 balance for this test
      const additionalShieldAmount = hre.ethers.parseEther("50"); // Shield additional 50 tokens
      await mockToken.transfer(userAddress, additionalShieldAmount);
      await mockToken.approve(await privateToken.getAddress(), additionalShieldAmount);
      await privateToken.shield(additionalShieldAmount);
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for MPC computation

      const quantity = 30n;
      
      // Mint an OPRF token (no approval needed since mintOPRFToken uses direct transfer)
      const { encryptedHigh: qtyHigh, encryptedLow: qtyLow, messageBytes: qtyMessageBytes } = prepareMessageForBubble256(
        quantity,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQtyMessage = await defaultSigner.signMessage(qtyMessageBytes);

      const quantityIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qtyHigh,
          ciphertextLow: qtyLow
        },
        signature: signedQtyMessage
      };

      // Mint OPRF token
      const mintTx = await privateToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get the minted values from the event
      const mintEvent = mintReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMinted";
        } catch {
          return false;
        }
      });

      expect(mintEvent).to.not.be.undefined;
      const mintDecoded = privateToken.interface.parseLog(mintEvent!);
      const xHandle = mintDecoded?.args[1];
      const yHandle = mintDecoded?.args[2];
      const qHandle = mintDecoded?.args[3];

      // Wait a bit for MPC computation to complete before decryption
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Decrypt X, Y, and Q values from minting
      const decryptedX = await decryptValueViaProxy(xHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedY = await decryptValueViaProxy(yHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedQ = await decryptValueViaProxy(qHandle, defaultSigner, userAesKey, PROXY_URL);

      // Set yClear to the decrypted Y value for burning
      if (decryptedY > BigInt(2**128 - 1)) {
        throw new Error(`Y value ${decryptedY} is too large for uint128`);
      }
      const yClear = decryptedY;

      // Re-encrypt the decrypted X value for burning
      if (decryptedX > BigInt(2**128 - 1)) {
        throw new Error(`X value ${decryptedX} is too large for uint128`);
      }
      
      const { encryptedInt: xEncrypted, messageBytes: xMessageBytes } = prepareMessageForBubble128(
        decryptedX,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedXMessage = await defaultSigner.signMessage(xMessageBytes);

      // Re-encrypt the decrypted Q value for burning
      const { encryptedHigh: qHigh, encryptedLow: qLow, messageBytes: qMessageBytes } = prepareMessageForBubble256(
        decryptedQ,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQMessage = await defaultSigner.signMessage(qMessageBytes);

      const xIT = {
        userAddress: userAddress,
        ciphertext: xEncrypted,
        signature: signedXMessage
      };
      const qIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qHigh,
          ciphertextLow: qLow
        },
        signature: signedQMessage
      };

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
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get the burn event
      const burnEvent = burnReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFBurned";
        } catch {
          return false;
        }
      });

      expect(burnEvent).to.not.be.undefined;

      if (burnEvent) {
        const burnDecoded = privateToken.interface.parseLog(burnEvent);
        const burnedAmountHandle = burnDecoded?.args[2];

        expect(burnedAmountHandle).to.not.be.undefined;

        // Wait a bit more for MPC computation to complete before decryption
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Decrypt the burned amount (zero handle cannot be decrypted via proxy; treat as 0n)
        const decryptedBurnedAmount =
          burnedAmountHandle === 0n
            ? 0n
            : await decryptValueViaProxy(burnedAmountHandle, defaultSigner, userAesKey, PROXY_URL);
        console.log(`   ✅ Decrypted burned amount: ${decryptedBurnedAmount}`);
        expect(decryptedBurnedAmount).to.not.be.undefined;
        expect(decryptedBurnedAmount).to.equal(quantity);
      }
    });

    it("Should successfully merge many OPRF tokens into a single token", async function () {
      // Increase timeout for this test since it processes multiple tokens
      this.timeout(120000); // 120 seconds
      

      // Ensure user has enough private ERC20 balance for this test
      const additionalShieldAmount = hre.ethers.parseEther("150"); // Shield additional 150 tokens for 3 tokens
      await mockToken.transfer(userAddress, additionalShieldAmount);
      await mockToken.approve(await privateToken.getAddress(), additionalShieldAmount);
      await privateToken.shield(additionalShieldAmount);
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for MPC computation

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
        
        const { encryptedHigh: qtyHigh, encryptedLow: qtyLow, messageBytes: qtyMessageBytes } = prepareMessageForBubble256(
          quantity,
          userAddress,
          userAesKeyHex,
          await privateToken.getAddress()
        );
        const signedQtyMessage = await defaultSigner.signMessage(qtyMessageBytes);

        const quantityIT = {
          userAddress: userAddress,
          ciphertext: {
            ciphertextHigh: qtyHigh,
            ciphertextLow: qtyLow
          },
          signature: signedQtyMessage
        };

        // Mint OPRF token
        const mintTx = await privateToken.mintOPRFToken(quantityIT);
        const mintReceipt = await mintTx.wait();
        expect(mintReceipt?.status).to.equal(1);

        // Wait for MPC computation to complete
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Get the minted values from the event
        const mintEvent = mintReceipt?.logs.find((log: any) => {
          try {
            const decoded = privateToken.interface.parseLog(log);
            return decoded?.name === "OPRFMinted";
          } catch {
            return false;
          }
        });

        expect(mintEvent).to.not.be.undefined;
        const mintDecoded = privateToken.interface.parseLog(mintEvent!);
        const xHandle = mintDecoded?.args[1];
        const yHandle = mintDecoded?.args[2];
        const qHandle = mintDecoded?.args[3];

        // Wait a bit for MPC computation to complete before decryption
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Decrypt X, Y, and Q values from minting
        const decryptedX = await decryptValueViaProxy(xHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedY = await decryptValueViaProxy(yHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedQ = await decryptValueViaProxy(qHandle, defaultSigner, userAesKey, PROXY_URL);

        // Verify Y value fits in uint128
        if (decryptedY > BigInt(2**128 - 1)) {
          throw new Error(`Y value ${decryptedY} is too large for uint128`);
        }

        // Verify X value fits in uint128
        if (decryptedX > BigInt(2**128 - 1)) {
          throw new Error(`X value ${decryptedX} is too large for uint128`);
        }

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
          // Re-encrypt x (itUint128)
          const { encryptedInt: xEncrypted, messageBytes: xMessageBytes } = prepareMessageForBubble128(
            token.x,
            userAddress,
            userAesKeyHex,
            await privateToken.getAddress()
          );
          const signedXMessage = await defaultSigner.signMessage(xMessageBytes);

          // Re-encrypt q (itUint256)
          const { encryptedHigh: qHigh, encryptedLow: qLow, messageBytes: qMessageBytes } = prepareMessageForBubble256(
            token.q,
            userAddress,
            userAesKeyHex,
            await privateToken.getAddress()
          );
          const signedQMessage = await defaultSigner.signMessage(qMessageBytes);

          return {
            x: {
              ciphertext: xEncrypted,
              signature: signedXMessage
            },
            q: {
              ciphertext: {
                ciphertextHigh: qHigh,
                ciphertextLow: qLow
              },
              signature: signedQMessage
            },
            y_clear: token.y // y_clear is already a uint128
          };
        })
      );

      // Call mergeMany
      const mergeManyTx = await privateToken.mergeMany(tokensToMerge);
      const mergeManyReceipt = await mergeManyTx.wait();
      expect(mergeManyReceipt?.status).to.equal(1);

      // Wait longer for MPC computation to complete (mergeMany processes multiple tokens)
      await new Promise(resolve => setTimeout(resolve, 15000));

      // Get the merge event
      const mergeEvent = mergeManyReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMerged";
        } catch {
          return false;
        }
      });

      expect(mergeEvent).to.not.be.undefined;

      // Also check for OPRFMinted event (the merged token)
      const mintedEvent = mergeManyReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMinted";
          // Make sure it's the one from mergeMany, not from earlier mints
        } catch {
          return false;
        }
      });

      expect(mintedEvent).to.not.be.undefined;

      if (mintedEvent) {
        const mintedDecoded = privateToken.interface.parseLog(mintedEvent);
        const xMergedHandle = mintedDecoded?.args[1];
        const yMergedHandle = mintedDecoded?.args[2];
        const qMergedHandle = mintedDecoded?.args[3];

        expect(xMergedHandle).to.not.be.undefined;
        expect(yMergedHandle).to.not.be.undefined;
        expect(qMergedHandle).to.not.be.undefined;

        // Wait longer for MPC computation to complete before decryption
        await new Promise(resolve => setTimeout(resolve, 10000));

        // Decrypt the merged values
        const decryptedXMerged = await decryptValueViaProxy(xMergedHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedYMerged = await decryptValueViaProxy(yMergedHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedQMerged = await decryptValueViaProxy(qMergedHandle, defaultSigner, userAesKey, PROXY_URL);

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

        console.log("✅ MergeMany successful!");
        console.log(`   Merged ${mintedTokens.length} tokens into 1 token`);
        console.log(`   Total quantity preserved: ${decryptedQMerged.toString()}`);
      }
    });

    it("Should detect double-spend vulnerability: passing same token twice to mergeMany", async function () {
      // Increase timeout for this test since it processes multiple tokens
      this.timeout(120000); // 120 seconds

      // Ensure user has enough private ERC20 balance for this test
      const additionalShieldAmount = hre.ethers.parseEther("100"); // Shield additional 100 tokens
      await mockToken.transfer(userAddress, additionalShieldAmount);
      await mockToken.approve(await privateToken.getAddress(), additionalShieldAmount);
      await privateToken.shield(additionalShieldAmount);
      await new Promise(resolve => setTimeout(resolve, 3000)); // Wait for MPC computation

      // Mint a single OPRF token
      const quantity = 50n;
      
      const { encryptedHigh: qtyHigh, encryptedLow: qtyLow, messageBytes: qtyMessageBytes } = prepareMessageForBubble256(
        quantity,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQtyMessage = await defaultSigner.signMessage(qtyMessageBytes);

      const quantityIT = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: qtyHigh,
          ciphertextLow: qtyLow
        },
        signature: signedQtyMessage
      };

      // Mint OPRF token
      const mintTx = await privateToken.mintOPRFToken(quantityIT);
      const mintReceipt = await mintTx.wait();
      expect(mintReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get the minted values from the event
      const mintEvent = mintReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMinted";
        } catch {
          return false;
        }
      });

      expect(mintEvent).to.not.be.undefined;
      const mintDecoded = privateToken.interface.parseLog(mintEvent!);
      const xHandle = mintDecoded?.args[1];
      const yHandle = mintDecoded?.args[2];
      const qHandle = mintDecoded?.args[3];

      // Wait a bit for MPC computation to complete before decryption
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Decrypt X, Y, and Q values from minting
      const decryptedX = await decryptValueViaProxy(xHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedY = await decryptValueViaProxy(yHandle, defaultSigner, userAesKey, PROXY_URL);
      const decryptedQ = await decryptValueViaProxy(qHandle, defaultSigner, userAesKey, PROXY_URL);

      // Verify Y value fits in uint128
      if (decryptedY > BigInt(2**128 - 1)) {
        throw new Error(`Y value ${decryptedY} is too large for uint128`);
      }

      // Verify X value fits in uint128
      if (decryptedX > BigInt(2**128 - 1)) {
        throw new Error(`X value ${decryptedX} is too large for uint128`);
      }

      console.log(`\n=== Minted Single OPRF Token ===`);
      console.log(`X: ${decryptedX.toString()}`);
      console.log(`Q: ${decryptedQ.toString()}`);
      console.log(`Y: ${decryptedY.toString()}`);
      console.log(`Expected merged quantity: ${decryptedQ.toString()}`);
      console.log("==================================\n");

      // Prepare the token for mergeMany - re-encrypt x and q
      const { encryptedInt: xEncrypted, messageBytes: xMessageBytes } = prepareMessageForBubble128(
        decryptedX,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedXMessage = await defaultSigner.signMessage(xMessageBytes);

      const { encryptedHigh: qHigh, encryptedLow: qLow, messageBytes: qMessageBytes } = prepareMessageForBubble256(
        decryptedQ,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedQMessage = await defaultSigner.signMessage(qMessageBytes);

      const tokenToMerge = {
        x: {
          ciphertext: xEncrypted,
          signature: signedXMessage
        },
        q: {
          ciphertext: {
            ciphertextHigh: qHigh,
            ciphertextLow: qLow
          },
          signature: signedQMessage
        },
        y_clear: decryptedY
      };

      // ATTEMPT DOUBLE-SPEND: Pass the same token twice to mergeMany
      const tokensToMerge = [tokenToMerge, tokenToMerge]; // Same token twice!

      // Call mergeMany with duplicate tokens
      const mergeManyTx = await privateToken.mergeMany(tokensToMerge);
      const mergeManyReceipt = await mergeManyTx.wait();
      expect(mergeManyReceipt?.status).to.equal(1);

      // Wait longer for MPC computation to complete
      await new Promise(resolve => setTimeout(resolve, 15000));

      // Get the merge event
      const mergeEvent = mergeManyReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMerged";
        } catch {
          return false;
        }
      });

      expect(mergeEvent).to.not.be.undefined;

      // Also check for OPRFMinted event (the merged token)
      const mintedEvent = mergeManyReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMinted";
        } catch {
          return false;
        }
      });

      expect(mintedEvent).to.not.be.undefined;

      if (mintedEvent) {
        const mintedDecoded = privateToken.interface.parseLog(mintedEvent);
        const xMergedHandle = mintedDecoded?.args[1];
        const yMergedHandle = mintedDecoded?.args[2];
        const qMergedHandle = mintedDecoded?.args[3];

        expect(xMergedHandle).to.not.be.undefined;
        expect(yMergedHandle).to.not.be.undefined;
        expect(qMergedHandle).to.not.be.undefined;

        // Wait longer for MPC computation to complete before decryption
        await new Promise(resolve => setTimeout(resolve, 10000));

        // Decrypt the merged values
        const decryptedXMerged = await decryptValueViaProxy(xMergedHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedYMerged = await decryptValueViaProxy(yMergedHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedQMerged = await decryptValueViaProxy(qMergedHandle, defaultSigner, userAesKey, PROXY_URL);

        // Verify the merged values are non-zero
        expect(decryptedXMerged).to.not.equal(0n);
        expect(decryptedYMerged).to.not.equal(0n);
        expect(decryptedQMerged).to.not.equal(0n);

        // This test documents the vulnerability - it should fail if the bug is fixed
        // For now, we're documenting that the same token can be burned twice
        expect(decryptedQMerged).to.equal(decryptedQ * 2n, "BUG CONFIRMED: Same token was burned twice, resulting in double amount");
      }
    });

    it.only("Should successfully transfer OPRF tokens to recipient with sufficient balance", async function () {
      this.timeout(300000); // 300 seconds (5 minutes) - MPC operations take time
      


      // ========== Setup: Prepare balances and recipient ==========
      const additionalShieldAmount = hre.ethers.parseEther("150");
      await mockToken.transfer(userAddress, additionalShieldAmount);
      await mockToken.approve(await privateToken.getAddress(), additionalShieldAmount);
      await privateToken.shield(additionalShieldAmount);
      await new Promise(resolve => setTimeout(resolve, 3000));

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
        
        const { encryptedHigh: qtyHigh, encryptedLow: qtyLow } = prepareMessageForBubble256(
          quantity,
          userAddress,
          userAesKeyHex,
          await privateToken.getAddress()
        );

        const quantityIT = {
          userAddress: userAddress,
          ciphertext: {
            ciphertextHigh: qtyHigh,
            ciphertextLow: qtyLow
          }
        };

        // Mint OPRF token
        const mintTx = await privateToken.mintOPRFToken(quantityIT);
        const mintReceipt = await mintTx.wait();
        expect(mintReceipt?.status).to.equal(1);

        // Wait for MPC computation to complete
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Get the minted values from the event
        const mintEvent = mintReceipt?.logs.find((log: any) => {
          try {
            const decoded = privateToken.interface.parseLog(log);
            return decoded?.name === "OPRFMinted";
          } catch {
            return false;
          }
        });

        expect(mintEvent).to.not.be.undefined;
        const mintDecoded = privateToken.interface.parseLog(mintEvent!);
        const xHandle = mintDecoded?.args[1];
        const yHandle = mintDecoded?.args[2];
        const qHandle = mintDecoded?.args[3];

        // Wait a bit for MPC computation to complete before decryption
        await new Promise(resolve => setTimeout(resolve, 2000));

        // Decrypt X, Y, and Q values from minting
        const decryptedX = await decryptValueViaProxy(xHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedY = await decryptValueViaProxy(yHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedQ = await decryptValueViaProxy(qHandle, defaultSigner, userAesKey, PROXY_URL);

        // Verify Y value fits in uint128
        if (decryptedY > BigInt(2**128 - 1)) {
          throw new Error(`Y value ${decryptedY} is too large for uint128`);
        }

        // Verify X value fits in uint128
        if (decryptedX > BigInt(2**128 - 1)) {
          throw new Error(`X value ${decryptedX} is too large for uint128`);
        }

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
          const { encryptedInt: xEncrypted } = prepareMessageForBubble128(
            token.x,
            userAddress,
            userAesKeyHex,
            await privateToken.getAddress()
          );

          // Re-encrypt q (itUint256)
          const { encryptedHigh: qHigh, encryptedLow: qLow } = prepareMessageForBubble256(
            token.q,
            userAddress,
            userAesKeyHex,
            await privateToken.getAddress()
          );

          return {
            x: {
              userAddress: userAddress,
              ciphertext: xEncrypted
            },
            q: {
              userAddress: userAddress,
              ciphertext: {
                ciphertextHigh: qHigh,
                ciphertextLow: qLow
              }
            },
            y_clear: token.y
          };
        })
      );

      // Prepare encrypted transfer amount
      const { encryptedHigh: amountHigh, encryptedLow: amountLow } = prepareMessageForBubble256(
        transferAmount,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );

      const encryptedTransferAmount = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: amountHigh,
          ciphertextLow: amountLow
        }
      };

      // Execute transferOPRF
      const transferTx = await privateToken.transferOPRF(
        tokensToTransfer,
        encryptedTransferAmount,
        recipientAddress
      );
      const transferReceipt = await transferTx.wait();
      expect(transferReceipt?.status).to.equal(1);

      // Wait for MPC computation to complete
      await new Promise(resolve => setTimeout(resolve, 30000));

      // Extract OPRFMinted events
      const oprfMintedEvents = transferReceipt?.logs.filter((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMinted";
        } catch {
          return false;
        }
      }).map((log: any) => {
        const decoded = privateToken.interface.parseLog(log);
        return {
          user: decoded?.args[0],
          x: decoded?.args[1],
          y: decoded?.args[2],
          q: decoded?.args[3]
        };
      });

      expect(oprfMintedEvents.length).to.equal(2);
      
      const recipientEvent = oprfMintedEvents.find((e: any) => 
        e.user.toLowerCase() === recipientAddress.toLowerCase()
      );
      const senderEvent = oprfMintedEvents.find((e: any) => 
        e.user.toLowerCase() === userAddress.toLowerCase()
      );

      expect(recipientEvent).to.not.be.undefined;
      expect(senderEvent).to.not.be.undefined;

      // Verify OPRFTransferred event and decrypt transferred amount by both parties
      const transferEvent = transferReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFTransferred";
        } catch {
          return false;
        }
      });

      expect(transferEvent).to.not.be.undefined;

      if (transferEvent) {
        const transferDecoded = privateToken.interface.parseLog(transferEvent);
        const transferredUser = transferDecoded?.args[0];
        const transferredRecipient = transferDecoded?.args[1];
        const transferredAmountHandle = transferDecoded?.args[2];

        expect(transferredUser.toLowerCase()).to.equal(userAddress.toLowerCase());
        expect(transferredRecipient.toLowerCase()).to.equal(recipientAddress.toLowerCase());

        // Give MPC computation a bit more time before decrypting
        await new Promise(resolve => setTimeout(resolve, 5000));

        const decryptedAmountByRecipient = await decryptValueViaProxy(
          transferredAmountHandle,
          recipientWallet,
          recipientAesKey,
          PROXY_URL
        );
        const decryptedAmountBySender = await decryptValueViaProxy(
          transferredAmountHandle,
          defaultSigner,
          userAesKey,
          PROXY_URL
        );

        expect(decryptedAmountByRecipient).to.equal(
          transferAmount,
          "Recipient should decrypt transferred amount"
        );
        expect(decryptedAmountBySender).to.equal(
          transferAmount,
          "Sender should decrypt transferred amount"
        );
      }

      // Decrypt and verify results
      await new Promise(resolve => setTimeout(resolve, 20000));

      const recipientQ = await decryptValueViaProxy(recipientEvent.q, recipientWallet, recipientAesKey, PROXY_URL);
      const recipientX = await decryptValueViaProxy(recipientEvent.x, recipientWallet, recipientAesKey, PROXY_URL);
      const recipientY = await decryptValueViaProxy(recipientEvent.y, recipientWallet, recipientAesKey, PROXY_URL);

      const senderQ = await decryptValueViaProxy(senderEvent.q, defaultSigner, userAesKey, PROXY_URL);
      const senderX = await decryptValueViaProxy(senderEvent.x, defaultSigner, userAesKey, PROXY_URL);
      const senderY = await decryptValueViaProxy(senderEvent.y, defaultSigner, userAesKey, PROXY_URL);

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

      // Verify all input tokens were invalidated (burned)
      const invalidatedEvents = transferReceipt?.logs.filter((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFTokenInvalidated" && Number(decoded?.args[4]) === 3;
        } catch {
          return false;
        }
      });

      expect(invalidatedEvents.length).to.equal(mintedTokens.length, "All input tokens should be invalidated");
    });

    // Tests that transferOPRF correctly handles insufficient balance:
    // When transfer amount exceeds available tokens, recipient should get 0 and sender keeps all tokens
    it("transferOPRF with insufficient balance should return 0 to recipient", async function () {
      this.timeout(300000); // 5 minutes - MPC operations take time
      
      console.log("📋 Step 1: Setup - preparing balances and recipient...");
      const additionalShieldAmount = hre.ethers.parseEther("150");
      await mockToken.transfer(userAddress, additionalShieldAmount);
      await mockToken.approve(await privateToken.getAddress(), additionalShieldAmount);
      await privateToken.shield(additionalShieldAmount);
      await new Promise(resolve => setTimeout(resolve, 3000));

      const recipientWallet = Wallet.createRandom().connect(hre.ethers.provider);
      const recipientAddress = await recipientWallet.getAddress();
      
      await defaultSigner.sendTransaction({
        to: recipientAddress,
        value: hre.ethers.parseEther("0.01")
      }).then((tx: any) => tx.wait());

      const recipientAesKey = await getUserKeyViaProxy(recipientWallet as any, PROXY_URL);
      console.log("   ✅ Setup complete");

      console.log("📋 Step 2: Minting 3 OPRF tokens...");
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
        
        const { encryptedHigh: qtyHigh, encryptedLow: qtyLow } = prepareMessageForBubble256(
          quantity,
          userAddress,
          userAesKeyHex,
          await privateToken.getAddress()
        );

        const quantityIT = {
          userAddress: userAddress,
          ciphertext: {
            ciphertextHigh: qtyHigh,
            ciphertextLow: qtyLow
          }
        };

        const mintTx = await privateToken.mintOPRFToken(quantityIT);
        const mintReceipt = await mintTx.wait();
        expect(mintReceipt?.status).to.equal(1);

        await new Promise(resolve => setTimeout(resolve, 5000));

        const mintEvent = mintReceipt?.logs.find((log: any) => {
          try {
            const decoded = privateToken.interface.parseLog(log);
            return decoded?.name === "OPRFMinted";
          } catch {
            return false;
          }
        });

        expect(mintEvent).to.not.be.undefined;
        const mintDecoded = privateToken.interface.parseLog(mintEvent!);
        const xHandle = mintDecoded?.args[1];
        const yHandle = mintDecoded?.args[2];
        const qHandle = mintDecoded?.args[3];

        await new Promise(resolve => setTimeout(resolve, 2000));

        const decryptedX = await decryptValueViaProxy(xHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedY = await decryptValueViaProxy(yHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedQ = await decryptValueViaProxy(qHandle, defaultSigner, userAesKey, PROXY_URL);

        if (decryptedY > BigInt(2**128 - 1)) {
          throw new Error(`Y value ${decryptedY} is too large for uint128`);
        }
        if (decryptedX > BigInt(2**128 - 1)) {
          throw new Error(`X value ${decryptedX} is too large for uint128`);
        }

        mintedTokens.push({
          x: decryptedX,
          q: decryptedQ,
          y: decryptedY
        });
        console.log(`   ✅ Token ${i + 1} minted and decrypted`);
      }

      const totalQuantity = mintedTokens.reduce((sum, token) => sum + token.q, 0n);
      console.log(`   ✅ All tokens minted. Total: ${totalQuantity}`);

      console.log("📋 Step 3: Preparing tokens for transfer...");
      const tokensToTransfer = await Promise.all(
        mintedTokens.map(async (token) => {
          const { encryptedInt: xEncrypted } = prepareMessageForBubble128(
            token.x,
            userAddress,
            userAesKeyHex,
            await privateToken.getAddress()
          );

          const { encryptedHigh: qHigh, encryptedLow: qLow } = prepareMessageForBubble256(
            token.q,
            userAddress,
            userAesKeyHex,
            await privateToken.getAddress()
          );

          return {
            x: {
              userAddress: userAddress,
              ciphertext: xEncrypted
            },
            q: {
              userAddress: userAddress,
              ciphertext: {
                ciphertextHigh: qHigh,
                ciphertextLow: qLow
              }
            },
            y_clear: token.y
          };
        })
      );

      const { encryptedHigh: amountHigh, encryptedLow: amountLow } = prepareMessageForBubble256(
        transferAmount,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );

      const encryptedTransferAmount = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: amountHigh,
          ciphertextLow: amountLow
        }
      };
      console.log("   ✅ Tokens prepared");

      console.log("📋 Step 4: Executing transferOPRF (insufficient balance test)...");
      const transferTx = await privateToken.transferOPRF(
        tokensToTransfer,
        encryptedTransferAmount,
        recipientAddress
      );
      const transferReceipt = await transferTx.wait();
      expect(transferReceipt?.status).to.equal(1);
      console.log("   ✅ Transfer transaction confirmed");

      console.log("📋 Step 5: Waiting for MPC computation (15s)...");
      await new Promise(resolve => setTimeout(resolve, 15000));

      console.log("📋 Step 6: Extracting events...");
      const oprfMintedEvents = transferReceipt?.logs.filter((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMinted";
        } catch {
          return false;
        }
      }).map((log: any) => {
        const decoded = privateToken.interface.parseLog(log);
        return {
          user: decoded?.args[0],
          x: decoded?.args[1],
          y: decoded?.args[2],
          q: decoded?.args[3]
        };
      });

      expect(oprfMintedEvents.length).to.equal(2);
      
      const recipientEvent = oprfMintedEvents.find((e: any) => 
        e.user.toLowerCase() === recipientAddress.toLowerCase()
      );
      const senderEvent = oprfMintedEvents.find((e: any) => 
        e.user.toLowerCase() === userAddress.toLowerCase()
      );

      expect(recipientEvent).to.not.be.undefined;
      expect(senderEvent).to.not.be.undefined;
      console.log("   ✅ Events extracted");

      console.log("📋 Step 7: Decrypting results (waiting 10s then decrypting 6 values)...");
      await new Promise(resolve => setTimeout(resolve, 10000));

      const recipientQ = await decryptValueViaProxy(recipientEvent.q, recipientWallet, recipientAesKey, PROXY_URL);
      const recipientX = await decryptValueViaProxy(recipientEvent.x, recipientWallet, recipientAesKey, PROXY_URL);
      const recipientY = await decryptValueViaProxy(recipientEvent.y, recipientWallet, recipientAesKey, PROXY_URL);

      const senderQ = await decryptValueViaProxy(senderEvent.q, defaultSigner, userAesKey, PROXY_URL);
      const senderX = await decryptValueViaProxy(senderEvent.x, defaultSigner, userAesKey, PROXY_URL);
      const senderY = await decryptValueViaProxy(senderEvent.y, defaultSigner, userAesKey, PROXY_URL);
      console.log(`   ✅ Decryption complete. Recipient: ${recipientQ}, Sender: ${senderQ}`);

      // Also verify OPRFTransferred event and that both parties can decrypt the (zero) recipient amount
      const transferEvent = transferReceipt?.logs.find((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFTransferred";
        } catch {
          return false;
        }
      });

      expect(transferEvent).to.not.be.undefined;

      if (transferEvent) {
        const transferDecoded = privateToken.interface.parseLog(transferEvent);
        const transferredUser = transferDecoded?.args[0];
        const transferredRecipient = transferDecoded?.args[1];
        const transferredAmountHandle = transferDecoded?.args[2];

        expect(transferredUser.toLowerCase()).to.equal(userAddress.toLowerCase());
        expect(transferredRecipient.toLowerCase()).to.equal(recipientAddress.toLowerCase());

        // Wait a bit before decrypting the transferred amount
        await new Promise(resolve => setTimeout(resolve, 5000));

        const decryptedAmountByRecipient = await decryptValueViaProxy(
          transferredAmountHandle,
          recipientWallet,
          recipientAesKey,
          PROXY_URL
        );
        const decryptedAmountBySender = await decryptValueViaProxy(
          transferredAmountHandle,
          defaultSigner,
          userAesKey,
          PROXY_URL
        );

        expect(decryptedAmountByRecipient).to.equal(
          expectedRecipientAmount,
          "Recipient should decrypt transferred amount (0 on insufficient balance)"
        );
        expect(decryptedAmountBySender).to.equal(
          expectedRecipientAmount,
          "Sender should decrypt transferred amount (0 on insufficient balance)"
        );
      }

      console.log("📋 Step 8: Verifying results...");
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

      // CRITICAL ASSERTIONS FOR MUX LOGIC:
      // With CORRECT mux logic (if mux returns 3rd arg when bit is TRUE):
      //   - overflowBit = TRUE (because 120 - 150 overflows)
      //   - recipientAmount = mux(TRUE, amountToTransfer, $.zero) = $.zero = 0
      //   - senderAmount = mux(TRUE, remainder, totalBurned) = totalBurned = 120
      //
      // With WRONG mux logic (standard: returns 2nd arg when bit is TRUE):
      //   - recipientAmount = mux(TRUE, amountToTransfer, $.zero) = amountToTransfer = 150 (or garbage)
      //   - senderAmount = mux(TRUE, remainder, totalBurned) = remainder (garbage since overflow)
      
      expect(recipientQ).to.equal(
        expectedRecipientAmount, 
        `CRITICAL BUG: Recipient received ${recipientQ} but should receive 0 when balance is insufficient. ` +
        `This indicates the mux() logic is INVERTED. The contract uses mux(overflowBit, amountToTransfer, $.zero) ` +
        `but with standard mux semantics, when overflowBit=true, it returns the 2nd arg (amountToTransfer) instead of 3rd arg ($.zero).`
      );
      expect(senderQ).to.equal(
        expectedSenderAmount, 
        `CRITICAL BUG: Sender received ${senderQ} but should receive ${expectedSenderAmount} (all tokens back) when balance is insufficient. ` +
        `This indicates the mux() logic is INVERTED.`
      );
      expect(recipientQ + senderQ).to.equal(totalQuantity, "Total should be preserved");

      // Verify all input tokens were invalidated (burned)
      const invalidatedEvents = transferReceipt?.logs.filter((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFTokenInvalidated" && Number(decoded?.args[4]) === 3;
        } catch {
          return false;
        }
      });

      expect(invalidatedEvents.length).to.equal(mintedTokens.length, "All input tokens should be invalidated");
    });

    it("Should successfully redeem multiple OPRF tokens with sufficient balance", async function () {
      this.timeout(600000); // 600 seconds (10 minutes) - MPC operations take time

      console.log("\n[TEST] Starting redeemMany test...");
      
      // Setup: Prepare balances and recipient
      console.log("[TEST] Step 1: Setting up balances...");
      const additionalShieldAmount = hre.ethers.parseEther("150");
      const transferTx = await mockToken.transfer(userAddress, additionalShieldAmount);
      await transferTx.wait();
      console.log("[TEST] Step 1.1: Transferred mock tokens");
      
      const approveTx = await mockToken.approve(await privateToken.getAddress(), additionalShieldAmount);
      await approveTx.wait();
      console.log("[TEST] Step 1.2: Approved private token");
      
      const shieldTx = await privateToken.shield(additionalShieldAmount);
      await shieldTx.wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      console.log("[TEST] Step 1.3: Shielded tokens");

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
        
        const { encryptedHigh: qtyHigh, encryptedLow: qtyLow, messageBytes: qtyMessageBytes } = prepareMessageForBubble256(
          quantity,
          userAddress,
          userAesKeyHex,
          await privateToken.getAddress()
        );
        const signedQtyMessage = await defaultSigner.signMessage(qtyMessageBytes);

        const quantityIT = {
          userAddress: userAddress,
          ciphertext: {
            ciphertextHigh: qtyHigh,
            ciphertextLow: qtyLow
          },
          signature: signedQtyMessage
        };

        const mintTx = await privateToken.mintOPRFToken(quantityIT);
        const mintReceipt = await mintTx.wait();
        expect(mintReceipt?.status).to.equal(1);

        await new Promise(resolve => setTimeout(resolve, 10000));

        const mintEvent = mintReceipt?.logs.find((log: any) => {
          try {
            const decoded = privateToken.interface.parseLog(log);
            return decoded?.name === "OPRFMinted";
          } catch {
            return false;
          }
        });

        expect(mintEvent).to.not.be.undefined;
        const mintDecoded = privateToken.interface.parseLog(mintEvent!);
        const xHandle = mintDecoded?.args[1];
        const yHandle = mintDecoded?.args[2];
        const qHandle = mintDecoded?.args[3];

        await new Promise(resolve => setTimeout(resolve, 5000));

        const decryptedX = await decryptValueViaProxy(xHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedY = await decryptValueViaProxy(yHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedQ = await decryptValueViaProxy(qHandle, defaultSigner, userAesKey, PROXY_URL);

        if (decryptedY > BigInt(2**128 - 1)) {
          throw new Error(`Y value ${decryptedY} is too large for uint128`);
        }
        if (decryptedX > BigInt(2**128 - 1)) {
          throw new Error(`X value ${decryptedX} is too large for uint128`);
        }

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
          const { encryptedInt: xEncrypted, messageBytes: xMessageBytes } = prepareMessageForBubble128(
            token.x,
            userAddress,
            userAesKeyHex,
            await privateToken.getAddress()
          );
          const signedXMessage = await defaultSigner.signMessage(xMessageBytes);

          const { encryptedHigh: qHigh, encryptedLow: qLow, messageBytes: qMessageBytes } = prepareMessageForBubble256(
            token.q,
            userAddress,
            userAesKeyHex,
            await privateToken.getAddress()
          );
          const signedQMessage = await defaultSigner.signMessage(qMessageBytes);

          return {
            x: {
              userAddress: userAddress,
              ciphertext: xEncrypted,
              signature: signedXMessage
            },
            q: {
              userAddress: userAddress,
              ciphertext: {
                ciphertextHigh: qHigh,
                ciphertextLow: qLow
              },
              signature: signedQMessage
            },
            y_clear: token.y
          };
        })
      );

      // Prepare encrypted redeem amount
      const { encryptedHigh: amountHigh, encryptedLow: amountLow, messageBytes: amountMessageBytes } = prepareMessageForBubble256(
        redeemAmount,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );
      const signedAmountMessage = await defaultSigner.signMessage(amountMessageBytes);

      const encryptedRedeemAmount = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: amountHigh,
          ciphertextLow: amountLow
        },
        signature: signedAmountMessage
      };

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
      await new Promise(resolve => setTimeout(resolve, 30000));
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

      const mintedEvents = redeemReceipt?.logs.filter((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMinted";
        } catch {
          return false;
        }
      });

      // Decrypt and verify results
      console.log("[TEST] Step 8: Waiting 20s before decryption...");
      await new Promise(resolve => setTimeout(resolve, 20000));
      console.log("[TEST] Step 8.1: Starting decryption...");

      let remainderQHandle: bigint | undefined;
      if (mintedEvents.length > 0) {
        const remainderEvent = mintedEvents.find((e: any) => {
          const decoded = privateToken.interface.parseLog(e);
          return decoded?.args[0].toLowerCase() === userAddress.toLowerCase();
        });

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
      await new Promise(resolve => setTimeout(resolve, 5000));
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

      // Verify all input tokens were invalidated (burned)
      const invalidatedEvents = redeemReceipt?.logs.filter((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFTokenInvalidated" && Number(decoded?.args[4]) === 3;
        } catch {
          return false;
        }
      });

      expect(invalidatedEvents.length).to.equal(mintedTokens.length, "All input tokens should be invalidated");
    });

    // Tests that redeemMany correctly handles insufficient balance:
    // When redeem amount exceeds available tokens, recipient should get 0 and sender keeps all tokens
    it("redeemMany with insufficient balance should return 0 to recipient", async function () {
      this.timeout(300000); // 5 minutes - MPC operations take time

      console.log("📋 Step 1: Setup - preparing balances and recipient...");
      // ========== Setup: Prepare balances and recipient ==========
      const additionalShieldAmount = hre.ethers.parseEther("150");
      await mockToken.transfer(userAddress, additionalShieldAmount);
      await mockToken.approve(await privateToken.getAddress(), additionalShieldAmount);
      await privateToken.shield(additionalShieldAmount);
      await new Promise(resolve => setTimeout(resolve, 3000));

      // Setup recipient wallet and get their encryption key
      const recipientWallet = Wallet.createRandom().connect(hre.ethers.provider);
      const recipientAddress = await recipientWallet.getAddress();
      
      await defaultSigner.sendTransaction({
        to: recipientAddress,
        value: hre.ethers.parseEther("0.01")
      }).then((tx: any) => tx.wait());

      const recipientAesKey = await getUserKeyViaProxy(recipientWallet as any, PROXY_URL);
      console.log("   ✅ Setup complete");

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

      console.log("📋 Step 2: Minting OPRF tokens...");
      for (let i = 0; i < tokenQuantities.length; i++) {
        const quantity = tokenQuantities[i];
        
        const { encryptedHigh: qtyHigh, encryptedLow: qtyLow } = prepareMessageForBubble256(
          quantity,
          userAddress,
          userAesKeyHex,
          await privateToken.getAddress()
        );

        const quantityIT = {
          userAddress: userAddress,
          ciphertext: {
            ciphertextHigh: qtyHigh,
            ciphertextLow: qtyLow
          }
        };

        console.log(`   Minting token ${i + 1}/${tokenQuantities.length} (qty: ${quantity})...`);
        const mintTx = await privateToken.mintOPRFToken(quantityIT);
        const mintReceipt = await mintTx.wait();
        expect(mintReceipt?.status).to.equal(1);

        await new Promise(resolve => setTimeout(resolve, 10000));

        const mintEvent = mintReceipt?.logs.find((log: any) => {
          try {
            const decoded = privateToken.interface.parseLog(log);
            return decoded?.name === "OPRFMinted";
          } catch {
            return false;
          }
        });

        expect(mintEvent).to.not.be.undefined;
        const mintDecoded = privateToken.interface.parseLog(mintEvent!);
        const xHandle = mintDecoded?.args[1];
        const yHandle = mintDecoded?.args[2];
        const qHandle = mintDecoded?.args[3];

        await new Promise(resolve => setTimeout(resolve, 5000));

        const decryptedX = await decryptValueViaProxy(xHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedY = await decryptValueViaProxy(yHandle, defaultSigner, userAesKey, PROXY_URL);
        const decryptedQ = await decryptValueViaProxy(qHandle, defaultSigner, userAesKey, PROXY_URL);
        console.log(`   ✅ Token ${i + 1} minted and decrypted`);

        if (decryptedY > BigInt(2**128 - 1)) {
          throw new Error(`Y value ${decryptedY} is too large for uint128`);
        }
        if (decryptedX > BigInt(2**128 - 1)) {
          throw new Error(`X value ${decryptedX} is too large for uint128`);
        }

        mintedTokens.push({
          x: decryptedX,
          q: decryptedQ,
          y: decryptedY
        });
      }

      const totalQuantity = mintedTokens.reduce((sum, token) => sum + token.q, 0n);
      console.log(`   ✅ All tokens minted. Total: ${totalQuantity}`);

      console.log("📋 Step 3: Preparing tokens for redeemMany...");
      const tokensToRedeem = await Promise.all(
        mintedTokens.map(async (token) => {
          const { encryptedInt: xEncrypted } = prepareMessageForBubble128(
            token.x,
            userAddress,
            userAesKeyHex,
            await privateToken.getAddress()
          );

          const { encryptedHigh: qHigh, encryptedLow: qLow } = prepareMessageForBubble256(
            token.q,
            userAddress,
            userAesKeyHex,
            await privateToken.getAddress()
          );

          return {
            x: {
              userAddress: userAddress,
              ciphertext: xEncrypted
            },
            q: {
              userAddress: userAddress,
              ciphertext: {
                ciphertextHigh: qHigh,
                ciphertextLow: qLow
              }
            },
            y_clear: token.y
          };
        })
      );
      console.log("   ✅ Tokens prepared");

      console.log("📋 Step 4: Preparing encrypted redeem amount...");
      const { encryptedHigh: amountHigh, encryptedLow: amountLow } = prepareMessageForBubble256(
        redeemAmount,
        userAddress,
        userAesKeyHex,
        await privateToken.getAddress()
      );

      const encryptedRedeemAmount = {
        userAddress: userAddress,
        ciphertext: {
          ciphertextHigh: amountHigh,
          ciphertextLow: amountLow
        }
      };

      const recipientBalanceBeforeDecrypted = 0n;

      console.log("📋 Step 5: Executing redeemMany (insufficient balance test)...");
      const redeemTx = await privateToken.redeemMany(
        tokensToRedeem,
        encryptedRedeemAmount,
        recipientAddress
      );
      const redeemReceipt = await redeemTx.wait();
      expect(redeemReceipt?.status).to.equal(1);
      console.log("   ✅ Redeem transaction confirmed");

      console.log("📋 Step 6: Waiting for MPC computation (30s)...");
      await new Promise(resolve => setTimeout(resolve, 30000));

      console.log("📋 Step 7: Extracting events...");
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
          return decoded?.args[1].toLowerCase() === recipientAddress.toLowerCase();
        } catch {
          return false;
        }
      });
      
      expect(burnEvent).to.not.be.undefined;

      const burnDecoded = privateToken.interface.parseLog(burnEvent!);
      const burnedAmountHandle = burnDecoded?.args[2];

      const mintedEvents = redeemReceipt?.logs.filter((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFMinted";
        } catch {
          return false;
        }
      });
      console.log("   ✅ Events extracted");

      console.log("📋 Step 8: Decrypting results...");
      await new Promise(resolve => setTimeout(resolve, 10000));

      const decryptedBurnedAmount = await decryptValueViaProxy(burnedAmountHandle, defaultSigner, userAesKey, PROXY_URL);
      console.log(`   ✅ Decrypted burned amount: ${decryptedBurnedAmount}`);

      let decryptedRemainderQ = 0n;
      if (mintedEvents.length > 0) {
        const remainderEvent = mintedEvents.find((e: any) => {
          const decoded = privateToken.interface.parseLog(e);
          return decoded?.args[0].toLowerCase() === userAddress.toLowerCase();
        });

        if (remainderEvent) {
          const remainderDecoded = privateToken.interface.parseLog(remainderEvent);
          const remainderQHandle = remainderDecoded?.args[3];
          decryptedRemainderQ = await decryptValueViaProxy(remainderQHandle, defaultSigner, userAesKey, PROXY_URL);
        }
      }

      const recipientBalanceAfter = await privateToken["balanceOf(address)"](recipientAddress);
      await new Promise(resolve => setTimeout(resolve, 5000));
      const recipientBalanceAfterDecrypted = await decryptValueViaProxy(recipientBalanceAfter, recipientWallet, recipientAesKey, PROXY_URL);
      console.log(`   ✅ Decryption complete. Recipient balance: ${recipientBalanceAfterDecrypted}, Sender remainder: ${decryptedRemainderQ}`);

      console.log("📋 Step 9: Verifying results...");
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

      // Verify all input tokens were invalidated (burned)
      const invalidatedEvents = redeemReceipt?.logs.filter((log: any) => {
        try {
          const decoded = privateToken.interface.parseLog(log);
          return decoded?.name === "OPRFTokenInvalidated" && Number(decoded?.args[4]) === 3;
        } catch {
          return false;
        }
      });

      expect(invalidatedEvents.length).to.equal(mintedTokens.length, "All input tokens should be invalidated");
    });
  });
});
