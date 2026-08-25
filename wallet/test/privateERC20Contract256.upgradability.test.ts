import { expect } from "chai";
import hre from "hardhat";
import { HDNodeWallet } from "ethers";
import dotenv from "dotenv";

import {
  DELAY_BALANCE_SYNC_MS,
  DELAY_STANDARD_MS,
  delay,
  deployMockToken,
  deployPrivateToken,
  deployPrivateTokenImplementation,
  fundWalletsForGas,
  findParsedLogInReceipt,
  getEventsInReceiptBlock,
  mintAndApprove,
  skipUnlessBubbleNetwork,
} from "./helpers/testHelpers";

dotenv.config();

const MNEMONIC = process.env.MNEMONIC;

const V2_DUMMY_FQN = "contracts/tests/PrivateERC20Contract256V2Dummy.sol:PrivateERC20Contract256V2";

describe("PrivateERC20Contract256 Upgradability", function () {
  before(async function () {
    await skipUnlessBubbleNetwork(this);
  });

  this.timeout(120000); // 2 minutes timeout for operations

  let privateToken: any;
  let mockToken: any;
  let defaultSigner: any;
  let otherWallet: HDNodeWallet;
  let thirdWallet: HDNodeWallet;

  before(async function () {
    const signers = await hre.ethers.getSigners();
    defaultSigner = signers[0];

    // Create other wallets for testing
    otherWallet = hre.ethers.Wallet.fromPhrase(MNEMONIC!).deriveChild(1).connect(hre.ethers.provider);
    thirdWallet = hre.ethers.Wallet.fromPhrase(MNEMONIC!).deriveChild(2).connect(hre.ethers.provider);

    // Fund the other wallets with ETH for gas
    const fundAmount = hre.ethers.parseEther("0.1");

    await fundWalletsForGas({
      sender: defaultSigner,
      recipients: [otherWallet.address, thirdWallet.address],
      amountWei: fundAmount,
    });

    mockToken = await deployMockToken(hre, defaultSigner);
    await delay(DELAY_STANDARD_MS);

    privateToken = await deployPrivateToken(hre, defaultSigner, {
      underlyingAddress: await mockToken.getAddress(),
      ownerAddress: defaultSigner.address,
      masterAddress: defaultSigner.address,
    });
  });

  /** Reset Ownable2Step: defaultSigner is owner and no pending transfer. */
  async function ensureDefaultSignerIsOwner() {
    const currentOwner = await privateToken.owner();
    if (currentOwner !== defaultSigner.address) {
      if (currentOwner === otherWallet.address) {
        await (await privateToken.connect(otherWallet).transferOwnership(defaultSigner.address)).wait();
        await (await privateToken.connect(defaultSigner).acceptOwnership()).wait();
      }
    }
    const pendingOwner = await privateToken.pendingOwner();
    if (pendingOwner !== hre.ethers.ZeroAddress) {
      await (await privateToken.connect(defaultSigner).transferOwnership(hre.ethers.ZeroAddress)).wait();
    }
  }

  async function getV2Factory() {
    return hre.ethers.getContractFactory(V2_DUMMY_FQN, defaultSigner);
  }

  async function attachV2AtProxy() {
    const V2Factory = await getV2Factory();
    return V2Factory.attach(await privateToken.getAddress()) as any;
  }

  // ============================================
  // 1. OWNERSHIP TESTS (Ownable2StepUpgradeable)
  // ============================================
  describe("Ownership Tests", function () {
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

        const event = findParsedLogInReceipt(receipt, privateToken, "OwnershipTransferStarted");
        expect(event).to.not.be.undefined;
      });

      it("should emit OwnershipTransferred event when transfer accepted", async function () {
        // First initiate transfer
        await (await privateToken.connect(defaultSigner).transferOwnership(otherWallet.address)).wait();
        
        // Accept ownership
        const tx = await privateToken.connect(otherWallet).acceptOwnership();
        const receipt = await tx.wait();

        const event = findParsedLogInReceipt(receipt, privateToken, "OwnershipTransferred");
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

    before(async function () {
      const V2ImplementationFactory = await getV2Factory();
      newImplementation = await V2ImplementationFactory.deploy();
      await newImplementation.waitForDeployment();
      newImplementationAddress = await newImplementation.getAddress();
    });

    describe("Positive Cases", function () {
      beforeEach(async function () {
        await ensureDefaultSignerIsOwner();
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
        await (await privateToken.connect(defaultSigner).upgradeToAndCall(newImplementationAddress, "0x")).wait();

        const privateTokenV2 = await attachV2AtProxy();

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
        await (await privateToken.connect(defaultSigner).upgradeToAndCall(newImplementationAddress, "0x")).wait();

        const privateTokenV2 = await attachV2AtProxy();

        const testValue = 42;
        const tx = await privateTokenV2.connect(defaultSigner).setV2DummyValue(testValue);
        const receipt = await tx.wait();

        const dummyValue = await privateTokenV2.getV2DummyValue();
        expect(dummyValue).to.equal(testValue);

        const events = await getEventsInReceiptBlock(
          privateTokenV2,
          privateTokenV2.filters.V2DummyValueSet(),
          receipt
        );
        expect(events.length).to.be.greaterThan(0);
        expect(events[0].args.oldValue).to.equal(0);
        expect(events[0].args.newValue).to.equal(testValue);
      });

      it("should preserve V2 state after multiple upgrades", async function () {
        await (await privateToken.connect(defaultSigner).upgradeToAndCall(newImplementationAddress, "0x")).wait();

        const V2Factory = await getV2Factory();
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
        const anotherImplementation = await deployPrivateTokenImplementation(hre, defaultSigner);
        const anotherImplementationAddress = await anotherImplementation.getAddress();

        // Upgrade and check for event
        const tx = await privateToken.connect(defaultSigner).upgradeToAndCall(anotherImplementationAddress, "0x");
        const receipt = await tx.wait();

        const upgradedEvent = findParsedLogInReceipt(receipt, privateToken, "Upgraded");
        expect(upgradedEvent).to.not.be.undefined;
      });

      it("should maintain proxy address after upgrade", async function () {
        const addressBefore = await privateToken.getAddress();

        const yetAnotherImplementation = await deployPrivateTokenImplementation(hre, defaultSigner);

        await (await privateToken.connect(defaultSigner).upgradeToAndCall(
          await yetAnotherImplementation.getAddress(),
          "0x"
        )).wait();

        const addressAfter = await privateToken.getAddress();
        expect(addressAfter).to.equal(addressBefore);
      });

      it("should preserve balances after upgrade", async function () {
        const shieldAmount = 100n * 10n ** 18n;

        await mintAndApprove({
          mockToken,
          privateToken,
          userAddress: defaultSigner.address,
          amount: shieldAmount,
        });

        const totalSupplyBefore = await privateToken.totalSupply();

        await (await privateToken.shield(shieldAmount)).wait();
        await delay(DELAY_BALANCE_SYNC_MS);

        const totalSupplyAfterShield = await privateToken.totalSupply();
        expect(totalSupplyAfterShield).to.equal(totalSupplyBefore + shieldAmount);

        const upgradeImpl = await deployPrivateTokenImplementation(hre, defaultSigner);

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
        await ensureDefaultSignerIsOwner();
      });

      it("should revert when non-owner tries to upgrade", async function () {
        const newImpl = await deployPrivateTokenImplementation(hre, defaultSigner);

        await expect(
          privateToken.connect(otherWallet).upgradeToAndCall(await newImpl.getAddress(), "0x")
        ).to.be.revertedWithCustomError(privateToken, "OwnableUnauthorizedAccount")
          .withArgs(otherWallet.address);
      });

      it("should revert when upgrading to zero address", async function () {
        // Reverting calls fail eth_estimateGas without an explicit gasLimit.
        const tx = await privateToken.connect(defaultSigner).upgradeToAndCall(
          hre.ethers.ZeroAddress,
          "0x",
          { gasLimit: 500_000n }
        );
        try {
          const receipt = await tx.wait();
          expect(receipt?.status).to.equal(0);
        } catch (e: any) {
          // ethers v6: wait() often throws CALL_EXCEPTION for mined reverts; receipt.status === 0 is still attached
          const st = e?.receipt?.status;
          if (e?.code === "CALL_EXCEPTION" && st != null && Number(st) === 0) {
            return;
          }
          throw e;
        }
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
        const freshImplementation = await deployPrivateTokenImplementation(hre, defaultSigner);

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
    describe("Positive Cases", function () {
      beforeEach(async function () {
        await ensureDefaultSignerIsOwner();
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
        const newImpl = await deployPrivateTokenImplementation(hre, defaultSigner);

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
        for (let i = 0; i < 3; i++) {
          const newImpl = await deployPrivateTokenImplementation(hre, defaultSigner);

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
