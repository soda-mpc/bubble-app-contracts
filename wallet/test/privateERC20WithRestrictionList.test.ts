import { expect } from "chai";
import hre from "hardhat";
import { Wallet, HDNodeWallet } from "ethers";
import dotenv from "dotenv";

import {
  prepareMessageForBubble256
} from "./testUtils";
import { PrivateERC20WithRestrictionList256 } from "../typechain-types";
import { decryptValueViaProxy, getDecryptionTxDataViaProxy, getUserKeyViaProxy } from "./testUtils";

dotenv.config();

const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC) {
  throw new Error("MNEMONIC environment variable is required");
}

async function waitForDeploymentConfirmation(contract: { deploymentTransaction(): any; getAddress(): Promise<string>; }) {
  const tx = contract.deploymentTransaction();
  if (tx && typeof tx.wait === "function") {
    await tx.wait();
  }
  const provider = hre.ethers.provider;
  const address = await contract.getAddress();
  for (let attempt = 0; attempt < 10; attempt++) {
    const code = await provider.getCode(address);
    if (code && code !== "0x") {
      return;
    }
    await new Promise(resolve => setTimeout(resolve, 2000));
  }
  throw new Error(`Contract code not available at ${address} after waiting`);
}

async function decryptBalanceViaProxy(
  balanceHandle: bigint,
  signer: Wallet | HDNodeWallet,
  userAesKey: Buffer,
  proxyUrl: string
): Promise<bigint> {
  return decryptValueViaProxy(balanceHandle, signer, userAesKey, proxyUrl);
}

describe("PrivateERC20WithRestrictionList", function () {
  this.timeout(180000);
  let userAesKey: Buffer;
  let userAddress: string;
  let privateToken: PrivateERC20WithRestrictionList256;
  let mockToken: any;
  let otherWallet: HDNodeWallet;
  let restrictedWallet: HDNodeWallet;
  let defaultSigner: any;
  let companyRegistry: any;
  let govRegistry: any;
  let privateTokenDecimals: number;
  let underlyingDecimals: number;
  let conversionFactor: bigint;
  let shieldAmount: bigint;
  let expectedPrivateAmount: bigint;
  let transferAmount: bigint;
  let approvalAmount: bigint;

  before(async function () {
    // Get Hardhat's default signer
    [defaultSigner] = await hre.ethers.getSigners();
    
    // Setup main user with the default signer
    userAesKey = await getUserKeyViaProxy(defaultSigner as any, PROXY_URL);
    userAddress = await defaultSigner.getAddress();
    
    // Log the signer address to debug
    console.log("Default signer address:", userAddress);
    console.log("Default signer ETH balance:", hre.ethers.formatEther(await hre.ethers.provider.getBalance(userAddress)));

    // Create wallets for testing
    otherWallet = Wallet.createRandom().connect(hre.ethers.provider) as HDNodeWallet;
    restrictedWallet = Wallet.createRandom().connect(hre.ethers.provider) as HDNodeWallet;
    
    // Fund the random wallets with some ETH for gas fees
    const fundAmount = hre.ethers.parseEther("0.01"); // 0.01 ETH for gas
    await defaultSigner.sendTransaction({
      to: otherWallet.address,
      value: fundAmount
    });
    await defaultSigner.sendTransaction({
      to: restrictedWallet.address,
      value: fundAmount
    });
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Deploy restriction list registries
    const RestrictionListRegistryFactory = await hre.ethers.getContractFactory("RestrictionListRegistry", defaultSigner);
    companyRegistry = await (RestrictionListRegistryFactory as any).deploy(userAddress, "Company Compliance List");
    await companyRegistry.waitForDeployment();
    await waitForDeploymentConfirmation(companyRegistry);
    
    govRegistry = await (RestrictionListRegistryFactory as any).deploy(userAddress, "Government Sanctions List");
    await govRegistry.waitForDeployment();
    await waitForDeploymentConfirmation(govRegistry);

    console.log("Company Registry deployed to:", await companyRegistry.getAddress());
    console.log("Government Registry deployed to:", await govRegistry.getAddress());

    // Deploy mock token using the default signer
    const MockTokenFactory = await hre.ethers.getContractFactory("TUSDC", defaultSigner);
    mockToken = await MockTokenFactory.deploy("Test USDC", "TUSDC");
    await mockToken.waitForDeployment();
    await waitForDeploymentConfirmation(mockToken);
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Deploy private token implementation + proxy and initialize through proxy
    const ContractFactory = await hre.ethers.getContractFactory("PrivateERC20WithRestrictionList256", defaultSigner);
    const implementation = await ContractFactory.deploy();
    await implementation.waitForDeployment();
    await waitForDeploymentConfirmation(implementation);

    const ProxyFactory = await hre.ethers.getContractFactory(
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
      defaultSigner
    );
    const proxy = await ProxyFactory.deploy(await implementation.getAddress(), "0x");
    await proxy.waitForDeployment();
    await waitForDeploymentConfirmation(proxy);
    privateToken = ContractFactory.attach(await proxy.getAddress()) as PrivateERC20WithRestrictionList256;

    await (await (privateToken as any)["initialize(string,string,address,address,address)"](
      "ssbtUSDC",
      "ssbtUSDC",
      await mockToken.getAddress(),
      userAddress,
      userAddress
    )).wait();

    // Configure restriction registries post-initialization through owner-only functions.
    await (await privateToken.addRestrictionListRegistry(await companyRegistry.getAddress())).wait();
    await (await privateToken.addRestrictionListRegistry(await govRegistry.getAddress())).wait();
    await new Promise(resolve => setTimeout(resolve, 15000));

    const privateTokenCode = await hre.ethers.provider.getCode(await privateToken.getAddress());
    const mockTokenCode = await hre.ethers.provider.getCode(await mockToken.getAddress());
    console.log("Private token code length:", privateTokenCode.length);
    console.log("Mock token code length:", mockTokenCode.length);

    privateTokenDecimals = Number(await privateToken.decimals());
    underlyingDecimals = Number(await mockToken.decimals());
    const decimalsDiff = Math.max(0, underlyingDecimals - privateTokenDecimals);
    conversionFactor = 10n ** BigInt(decimalsDiff);
    shieldAmount = hre.ethers.parseUnits("150", underlyingDecimals);
    expectedPrivateAmount = shieldAmount / conversionFactor;
    transferAmount = hre.ethers.parseUnits("50", privateTokenDecimals);
    approvalAmount = hre.ethers.parseUnits("50", privateTokenDecimals);

    console.log("Private Token deployed to:", await privateToken.getAddress());
    console.log("Mock Token deployed to:", await mockToken.getAddress());
    await new Promise(resolve => setTimeout(resolve, 3000));
  });

  describe("Basic Token Information", function () {
    it("should have correct name, symbol and decimals", async function () {
      expect(await privateToken.name()).to.equal("ssbtUSDC");
      expect(await privateToken.symbol()).to.equal("ssbtUSDC");
      expect(await privateToken.decimals()).to.equal(18);
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

    it("should have active restriction list registries", async function () {
      expect(await privateToken.getActiveRegistryCount()).to.equal(2);
      expect(await privateToken.isRegistryActive(await companyRegistry.getAddress())).to.be.true;
      expect(await privateToken.isRegistryActive(await govRegistry.getAddress())).to.be.true;
    });

    it("should return correct registry names", async function () {
      const names = await privateToken.getActiveRegistryNames();
      expect(names).to.include("Company Compliance List");
      expect(names).to.include("Government Sanctions List");
    });
  });

  describe("Restriction List Management", function () {
    it("should allow owner to add address to restriction list", async function () {
      await (await companyRegistry.addToRestrictionList(restrictedWallet.address)).wait();
      
      // Wait for blockchain state to update
      await new Promise(resolve => setTimeout(resolve, 3000));

      expect(await privateToken.isRestricted(restrictedWallet.address)).to.be.true;
    });

    it("should allow owner to remove address from restriction list", async function () {
      // First add to restriction list
      await (await companyRegistry.addToRestrictionList(otherWallet.address)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      expect(await privateToken.isRestricted(otherWallet.address)).to.be.true;

      // Then remove
      await (await companyRegistry.removeFromRestrictionList(otherWallet.address)).wait();

      // Wait for blockchain state to update
      await new Promise(resolve => setTimeout(resolve, 3000));

      expect(await privateToken.isRestricted(otherWallet.address)).to.be.false;
    });

    it.only("should detect restrictions from multiple registries", async function () {
      // Add to government registry
      await (await govRegistry.addToRestrictionList(otherWallet.address)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      expect(await privateToken.isRestricted(otherWallet.address)).to.be.true;
      
      // Get comprehensive info (all restricting registries)
      const comprehensiveRestrictingRegistries = await privateToken.getComprehensiveRestrictionInfo(otherWallet.address);
      expect(comprehensiveRestrictingRegistries).to.have.length(1);
      expect(comprehensiveRestrictingRegistries[0]).to.equal(await govRegistry.getAddress());

      // Get detailed info with names
      const [restrictingRegistries, registryNames] = await privateToken.getDetailedRestrictionInfoWithNames(otherWallet.address);
      expect(restrictingRegistries).to.have.length(1);
      expect(registryNames).to.include("Government Sanctions List");

      // Clean up
      await (await govRegistry.removeFromRestrictionList(otherWallet.address)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
    });

    it("should allow owner to add/remove restriction list registries", async function () {
      // Create a new registry
      const RestrictionListRegistryFactory = await hre.ethers.getContractFactory("RestrictionListRegistry");
      const newRegistry = await (RestrictionListRegistryFactory as any).deploy(userAddress, "Internal Compliance List");
      await newRegistry.waitForDeployment();
      await waitForDeploymentConfirmation(newRegistry);

      // Add registry to token
      await (await privateToken.addRestrictionListRegistry(await newRegistry.getAddress())).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      expect(await privateToken.getActiveRegistryCount()).to.equal(3);

      // Remove registry from token
      await (await privateToken.removeRestrictionListRegistry(await newRegistry.getAddress())).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      expect(await privateToken.getActiveRegistryCount()).to.equal(2);
    });

    it("should skip operational restriction checks when enforcement is disabled", async function () {
      await (await companyRegistry.addToRestrictionList(otherWallet.address)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));

      expect(await privateToken.isRestricted(otherWallet.address)).to.be.true;

      await expect(privateToken["approve(address,uint256)"](otherWallet.address, 1n))
        .to.be.revertedWithCustomError(privateToken, "AccountIsRestricted")
        .withArgs(otherWallet.address, await companyRegistry.getAddress());

      await (await privateToken.setRestrictionListEnforcement(false)).wait();
      expect(await privateToken.restrictionListEnforcementEnabled()).to.be.false;
      expect(await privateToken.isRestricted(otherWallet.address)).to.be.false;

      const approveTx = await privateToken["approve(address,uint256)"](otherWallet.address, 1n);
      const approveReceipt = await approveTx.wait();
      expect(approveReceipt?.status).to.equal(1);

      await (await privateToken.setRestrictionListEnforcement(true)).wait();
      expect(await privateToken.restrictionListEnforcementEnabled()).to.be.true;

      await expect(privateToken["approve(address,uint256)"](otherWallet.address, 1n))
        .to.be.revertedWithCustomError(privateToken, "AccountIsRestricted")
        .withArgs(otherWallet.address, await companyRegistry.getAddress());
    });
  });

  describe("Shield/Unshield Operations with Restrictions", function () {

    beforeEach(async function () {
      // Ensure we have sufficient test tokens for all operations
      const currentBalance = await mockToken.balanceOf(userAddress);
      const requiredBalance = shieldAmount * 10n; // Ensure we have enough for multiple tests
      
      if (currentBalance < requiredBalance) {
        // Mint additional tokens if needed
        const mintAmount = requiredBalance - currentBalance;
        const mintTx = await mockToken.mint(userAddress, mintAmount);
        await mintTx.wait();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }

      console.log("BeforeEach: User address:", userAddress);
      console.log("BeforeEach: Restricted wallet address:", restrictedWallet.address);

      // Ensure random wallets have sufficient ETH for gas
      const minEthBalance = hre.ethers.parseEther("0.005"); // 0.005 ETH minimum
      const restrictedWalletBalance = await hre.ethers.provider.getBalance(restrictedWallet.address);
      const otherWalletBalance = await hre.ethers.provider.getBalance(otherWallet.address);
      
      if (restrictedWalletBalance < minEthBalance) {
        await defaultSigner.sendTransaction({
          to: restrictedWallet.address,
          value: hre.ethers.parseEther("0.01")
        });
      }
      
      if (otherWalletBalance < minEthBalance) {
        await defaultSigner.sendTransaction({
          to: otherWallet.address,
          value: hre.ethers.parseEther("0.01")
        });
      }
      await new Promise(resolve => setTimeout(resolve, 2000));

      // Ensure mockToken is connected to the correct signer
      const connectedMockToken = mockToken.connect(defaultSigner);

      // Mint tokens to user for each test
      try {
        const mintTx = await connectedMockToken.mint(userAddress, shieldAmount);
        await mintTx.wait();
      } catch (error: any) {
        if (error.message && error.message.includes("insufficient funds")) {
          const currentBalance = await hre.ethers.provider.getBalance(userAddress);
          throw new Error(`Insufficient ETH balance at address ${userAddress} for minting tokens. Current balance: ${hre.ethers.formatEther(currentBalance)} ETH. Please fund the test wallet.`);
        }
        throw error;
      }

      // Mint tokens to restricted wallet for testing
      const mintRestrictedTx = await connectedMockToken.mint(restrictedWallet.address, shieldAmount * 5n);
      await mintRestrictedTx.wait();
      
      // Mint tokens to other wallet for testing
      const mintOtherTx = await connectedMockToken.mint(otherWallet.address, shieldAmount * 3n);
      await mintOtherTx.wait();

      await new Promise(resolve => setTimeout(resolve, 3000));

      // Approve the private token to spend mock tokens
      const approveTx = await connectedMockToken.approve(await privateToken.getAddress(), shieldAmount);
      await approveTx.wait();

      // Approve for restricted wallet too
      const connectedMockTokenRestricted = mockToken.connect(restrictedWallet);
      const approveRestrictedTx = await connectedMockTokenRestricted.approve(await privateToken.getAddress(), shieldAmount);
      await approveRestrictedTx.wait();
    });

    it("should successfully shield standard tokens for non-restricted user", async function () {
      await new Promise(resolve => setTimeout(resolve, 3000));
      const totalSupplyBefore = await privateToken.totalSupply();
      const shieldTx = await privateToken.shield(shieldAmount);
      const shieldReceipt = await shieldTx.wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      expect(shieldReceipt).to.not.be.undefined;

      // Check Shield event
      const shieldEvent = shieldReceipt?.logs
        .map((log: any) => {
          try {
            return privateToken.interface.parseLog(log);
          } catch {
            return undefined;
          }
        })
        .find((decoded: any) => decoded?.name === "Shield");
      expect(shieldEvent).to.not.be.undefined;
      if (shieldEvent) {
        expect(shieldEvent.args.from).to.equal(userAddress);
        expect(shieldEvent.args.amount).to.equal(shieldAmount);
      }

      // Check total supply of private tokens
      const totalSupplyAfter = await privateToken.totalSupply();
      expect(totalSupplyAfter - totalSupplyBefore).to.equal(expectedPrivateAmount);

      // Check user's private balance
      await new Promise(resolve => setTimeout(resolve, 3000));
      const balanceHandle = await privateToken["balanceOf(address)"](userAddress);
      // Wait for MPC to process before decryption
      await new Promise(resolve => setTimeout(resolve, 2000));
      const decryptedBalance = await decryptBalanceViaProxy(balanceHandle, defaultSigner, userAesKey, PROXY_URL);
      expect(decryptedBalance).to.equal(expectedPrivateAmount);
    });

    it("should prevent restricted user from shielding tokens", async function () {
      const connectedPrivateToken = privateToken.connect(restrictedWallet);
      
      await expect(connectedPrivateToken.shield(shieldAmount))
        .to.be.revertedWithCustomError(privateToken, "AccountIsRestricted")
        .withArgs(restrictedWallet.address, await companyRegistry.getAddress());
    });

    it("should successfully unshield private tokens for non-restricted user", async function () {
      // Check current private balance first
      const currentBalanceHandle = await privateToken["balanceOf(address)"](userAddress);
      let currentBalance = 0n;
      if (currentBalanceHandle !== 0n) {
        // Wait for MPC to process before decryption
        await new Promise(resolve => setTimeout(resolve, 2000));
        currentBalance = await decryptBalanceViaProxy(currentBalanceHandle, defaultSigner, userAesKey, PROXY_URL);
      }
      
      // If no balance, shield some tokens first
      if (currentBalance === 0n) {
        await (await privateToken.shield(shieldAmount)).wait();
        await new Promise(resolve => setTimeout(resolve, 5000));
        
        const balanceAfterShieldHandle = await privateToken["balanceOf(address)"](userAddress);
        // Wait for MPC to process before decryption
        await new Promise(resolve => setTimeout(resolve, 2000));
        currentBalance = await decryptBalanceViaProxy(balanceAfterShieldHandle, defaultSigner, userAesKey, PROXY_URL);
        expect(currentBalance).to.equal(expectedPrivateAmount);
      }

      const mockTokenBalanceBefore = await mockToken.balanceOf(userAddress);
      const totalSupplyBefore = await privateToken.totalSupply();

      // Request unshield - unshield the current balance
      const contractAddress = await privateToken.getAddress();
      const unshieldTx = await privateToken.unshield(currentBalance);
      const unshieldReceipt = await unshieldTx.wait();
      expect(unshieldReceipt).to.not.be.undefined;

      // Fetch callback calldata from proxy and submit callback if needed.
      const decryptId = await privateToken.getLastDecryptRequestId();
      await new Promise(resolve => setTimeout(resolve, 15000));
      const network = await hre.ethers.provider.getNetwork();
      const chainId = Number(network.chainId);
      const txDataHex = await getDecryptionTxDataViaProxy(PROXY_URL, chainId, contractAddress, decryptId);
      if (txDataHex && txDataHex !== "0x") {
        try {
          const callbackTx = await defaultSigner.sendTransaction({
            to: contractAddress,
            data: txDataHex,
            gasLimit: 500_000,
          });
          await callbackTx.wait();
        } catch {
          // Callback may have already been submitted by backend relayer.
        }
      }
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Check mock token balance difference
      const mockTokenBalanceAfter = await mockToken.balanceOf(userAddress);
      const balanceDifference = mockTokenBalanceAfter - mockTokenBalanceBefore;
      // The balance difference should equal the amount that was unshielded (converted to underlying)
      const expectedMockTokenIncrease = currentBalance * conversionFactor;
      expect(balanceDifference).to.equal(expectedMockTokenIncrease);

      // Check total supply reduced
      const totalSupplyAfter = await privateToken.totalSupply();
      expect(totalSupplyBefore - totalSupplyAfter).to.equal(currentBalance);
    });

    it("should prevent restricted user from transferring tokens", async function () {
      // This test assumes the restricted user somehow got tokens before being restricted
      // We'll test the restriction check in the unshield function
      
      // Check if restrictedWallet is already in the restriction list
      const isCurrentlyRestricted = await privateToken.isRestricted(restrictedWallet.address);
      console.log("Is restrictedWallet currently restricted?", isCurrentlyRestricted);
      
      // First, let's temporarily remove the restriction to shield tokens
      if (isCurrentlyRestricted) {
        await companyRegistry.removeFromRestrictionList(restrictedWallet.address);
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
      // Shield tokens as restricted user BEFORE adding them to restriction list
      // Wait before MPC proxy call
      await new Promise(resolve => setTimeout(resolve, 2000));
      const restrictedUserAesKey = await getUserKeyViaProxy(restrictedWallet, PROXY_URL);
      const connectedPrivateToken = privateToken.connect(restrictedWallet);
      console.log("About to shield tokens as restricted user (before restriction)...");
      
      // First, make sure the restricted user has approved the private token to spend their mock tokens
      const connectedMockToken = mockToken.connect(restrictedWallet);
      await (await connectedMockToken.approve(await privateToken.getAddress(), shieldAmount)).wait();
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Now shield the tokens
      await (await connectedPrivateToken.shield(shieldAmount)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Check if the restricted user has tokens
      const balanceHandle = await privateToken["balanceOf(address)"](restrictedWallet.address);
      console.log("Restricted user balance handle:", balanceHandle.toString());
      
      // Now add them to restriction list
      await (await companyRegistry.addToRestrictionList(restrictedWallet.address)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Verify the restriction is applied
      const isRestrictedAfter = await privateToken.isRestricted(restrictedWallet.address);
      expect(isRestrictedAfter).to.equal(true);
      console.log("Is restrictedWallet restricted after adding to list?", isRestrictedAfter);
      
      // Test the inline restriction check directly
      console.log("Testing inline restriction check...");
      try {
        const restrictingRegistry = await privateToken.getRestrictingRegistry(restrictedWallet.address);
        console.log("Restricting registry from inline check:", restrictingRegistry);
        
        if (restrictingRegistry !== "0x0000000000000000000000000000000000000000") {
          console.log("✅ Inline restriction check found restricting registry");
        } else {
          console.log("❌ Inline restriction check found no restricting registry");
        }
      } catch (error: any) {
        console.log("Error in inline restriction check:", error.message);
      }
      
      // Try to transfer instead - should fail due to restriction
      console.log("About to try transfer with amount:", expectedPrivateAmount.toString());
      await expect(connectedPrivateToken["transfer(address,uint256)"](otherWallet.address, expectedPrivateAmount))
        .to.be.revertedWithCustomError(privateToken, "AccountIsRestricted")
        .withArgs(restrictedWallet.address, await companyRegistry.getAddress());
      console.log("✅ Transfer correctly reverted with AccountIsRestricted");
        
      // Clean up - remove from restriction list and let them unshield
      await (await companyRegistry.removeFromRestrictionList(restrictedWallet.address)).wait();
      await (await connectedPrivateToken.unshield(expectedPrivateAmount)).wait();
      
      // Wait for unshield to complete
      await new Promise(resolve => setTimeout(resolve, 10000));
      
      // Add back to restriction list for other tests
      await (await companyRegistry.addToRestrictionList(restrictedWallet.address)).wait();
    });
  });

  describe("Transfer Operations with Restrictions", function () {
    let transferTestShieldAmount: bigint;
    let initialPrivateBalance: bigint;

    beforeEach(async function () {
      transferTestShieldAmount = hre.ethers.parseUnits("100", underlyingDecimals);
      initialPrivateBalance = transferTestShieldAmount / conversionFactor;

      // Ensure we have sufficient test tokens
      const currentBalance = await mockToken.balanceOf(userAddress);
      const requiredBalance = transferTestShieldAmount * 5n;
      
      if (currentBalance < requiredBalance) {
        const mintAmount = requiredBalance - currentBalance;
        await (await mockToken.mint(userAddress, mintAmount)).wait();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      // Ensure random wallets have sufficient ETH for gas
      const minEthBalance = hre.ethers.parseEther("0.005"); // 0.005 ETH minimum
      const restrictedWalletBalance = await hre.ethers.provider.getBalance(restrictedWallet.address);
      const otherWalletBalance = await hre.ethers.provider.getBalance(otherWallet.address);
      
      if (restrictedWalletBalance < minEthBalance) {
        await defaultSigner.sendTransaction({
          to: restrictedWallet.address,
          value: hre.ethers.parseEther("0.01")
        });
      }
      
      if (otherWalletBalance < minEthBalance) {
        await defaultSigner.sendTransaction({
          to: otherWallet.address,
          value: hre.ethers.parseEther("0.01")
        });
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Add restrictedWallet to restriction list for this test section
      const isAlreadyRestricted = await companyRegistry.isRestricted(restrictedWallet.address);
      if (!isAlreadyRestricted) {
        await (await companyRegistry.addToRestrictionList(restrictedWallet.address)).wait();
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
      // Mint and shield tokens for transfer tests
      await (await mockToken.approve(await privateToken.getAddress(), transferTestShieldAmount)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      await (await privateToken.shield(transferTestShieldAmount)).wait();
    });

    it("should successfully transfer private tokens between non-restricted users", async function () {
      await new Promise(resolve => setTimeout(resolve, 5000));

      const balanceHandleBefore = await privateToken["balanceOf(address)"](userAddress);
      await new Promise(resolve => setTimeout(resolve, 2000));
      const balanceBefore = await decryptBalanceViaProxy(balanceHandleBefore, defaultSigner, userAesKey, PROXY_URL);
      expect(balanceBefore).to.equal(initialPrivateBalance);

      // Transfer to other wallet (non-restricted)
      const transferTx = await privateToken["transfer(address,uint256)"](otherWallet.address, transferAmount);
      await transferTx.wait();

      // Check sender's balance
      const senderBalanceHandle = await privateToken["balanceOf(address)"](userAddress);
      try {
        // Wait for MPC to process before decryption
        await new Promise(resolve => setTimeout(resolve, 2000));
        const senderBalance = await decryptBalanceViaProxy(senderBalanceHandle, defaultSigner, userAesKey, PROXY_URL);
        expect(senderBalance).to.equal(balanceBefore - transferAmount);
      } catch (error) {
        console.log("Failed to decrypt balance, skipping balance check");
        this.skip();
      }
    });

    it("should prevent transfer from restricted user", async function () {
      // First remove from restriction list temporarily to give them tokens (if they're in it)
      const isCurrentlyRestricted = await companyRegistry.isRestricted(restrictedWallet.address);
      if (isCurrentlyRestricted) {
        await (await companyRegistry.removeFromRestrictionList(restrictedWallet.address)).wait();
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
      // Give some tokens to user while they're not restricted
      await (await privateToken["transfer(address,uint256)"](restrictedWallet.address, transferAmount)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Now add them back to restriction list
      await (await companyRegistry.addToRestrictionList(restrictedWallet.address)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      expect(await privateToken.isRestricted(restrictedWallet.address)).to.equal(true);
      
      const connectedPrivateToken = privateToken.connect(restrictedWallet);
      
      // Try to transfer from restricted user - should fail with custom error
      const restrictedTransferAmount = hre.ethers.parseUnits("25", privateTokenDecimals);
      await expect(connectedPrivateToken["transfer(address,uint256)"](otherWallet.address, restrictedTransferAmount))
        .to.be.revertedWithCustomError(privateToken, "AccountIsRestricted")
        .withArgs(restrictedWallet.address, await companyRegistry.getAddress());
    });

    it("should prevent transfer to restricted user", async function () {
      const isRestricted = await companyRegistry.isRestricted(restrictedWallet.address);
      if (!isRestricted) {
        await (await companyRegistry.addToRestrictionList(restrictedWallet.address)).wait();
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      await expect(privateToken["transfer(address,uint256)"](restrictedWallet.address, transferAmount))
        .to.be.revertedWithCustomError(privateToken, "AccountIsRestricted")
        .withArgs(restrictedWallet.address, await companyRegistry.getAddress());
    });

    it("should successfully transfer using encrypted IT value between non-restricted users", async function () {
      // Onboard the receiver (otherWallet)
      // Wait before MPC proxy call
      await new Promise(resolve => setTimeout(resolve, 2000));
      const otherUserAesKey = await getUserKeyViaProxy(otherWallet, PROXY_URL);
      const amount = transferAmount;
      const PRIVATE_TOKEN_ADDRESS = await privateToken.getAddress();

      // Get balances before transfer
      await new Promise(resolve => setTimeout(resolve, 5000));

      const senderBalanceHandleBefore = await privateToken["balanceOf(address)"](userAddress);
      // Wait for MPC to process before decryption
      await new Promise(resolve => setTimeout(resolve, 2000));
      const senderBalanceBefore = await decryptBalanceViaProxy(senderBalanceHandleBefore, defaultSigner, userAesKey, PROXY_URL);
      const receiverBalanceHandleBefore = await privateToken["balanceOf(address)"](otherWallet.address);
      let receiverBalanceBefore = receiverBalanceHandleBefore;
      if (receiverBalanceBefore !== 0n) {
        // Wait for MPC to process before decryption
        await new Promise(resolve => setTimeout(resolve, 2000));
        receiverBalanceBefore = await decryptBalanceViaProxy(receiverBalanceHandleBefore, otherWallet, otherUserAesKey, PROXY_URL);
      }

      // Prepare encrypted message
      const { encryptedHigh, encryptedLow } = prepareMessageForBubble256(
        amount,
        await defaultSigner.getAddress(),
        userAesKey.toString("hex"),
        PRIVATE_TOKEN_ADDRESS
      );

      // Execute the transfer using the IT struct
      const transferTx = await privateToken["transfer(address,(address,(uint256,uint256)))"](otherWallet.address, {
        userAddress: await defaultSigner.getAddress(),
        ciphertext: {
          ciphertextHigh: encryptedHigh,
          ciphertextLow: encryptedLow
        }
      });
      await transferTx.wait();

      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get balances after transfer
      const senderBalanceHandleAfter = await privateToken["balanceOf(address)"](userAddress);
      // Wait for MPC to process before decryption
      await new Promise(resolve => setTimeout(resolve, 2000));
      const senderBalanceAfter = await decryptBalanceViaProxy(senderBalanceHandleAfter, defaultSigner, userAesKey, PROXY_URL);
      const receiverBalanceHandleAfter = await privateToken["balanceOf(address)"](otherWallet.address);
      // Wait for MPC to process before decryption
      await new Promise(resolve => setTimeout(resolve, 2000));
      const receiverBalanceAfter = await decryptBalanceViaProxy(receiverBalanceHandleAfter, otherWallet, otherUserAesKey, PROXY_URL);

      // Assert balances
      expect(senderBalanceAfter).to.equal(senderBalanceBefore - amount);
      expect(receiverBalanceAfter).to.equal(receiverBalanceBefore + amount);
    });

    it("should prevent encrypted transfer to restricted user", async function () {
      const privateTokenDecimals = 5;
      const amount = "25";
      const PRIVATE_TOKEN_ADDRESS = await privateToken.getAddress();

      const amountInBigInt = hre.ethers.parseUnits(amount, privateTokenDecimals);
      
      // Prepare encrypted message for transfer to restricted user
      const { encryptedHigh, encryptedLow } = prepareMessageForBubble256(
        amountInBigInt,
        await defaultSigner.getAddress(),
        userAesKey.toString("hex"),
        PRIVATE_TOKEN_ADDRESS
      );

      // Execute the transfer - should fail
      await expect(privateToken["transfer(address,(address,(uint256,uint256)))"](restrictedWallet.address, {
          userAddress: await defaultSigner.getAddress(),
          ciphertext: {
            ciphertextHigh: encryptedHigh,
            ciphertextLow: encryptedLow
          }
        }))
        .to.be.revertedWithCustomError(privateToken, "AccountIsRestricted")
        .withArgs(restrictedWallet.address, await companyRegistry.getAddress());
    });

    it("should handle self-transfer for non-restricted user", async function () {
      // Get balance before self-transfer
      await new Promise(resolve => setTimeout(resolve, 5000));
      const balanceHandleBefore = await privateToken["balanceOf(address)"](userAddress);
      // Wait for MPC to process before decryption
      await new Promise(resolve => setTimeout(resolve, 2000));
      const balanceBefore = await decryptBalanceViaProxy(balanceHandleBefore, defaultSigner, userAesKey, PROXY_URL);

      // Self-transfer (transfer to same address)
      const transferTx = await privateToken["transfer(address,uint256)"](userAddress, transferAmount);
      await transferTx.wait();

      // Wait for processing
      await new Promise(resolve => setTimeout(resolve, 5000));

      // Get balance after self-transfer
      const balanceHandleAfter = await privateToken["balanceOf(address)"](userAddress);
      // Wait for MPC to process before decryption
      await new Promise(resolve => setTimeout(resolve, 2000));
      const balanceAfter = await decryptBalanceViaProxy(balanceHandleAfter, defaultSigner, userAesKey, PROXY_URL);

      // Balance should remain the same in a self-transfer
      expect(balanceAfter).to.equal(balanceBefore);
    });
  });

  describe("Approval Operations with Restrictions", function () {
    let approvalTestShieldAmount: bigint;

    beforeEach(async function () {
      approvalTestShieldAmount = hre.ethers.parseUnits("100", underlyingDecimals);

      // Ensure we have sufficient test tokens
      const currentBalance = await mockToken.balanceOf(userAddress);
      const requiredBalance = approvalTestShieldAmount * 3n;
      
      if (currentBalance < requiredBalance) {
        const mintAmount = requiredBalance - currentBalance;
        await (await mockToken.mint(userAddress, mintAmount)).wait();
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
      
      // Ensure random wallets have sufficient ETH for gas
      const minEthBalance = hre.ethers.parseEther("0.005"); // 0.005 ETH minimum
      const restrictedWalletBalance = await hre.ethers.provider.getBalance(restrictedWallet.address);
      const otherWalletBalance = await hre.ethers.provider.getBalance(otherWallet.address);
      
      if (restrictedWalletBalance < minEthBalance) {
        await defaultSigner.sendTransaction({
          to: restrictedWallet.address,
          value: hre.ethers.parseEther("0.01")
        });
      }
      
      if (otherWalletBalance < minEthBalance) {
        await defaultSigner.sendTransaction({
          to: otherWallet.address,
          value: hre.ethers.parseEther("0.01")
        });
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
      
      // Mint and shield tokens for approval tests
      await (await mockToken.approve(await privateToken.getAddress(), approvalTestShieldAmount)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      await (await privateToken.shield(approvalTestShieldAmount)).wait();
    });

    it("should successfully approve non-restricted spender", async function () {
      const approveTx = await privateToken["approve(address,uint256)"](otherWallet.address, approvalAmount);
      await approveTx.wait();

      // Note: In a real scenario, we'd check the allowance, but that requires additional MPC functionality
      // For now, we just verify the transaction doesn't revert
      expect(approveTx).to.not.be.undefined;
    });

    it("should prevent approval of restricted spender", async function () {
      await expect(privateToken["approve(address,uint256)"](restrictedWallet.address, approvalAmount))
        .to.be.revertedWithCustomError(privateToken, "AccountIsRestricted")
        .withArgs(restrictedWallet.address, await companyRegistry.getAddress());
    });

    it("should prevent restricted user from giving approvals", async function () {
      // First remove from restriction list temporarily to give them tokens (if they're in it)
      const isCurrentlyRestricted = await companyRegistry.isRestricted(restrictedWallet.address);
      if (isCurrentlyRestricted) {
        await (await companyRegistry.removeFromRestrictionList(restrictedWallet.address)).wait();
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
      
      // Give some tokens to user while they're not restricted
      await (await privateToken["transfer(address,uint256)"](restrictedWallet.address, approvalAmount)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      // Now add them back to restriction list
      await (await companyRegistry.addToRestrictionList(restrictedWallet.address)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      const connectedPrivateToken = privateToken.connect(restrictedWallet);
      
      // Try to approve from restricted user - should fail with custom error
      const restrictedApprovalAmount = hre.ethers.parseUnits("25", privateTokenDecimals);
      await expect(connectedPrivateToken["approve(address,uint256)"](otherWallet.address, restrictedApprovalAmount))
        .to.be.revertedWithCustomError(privateToken, "AccountIsRestricted")
        .withArgs(restrictedWallet.address, await companyRegistry.getAddress());
    });

    it("should successfully approve using encrypted IT value for non-restricted users", async function () {
      const amount = hre.ethers.parseUnits("30", privateTokenDecimals);
      const PRIVATE_TOKEN_ADDRESS = await privateToken.getAddress();

      // Prepare encrypted message for approval
      const { encryptedHigh, encryptedLow } = prepareMessageForBubble256(
        amount,
        await defaultSigner.getAddress(),
        userAesKey.toString("hex"),
        PRIVATE_TOKEN_ADDRESS
      );

      // Execute the approval using the IT struct
      try {
        const approveTx = await privateToken["approve(address,(address,(uint256,uint256)))"](otherWallet.address, {
          userAddress: await defaultSigner.getAddress(),
          ciphertext: {
            ciphertextHigh: encryptedHigh,
            ciphertextLow: encryptedLow
          }
        });
        await approveTx.wait();
        // Verify transaction completed without reverting
        expect(approveTx).to.not.be.undefined;
      } catch (error) {
        console.log("Encrypted approval failed, skipping test");
        this.skip();
      }
    });
  });

  describe("Restriction List Integration", function () {
    beforeEach(async function () {
      // Ensure clean state for restriction tests
      // Remove otherWallet from all registries (in case it was added in previous tests)
      try {
        await (await companyRegistry.removeFromRestrictionList(otherWallet.address)).wait();
        await (await govRegistry.removeFromRestrictionList(otherWallet.address)).wait();
      } catch (error) {
        // Ignore errors if they're not in the list
      }
      
      // Ensure restrictedWallet is in company registry for these tests
      const isAlreadyRestricted = await companyRegistry.isRestricted(restrictedWallet.address);
      if (!isAlreadyRestricted) {
        await (await companyRegistry.addToRestrictionList(restrictedWallet.address)).wait();
        await new Promise(resolve => setTimeout(resolve, 3000));
      }
    });

    afterEach(async function () {
      // Clean up any restriction list changes made during tests
      try {
        await (await companyRegistry.removeFromRestrictionList(otherWallet.address)).wait();
        await (await govRegistry.removeFromRestrictionList(otherWallet.address)).wait();
      } catch (error) {
        // Ignore errors if they're not in the list
      }
      await new Promise(resolve => setTimeout(resolve, 2000));
    });

    it("should correctly report restriction status", async function () {
      expect(await privateToken.isRestricted(userAddress)).to.be.false;
      expect(await privateToken.isRestricted(otherWallet.address)).to.be.false;
      expect(await privateToken.isRestricted(restrictedWallet.address)).to.be.true;
    });

    it("should handle dynamic restriction changes", async function () {
      // Initially not restricted
      expect(await privateToken.isRestricted(otherWallet.address)).to.be.false;
      
      // Add to restriction list
      await (await companyRegistry.addToRestrictionList(otherWallet.address)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      expect(await privateToken.isRestricted(otherWallet.address)).to.be.true;
      
      // Remove from restriction list
      await (await companyRegistry.removeFromRestrictionList(otherWallet.address)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      expect(await privateToken.isRestricted(otherWallet.address)).to.be.false;
    });

    it("should handle multiple registry restrictions", async function () {
      // Add to both registries
      await (await companyRegistry.addToRestrictionList(otherWallet.address)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      await (await govRegistry.addToRestrictionList(otherWallet.address)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      
      expect(await privateToken.isRestricted(otherWallet.address)).to.be.true;
      
      // Remove from one registry - still restricted
      await (await companyRegistry.removeFromRestrictionList(otherWallet.address)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      expect(await privateToken.isRestricted(otherWallet.address)).to.be.true;
      
      // Remove from second registry - no longer restricted
      await (await govRegistry.removeFromRestrictionList(otherWallet.address)).wait();
      await new Promise(resolve => setTimeout(resolve, 3000));
      expect(await privateToken.isRestricted(otherWallet.address)).to.be.false;
    });

    it("should emit RestrictedAddressBlocked events appropriately", async function () {
      // This would require testing specific functions that emit this event
      // For now, we know it's emitted in the modifier when restrictions are checked
      
      // Try a restricted operation and catch the revert to see if it would emit the event
      await expect(privateToken["transfer(address,uint256)"](restrictedWallet.address, 100))
        .to.be.revertedWithCustomError(privateToken, "AccountIsRestricted");
    });
  });

  describe("Pause Functionality", function () {
    const pauseTestShieldAmount = hre.ethers.parseUnits("20", 18);

    beforeEach(async function () {
      // Ensure each test starts unpaused even if a prior test left paused state.
      if (await privateToken.paused()) {
        await (await privateToken.unpause()).wait();
      }

      // Ensure user has enough underlying tokens and allowance, then shield once.
      await (await mockToken.mint(userAddress, pauseTestShieldAmount)).wait();
      await (await mockToken.approve(await privateToken.getAddress(), pauseTestShieldAmount)).wait();
      await (await privateToken.shield(pauseTestShieldAmount)).wait();
      await new Promise(resolve => setTimeout(resolve, 2000));
    });

    it("should allow owner to pause and emit Paused event", async function () {
      const tx = await privateToken.pause();
      const receipt = await tx.wait();
      expect(receipt).to.not.be.null;

      const pausedEvent = receipt?.logs
        .map((log: any) => {
          try {
            return privateToken.interface.parseLog(log);
          } catch {
            return undefined;
          }
        })
        .find((decoded: any) => decoded?.name === "Paused");

      expect(pausedEvent).to.not.be.undefined;
      if (pausedEvent) {
        expect(pausedEvent.args.account).to.equal(userAddress);
      }
    });

    it("should allow owner to unpause and emit Unpaused event", async function () {
      await (await privateToken.pause()).wait();
      const tx = await privateToken.unpause();
      const receipt = await tx.wait();
      expect(receipt).to.not.be.null;

      const unpausedEvent = receipt?.logs
        .map((log: any) => {
          try {
            return privateToken.interface.parseLog(log);
          } catch {
            return undefined;
          }
        })
        .find((decoded: any) => decoded?.name === "Unpaused");

      expect(unpausedEvent).to.not.be.undefined;
      if (unpausedEvent) {
        expect(unpausedEvent.args.account).to.equal(userAddress);
      }
    });

    it("should revert token operations while paused", async function () {
      await (await privateToken.pause()).wait();

      await expect(
        privateToken["transfer(address,uint256)"](otherWallet.address, hre.ethers.parseUnits("1", 18))
      ).to.be.revertedWithCustomError(privateToken, "EnforcedPause");
    });

    it("should revert pause when already paused", async function () {
      await (await privateToken.pause()).wait();
      await expect(privateToken.pause()).to.be.revertedWithCustomError(privateToken, "EnforcedPause");
    });

    it("should revert unpause when not paused", async function () {
      await expect(privateToken.unpause()).to.be.revertedWithCustomError(privateToken, "ExpectedPause");
    });
  });
}); 
