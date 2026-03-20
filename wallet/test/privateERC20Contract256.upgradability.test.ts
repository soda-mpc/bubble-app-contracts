import { expect } from "chai";
import hre from "hardhat";
import { HDNodeWallet } from "ethers";
import dotenv from "dotenv";

dotenv.config();

const MNEMONIC = process.env.MNEMONIC;
if (!MNEMONIC) {
  throw new Error("MNEMONIC environment variable is required");
}

describe("PrivateERC20Contract256 Upgradability", function () {
  this.timeout(120000); // 2 minutes timeout for operations

  let privateToken: any;
  let mockToken: any;
  let implementation: any;
  let proxy: any;
  let defaultSigner: any;
  let otherWallet: HDNodeWallet;
  let thirdWallet: HDNodeWallet;
  let implementationAddress: string;
  let proxyAddress: string;

  before(async function () {
    console.log("🚀 Starting PrivateERC20Contract256 Upgradability test setup...");

    // Get Hardhat's default signer
    console.log("📡 Getting signers from hardhat...");
    const signers = await hre.ethers.getSigners();
    defaultSigner = signers[0];
    console.log("✅ Got default signer:", defaultSigner.address);

    // Create other wallets for testing
    otherWallet = hre.ethers.Wallet.fromPhrase(MNEMONIC!).deriveChild(1).connect(hre.ethers.provider);
    thirdWallet = hre.ethers.Wallet.fromPhrase(MNEMONIC!).deriveChild(2).connect(hre.ethers.provider);
    console.log("✅ Created other wallet:", otherWallet.address);
    console.log("✅ Created third wallet:", thirdWallet.address);

    // Fund the other wallets with ETH for gas
    const fundAmount = hre.ethers.parseEther("0.1");
    console.log("💰 Funding other wallets with ETH...");
    
    const fundTx1 = await defaultSigner.sendTransaction({
      to: otherWallet.address,
      value: fundAmount
    });
    await fundTx1.wait();
    console.log("✅ Funded otherWallet with 0.1 ETH");

    const fundTx2 = await defaultSigner.sendTransaction({
      to: thirdWallet.address,
      value: fundAmount
    });
    await fundTx2.wait();
    console.log("✅ Funded thirdWallet with 0.1 ETH");

    // Deploy mock ERC20 token
    console.log("🏗️ Deploying mock token...");
    const MockTokenFactory = await hre.ethers.getContractFactory("TUSDC", defaultSigner);
    mockToken = await MockTokenFactory.deploy("Test USDC", "TUSDC");
    await mockToken.waitForDeployment();
    console.log("✅ Mock token deployed at:", await mockToken.getAddress());

    // Wait for contract to be available
    await new Promise(resolve => setTimeout(resolve, 3000));

    // Deploy PrivateERC20Contract256 implementation
    console.log("🏗️ Deploying PrivateERC20Contract256 implementation...");
    const ImplementationFactory = await hre.ethers.getContractFactory(
      "contracts/PrivateERC20Contract256.sol:PrivateERC20Contract256",
      defaultSigner
    );
    implementation = await ImplementationFactory.deploy();
    await implementation.waitForDeployment();
    implementationAddress = await implementation.getAddress();
    console.log("✅ Implementation deployed at:", implementationAddress);

    // Encode the initialize function call
    console.log("🔧 Encoding initialize function call...");
    const initializeInterface = ImplementationFactory.interface;
    const initData = initializeInterface.encodeFunctionData("initialize", [
      "BubbleToken",
      "BUB",
      await mockToken.getAddress(),
      defaultSigner.address, // owner
      defaultSigner.address  // master
    ]);

    // Deploy ERC1967Proxy pointing to the implementation
    console.log("🏗️ Deploying ERC1967Proxy...");
    const ProxyFactory = await hre.ethers.getContractFactory(
      "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy",
      defaultSigner
    );
    proxy = await ProxyFactory.deploy(implementationAddress, initData);
    await proxy.waitForDeployment();
    proxyAddress = await proxy.getAddress();
    console.log("✅ Proxy deployed at:", proxyAddress);

    // Get the contract instance attached to the proxy address
    privateToken = ImplementationFactory.attach(proxyAddress);
    console.log("✅ PrivateERC20Contract256 (upgradeable) ready at:", proxyAddress);
  });

  // ============================================
  // 1. OWNERSHIP TESTS (Ownable2StepUpgradeable)
  // ============================================
  describe("Ownership Tests", function () {
    // Helper function to ensure defaultSigner is the owner
    async function ensureDefaultSignerIsOwner() {
      const currentOwner = await privateToken.owner();
      if (currentOwner !== defaultSigner.address) {
        // If otherWallet is owner, transfer back
        if (currentOwner === otherWallet.address) {
          await (await privateToken.connect(otherWallet).transferOwnership(defaultSigner.address)).wait();
          await (await privateToken.connect(defaultSigner).acceptOwnership()).wait();
        }
      }
      // Clear any pending owner by transferring to zero
      const pendingOwner = await privateToken.pendingOwner();
      if (pendingOwner !== hre.ethers.ZeroAddress) {
        await (await privateToken.connect(defaultSigner).transferOwnership(hre.ethers.ZeroAddress)).wait();
      }
    }

    describe("Positive Cases", function () {
      beforeEach(async function () {
        await ensureDefaultSignerIsOwner();
      });

      it("should return correct owner after initialization", async function () {
        const owner = await privateToken.owner();
        expect(owner).to.equal(defaultSigner.address);
      });

      it("should allow owner to initiate ownership transfer", async function () {
        // Transfer ownership to otherWallet
        const tx = await privateToken.connect(defaultSigner).transferOwnership(otherWallet.address);
        await tx.wait();

        // Check pending owner
        const pendingOwner = await privateToken.pendingOwner();
        expect(pendingOwner).to.equal(otherWallet.address);

        // Current owner should still be defaultSigner until accepted
        const currentOwner = await privateToken.owner();
        expect(currentOwner).to.equal(defaultSigner.address);
      });

      it("should allow pending owner to accept ownership", async function () {
        // First initiate transfer
        await (await privateToken.connect(defaultSigner).transferOwnership(otherWallet.address)).wait();

        // Accept ownership
        const tx = await privateToken.connect(otherWallet).acceptOwnership();
        await tx.wait();

        // Verify ownership transferred
        const newOwner = await privateToken.owner();
        expect(newOwner).to.equal(otherWallet.address);

        // Pending owner should be cleared
        const newPendingOwner = await privateToken.pendingOwner();
        expect(newPendingOwner).to.equal(hre.ethers.ZeroAddress);
      });

      it("should emit OwnershipTransferStarted event when transfer initiated", async function () {
        const tx = await privateToken.connect(defaultSigner).transferOwnership(otherWallet.address);
        const receipt = await tx.wait();
        
        // Check that OwnershipTransferStarted event was emitted
        const event = receipt?.logs.find((log: any) => {
          try {
            const parsed = privateToken.interface.parseLog(log);
            return parsed?.name === "OwnershipTransferStarted";
          } catch {
            return false;
          }
        });
        expect(event).to.not.be.undefined;
      });

      it("should emit OwnershipTransferred event when transfer accepted", async function () {
        // First initiate transfer
        await (await privateToken.connect(defaultSigner).transferOwnership(otherWallet.address)).wait();
        
        // Accept ownership
        const tx = await privateToken.connect(otherWallet).acceptOwnership();
        const receipt = await tx.wait();

        // Check that OwnershipTransferred event was emitted
        const event = receipt?.logs.find((log: any) => {
          try {
            const parsed = privateToken.interface.parseLog(log);
            return parsed?.name === "OwnershipTransferred";
          } catch {
            return false;
          }
        });
        expect(event).to.not.be.undefined;

        // Verify ownership
        const owner = await privateToken.owner();
        expect(owner).to.equal(otherWallet.address);
      });

      it("should allow new owner to perform owner-only actions after transfer", async function () {
        // Transfer to otherWallet
        await (await privateToken.connect(defaultSigner).transferOwnership(otherWallet.address)).wait();
        await (await privateToken.connect(otherWallet).acceptOwnership()).wait();

        // Verify otherWallet is now owner
        const owner = await privateToken.owner();
        expect(owner).to.equal(otherWallet.address);

        // New owner should be able to initiate another transfer
        const tx = await privateToken.connect(otherWallet).transferOwnership(thirdWallet.address);
        await tx.wait();
        
        const pendingOwner = await privateToken.pendingOwner();
        expect(pendingOwner).to.equal(thirdWallet.address);
      });
    });

    describe("Negative Cases", function () {
      beforeEach(async function () {
        await ensureDefaultSignerIsOwner();
      });

      it("should revert when non-owner tries to transfer ownership", async function () {
        await expect(privateToken.connect(otherWallet).transferOwnership(thirdWallet.address))
          .to.be.revertedWithCustomError(privateToken, "OwnableUnauthorizedAccount")
          .withArgs(otherWallet.address);
      });

      it("should allow transferring ownership to zero address (2-step pattern)", async function () {
        // In Ownable2StepUpgradeable, transferring to zero address is allowed
        // It just sets the pending owner to zero - no one can accept it
        // This effectively cancels any pending transfer
        const tx = await privateToken.connect(defaultSigner).transferOwnership(hre.ethers.ZeroAddress);
        await tx.wait();
        
        const pendingOwner = await privateToken.pendingOwner();
        expect(pendingOwner).to.equal(hre.ethers.ZeroAddress);
      });

      it("should revert when non-pending owner tries to accept ownership", async function () {
        // First initiate a transfer to otherWallet
        await (await privateToken.connect(defaultSigner).transferOwnership(otherWallet.address)).wait();

        // thirdWallet tries to accept (not the pending owner)
        await expect(privateToken.connect(thirdWallet).acceptOwnership())
          .to.be.revertedWithCustomError(privateToken, "OwnableUnauthorizedAccount")
          .withArgs(thirdWallet.address);
      });

      it("should revert when old owner tries to perform owner actions after transfer", async function () {
        // Transfer ownership to otherWallet
        await (await privateToken.connect(defaultSigner).transferOwnership(otherWallet.address)).wait();
        await (await privateToken.connect(otherWallet).acceptOwnership()).wait();

        // Old owner (defaultSigner) tries to transfer ownership
        await expect(privateToken.connect(defaultSigner).transferOwnership(thirdWallet.address))
          .to.be.revertedWithCustomError(privateToken, "OwnableUnauthorizedAccount")
          .withArgs(defaultSigner.address);
      });
    });
  });

  // ============================================
  // 2. CONTRACT UPGRADE TESTS (UUPS)
  // ============================================
  describe("Contract Upgrade Tests", function () {
    let newImplementation: any;
    let newImplementationAddress: string;

    // Helper function to ensure defaultSigner is the owner before upgrade tests
    async function ensureDefaultSignerIsOwnerForUpgrade() {
      const currentOwner = await privateToken.owner();
      if (currentOwner !== defaultSigner.address) {
        // If otherWallet is owner, transfer back
        if (currentOwner === otherWallet.address) {
          await (await privateToken.connect(otherWallet).transferOwnership(defaultSigner.address)).wait();
          await (await privateToken.connect(defaultSigner).acceptOwnership()).wait();
        }
      }
    }

    before(async function () {
      // Deploy V2 implementation for upgrade tests
      console.log("🏗️ Deploying PrivateERC20Contract256V2 implementation for upgrade tests...");
      const V2ImplementationFactory = await hre.ethers.getContractFactory(
        "contracts/tests/PrivateERC20Contract256V2Dummy.sol:PrivateERC20Contract256V2",
        defaultSigner
      );
      newImplementation = await V2ImplementationFactory.deploy();
      await newImplementation.waitForDeployment();
      newImplementationAddress = await newImplementation.getAddress();
      console.log("✅ V2 Implementation deployed at:", newImplementationAddress);
    });

    describe("Positive Cases", function () {
      beforeEach(async function () {
        await ensureDefaultSignerIsOwnerForUpgrade();
      });

      it("should preserve state variables after upgrade", async function () {
        // Get state before upgrade
        const nameBefore = await privateToken.name();
        const symbolBefore = await privateToken.symbol();
        const decimalsBefore = await privateToken.decimals();
        const ownerBefore = await privateToken.owner();
        const masterBefore = await privateToken.master();

        // Perform upgrade to V2
        const tx = await privateToken.connect(defaultSigner).upgradeToAndCall(newImplementationAddress, "0x");
        await tx.wait();

        // Verify state is preserved
        const nameAfter = await privateToken.name();
        const symbolAfter = await privateToken.symbol();
        const decimalsAfter = await privateToken.decimals();
        const ownerAfter = await privateToken.owner();
        const masterAfter = await privateToken.master();

        expect(nameAfter).to.equal(nameBefore);
        expect(symbolAfter).to.equal(symbolBefore);
        expect(decimalsAfter).to.equal(decimalsBefore);
        expect(ownerAfter).to.equal(ownerBefore);
        expect(masterAfter).to.equal(masterBefore);
      });

      it("should have V2 functions available after upgrade", async function () {
        // Perform upgrade to V2
        await (await privateToken.connect(defaultSigner).upgradeToAndCall(newImplementationAddress, "0x")).wait();

        // Attach V2 interface to the proxy to access V2 functions
        const V2Factory = await hre.ethers.getContractFactory(
          "contracts/tests/PrivateERC20Contract256V2Dummy.sol:PrivateERC20Contract256V2",
          defaultSigner
        );
        const privateTokenV2 = V2Factory.attach(await privateToken.getAddress()) as any;

        // Verify V2 function exists and works
        const version = await privateTokenV2.getV2Version();
        expect(version).to.equal("V2.0.0");

        // Test the v2Add function
        const result = await privateTokenV2.v2Add(10, 20);
        expect(result).to.equal(30);

        // Test getV2DummyValue (should be 0 initially)
        const dummyValue = await privateTokenV2.getV2DummyValue();
        expect(dummyValue).to.equal(0);
      });

      it("should allow setting and getting V2 dummy value after upgrade", async function () {
        // Perform upgrade to V2
        await (await privateToken.connect(defaultSigner).upgradeToAndCall(newImplementationAddress, "0x")).wait();

        // Attach V2 interface to the proxy to access V2 functions
        const V2Factory = await hre.ethers.getContractFactory(
          "contracts/tests/PrivateERC20Contract256V2Dummy.sol:PrivateERC20Contract256V2",
          defaultSigner
        );
        const privateTokenV2 = V2Factory.attach(await privateToken.getAddress()) as any;

        // Set dummy value
        const testValue = 42;
        const tx = await privateTokenV2.connect(defaultSigner).setV2DummyValue(testValue);
        const receipt = await tx.wait();

        // Verify value was set
        const dummyValue = await privateTokenV2.getV2DummyValue();
        expect(dummyValue).to.equal(testValue);

        // Verify event was emitted
        const events = await privateTokenV2.queryFilter(
          privateTokenV2.filters.V2DummyValueSet(),
          receipt?.blockNumber,
          receipt?.blockNumber
        );
        expect(events.length).to.be.greaterThan(0);
        expect(events[0].args.oldValue).to.equal(0);
        expect(events[0].args.newValue).to.equal(testValue);
      });

      it("should preserve V2 state after multiple upgrades", async function () {
        // Upgrade to V2
        await (await privateToken.connect(defaultSigner).upgradeToAndCall(newImplementationAddress, "0x")).wait();

        // Attach V2 interface
        const V2Factory = await hre.ethers.getContractFactory(
          "contracts/tests/PrivateERC20Contract256V2Dummy.sol:PrivateERC20Contract256V2",
          defaultSigner
        );
        const privateTokenV2 = V2Factory.attach(await privateToken.getAddress()) as any;

        // Set a dummy value
        const testValue = 100;
        await (await privateTokenV2.connect(defaultSigner).setV2DummyValue(testValue)).wait();

        // Verify value was set
        let dummyValue = await privateTokenV2.getV2DummyValue();
        expect(dummyValue).to.equal(testValue);

        // Deploy another V2 instance
        const anotherV2 = await V2Factory.deploy();
        await anotherV2.waitForDeployment();

        // Upgrade to the new V2 instance
        await (await privateToken.connect(defaultSigner).upgradeToAndCall(
          await anotherV2.getAddress(),
          "0x"
        )).wait();

        // Re-attach V2 interface after upgrade
        const privateTokenV2After = V2Factory.attach(await privateToken.getAddress()) as any;

        // Verify V2 functions still work
        const version = await privateTokenV2After.getV2Version();
        expect(version).to.equal("V2.0.0");

        // Note: The dummy value persists because state variables are stored in the proxy's storage,
        // not in the implementation contract. This is the expected behavior - proxy storage persists
        // across upgrades, which is why we use ERC-7201 storage pattern for the main contract state.
        dummyValue = await privateTokenV2After.getV2DummyValue();
        expect(dummyValue).to.equal(testValue); // Value persists across upgrades
      });

      it("should emit Upgraded event on successful upgrade", async function () {
        // Deploy another new implementation
        const ImplementationFactory = await hre.ethers.getContractFactory(
          "contracts/PrivateERC20Contract256.sol:PrivateERC20Contract256",
          defaultSigner
        );
        const anotherImplementation = await ImplementationFactory.deploy();
        await anotherImplementation.waitForDeployment();
        const anotherImplementationAddress = await anotherImplementation.getAddress();

        // Upgrade and check for event
        const tx = await privateToken.connect(defaultSigner).upgradeToAndCall(anotherImplementationAddress, "0x");
        const receipt = await tx.wait();
        
        // Check that Upgraded event was emitted
        const upgradedEvent = receipt?.logs.find((log: any) => {
          try {
            const parsed = privateToken.interface.parseLog(log);
            return parsed?.name === "Upgraded";
          } catch {
            return false;
          }
        });
        expect(upgradedEvent).to.not.be.undefined;
      });

      it("should maintain proxy address after upgrade", async function () {
        const addressBefore = await privateToken.getAddress();

        // Deploy and upgrade to new implementation
        const ImplementationFactory = await hre.ethers.getContractFactory(
          "contracts/PrivateERC20Contract256.sol:PrivateERC20Contract256",
          defaultSigner
        );
        const yetAnotherImplementation = await ImplementationFactory.deploy();
        await yetAnotherImplementation.waitForDeployment();

        await (await privateToken.connect(defaultSigner).upgradeToAndCall(
          await yetAnotherImplementation.getAddress(),
          "0x"
        )).wait();

        const addressAfter = await privateToken.getAddress();
        expect(addressAfter).to.equal(addressBefore);
      });

      it("should preserve balances after upgrade", async function () {
        // First, shield some tokens to create a balance
        const shieldAmount = 100n * 10n ** 18n;
        
        // Mint mock tokens to user
        await (await mockToken.mint(defaultSigner.address, shieldAmount)).wait();
        await (await mockToken.approve(await privateToken.getAddress(), shieldAmount)).wait();
        await new Promise(resolve => setTimeout(resolve, 3000));

        // Get balance handle before shield
        const totalSupplyBefore = await privateToken.totalSupply();

        // Shield tokens
        await (await privateToken.shield(shieldAmount)).wait();
        await new Promise(resolve => setTimeout(resolve, 5000));

        // Verify total supply increased
        const totalSupplyAfterShield = await privateToken.totalSupply();
        expect(totalSupplyAfterShield).to.equal(totalSupplyBefore + shieldAmount);

        // Deploy new implementation and upgrade
        const ImplementationFactory = await hre.ethers.getContractFactory(
          "contracts/PrivateERC20Contract256.sol:PrivateERC20Contract256",
          defaultSigner
        );
        const upgradeImpl = await ImplementationFactory.deploy();
        await upgradeImpl.waitForDeployment();

        await (await privateToken.connect(defaultSigner).upgradeToAndCall(
          await upgradeImpl.getAddress(),
          "0x"
        )).wait();

        // Verify total supply is preserved after upgrade
        const totalSupplyAfterUpgrade = await privateToken.totalSupply();
        expect(totalSupplyAfterUpgrade).to.equal(totalSupplyAfterShield);
      });
    });

    describe("Negative Cases", function () {
      beforeEach(async function () {
        await ensureDefaultSignerIsOwnerForUpgrade();
      });

      it("should revert when non-owner tries to upgrade", async function () {
        const ImplementationFactory = await hre.ethers.getContractFactory(
          "contracts/PrivateERC20Contract256.sol:PrivateERC20Contract256",
          defaultSigner
        );
        const newImpl = await ImplementationFactory.deploy();
        await newImpl.waitForDeployment();

        await expect(
          privateToken.connect(otherWallet).upgradeToAndCall(await newImpl.getAddress(), "0x")
        ).to.be.revertedWithCustomError(privateToken, "OwnableUnauthorizedAccount")
          .withArgs(otherWallet.address);
      });

      it("should revert when upgrading to zero address", async function () {
        await expect(
          privateToken.connect(defaultSigner).upgradeToAndCall(hre.ethers.ZeroAddress, "0x")
        ).to.be.reverted;
      });

      it("should revert when upgrading to non-UUPS implementation", async function () {
        // Deploy a simple contract that doesn't implement UUPS
        const NonUUPSFactory = await hre.ethers.getContractFactory("TUSDC", defaultSigner);
        const nonUUPS = await NonUUPSFactory.deploy("NonUUPS", "NU");
        await nonUUPS.waitForDeployment();

        await expect(
          privateToken.connect(defaultSigner).upgradeToAndCall(await nonUUPS.getAddress(), "0x")
        ).to.be.reverted;
      });
    });
  });

  // ============================================
  // 3. INITIALIZER PROTECTION TESTS
  // ============================================
  describe("Initializer Protection Tests", function () {
    describe("Negative Cases", function () {
      it("should revert when calling initialize on implementation contract directly", async function () {
        // Deploy a fresh implementation
        const ImplementationFactory = await hre.ethers.getContractFactory(
          "contracts/PrivateERC20Contract256.sol:PrivateERC20Contract256",
          defaultSigner
        );
        const freshImplementation = await ImplementationFactory.deploy();
        await freshImplementation.waitForDeployment();

        // Try to call initialize directly on the implementation
        await expect(
          (freshImplementation as any).initialize(
            "Test",
            "TST",
            await mockToken.getAddress(),
            defaultSigner.address,
            defaultSigner.address
          )
        ).to.be.revertedWithCustomError(freshImplementation, "InvalidInitialization");
      });

      it("should revert when calling initialize twice on proxy", async function () {
        // Try to call initialize again on the already-initialized proxy
        await expect(
          privateToken.initialize(
            "NewName",
            "NEW",
            await mockToken.getAddress(),
            otherWallet.address,
            otherWallet.address
          )
        ).to.be.revertedWithCustomError(privateToken, "InvalidInitialization");
      });
    });
  });

  // ============================================
  // 4. PROXY FUNCTIONALITY TESTS
  // ============================================
  describe("Proxy Functionality Tests", function () {
    // Helper function to ensure defaultSigner is the owner
    async function ensureDefaultSignerIsOwnerForProxy() {
      const currentOwner = await privateToken.owner();
      if (currentOwner !== defaultSigner.address) {
        if (currentOwner === otherWallet.address) {
          await (await privateToken.connect(otherWallet).transferOwnership(defaultSigner.address)).wait();
          await (await privateToken.connect(defaultSigner).acceptOwnership()).wait();
        }
      }
    }

    describe("Positive Cases", function () {
      beforeEach(async function () {
        await ensureDefaultSignerIsOwnerForProxy();
      });

      it("should delegate all calls through proxy to implementation", async function () {
        // Verify basic getters work through the proxy
        const name = await privateToken.name();
        const symbol = await privateToken.symbol();
        const decimals = await privateToken.decimals();

        expect(name).to.equal("BubbleToken");
        expect(symbol).to.equal("BUB");
        expect(decimals).to.equal(18);
      });

      it("should allow reading state through proxy after upgrade", async function () {
        // Deploy new implementation
        const ImplementationFactory = await hre.ethers.getContractFactory(
          "contracts/PrivateERC20Contract256.sol:PrivateERC20Contract256",
          defaultSigner
        );
        const newImpl = await ImplementationFactory.deploy();
        await newImpl.waitForDeployment();

        // Upgrade
        await (await privateToken.connect(defaultSigner).upgradeToAndCall(
          await newImpl.getAddress(),
          "0x"
        )).wait();

        // Read state through proxy
        const name = await privateToken.name();
        const symbol = await privateToken.symbol();
        const owner = await privateToken.owner();
        const totalSupply = await privateToken.totalSupply();

        expect(name).to.equal("BubbleToken");
        expect(symbol).to.equal("BUB");
        expect(owner).to.equal(defaultSigner.address);
        expect(totalSupply).to.be.gte(0);
      });

      it("should maintain contract functionality after multiple upgrades", async function () {
        const ImplementationFactory = await hre.ethers.getContractFactory(
          "contracts/PrivateERC20Contract256.sol:PrivateERC20Contract256",
          defaultSigner
        );

        // Perform multiple upgrades
        for (let i = 0; i < 3; i++) {
          const newImpl = await ImplementationFactory.deploy();
          await newImpl.waitForDeployment();

          await (await privateToken.connect(defaultSigner).upgradeToAndCall(
            await newImpl.getAddress(),
            "0x"
          )).wait();

          // Verify functionality still works
          const name = await privateToken.name();
          const symbol = await privateToken.symbol();
          expect(name).to.equal("BubbleToken");
          expect(symbol).to.equal("BUB");
        }
      });
    });
  });
});

