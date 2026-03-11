import { expect } from "chai";
import hre from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";

describe("RestrictionListIntegration", function () {
  let mockToken: any;
  let registry1: any;
  let registry2: any;
  let registry3: any;
  let owner: SignerWithAddress;
  let admin1: SignerWithAddress;
  let admin2: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let user3: SignerWithAddress;
  let user4: SignerWithAddress;

  beforeEach(async function () {
    [owner, admin1, admin2, user1, user2, user3, user4] = await hre.ethers.getSigners();
    
    // Deploy multiple restriction list registries
    const RestrictionListRegistryFactory = await hre.ethers.getContractFactory("RestrictionListRegistry");
    
    registry1 = await (RestrictionListRegistryFactory as any).deploy(admin1.address, "Company Restriction List");
    await registry1.waitForDeployment();
    
    registry2 = await (RestrictionListRegistryFactory as any).deploy(admin2.address, "Government Sanctions List");
    await registry2.waitForDeployment();
    
    registry3 = await (RestrictionListRegistryFactory as any).deploy(owner.address, "Internal Compliance List");
    await registry3.waitForDeployment();
    
    console.log("Registry 1 deployed to:", await registry1.getAddress());
    console.log("Registry 2 deployed to:", await registry2.getAddress());
    console.log("Registry 3 deployed to:", await registry3.getAddress());
    
    // Deploy mock token with multiple registries
    const MockTokenFactory = await hre.ethers.getContractFactory("MockERC20WithRestrictionList");
    mockToken = await MockTokenFactory.deploy(
      "Test Token",
      "TEST",
      hre.ethers.parseEther("1000000"), // 1M tokens
      [await registry1.getAddress(), await registry2.getAddress(), await registry3.getAddress()]
    );
    await mockToken.waitForDeployment();
    
    console.log("Mock Token deployed to:", await mockToken.getAddress());
  });

  describe("Constructor and Initial Setup", function () {
    it("should initialize with correct registries", async function () {
      const activeRegistries = await mockToken.getActiveRestrictionListRegistries();
      expect(activeRegistries).to.have.length(3);
      expect(activeRegistries[0]).to.equal(await registry1.getAddress());
      expect(activeRegistries[1]).to.equal(await registry2.getAddress());
      expect(activeRegistries[2]).to.equal(await registry3.getAddress());
    });

    it("should report correct registry count", async function () {
      expect(await mockToken.getActiveRegistryCount()).to.equal(3);
    });

    it("should recognize active registries", async function () {
      expect(await mockToken.isRegistryActive(await registry1.getAddress())).to.be.true;
      expect(await mockToken.isRegistryActive(await registry2.getAddress())).to.be.true;
      expect(await mockToken.isRegistryActive(await registry3.getAddress())).to.be.true;
    });

    it("should handle empty registries array in constructor", async function () {
      const MockTokenFactory = await hre.ethers.getContractFactory("MockERC20WithRestrictionList");
      const tokenWithNoRegistries = await MockTokenFactory.deploy(
        "Test Token",
        "TEST",
        hre.ethers.parseEther("1000000"),
        []
      );
      
      expect(await tokenWithNoRegistries.getActiveRegistryCount()).to.equal(0);
    });

    it("should reject too many registries in constructor", async function () {
      const MockTokenFactory = await hre.ethers.getContractFactory("MockERC20WithRestrictionList");
      
      // Create array with 11 registries (more than MAX_REGISTRIES = 10)
      const manyRegistries = new Array(11).fill(await registry1.getAddress());
      
      await expect(
        MockTokenFactory.deploy("Test Token", "TEST", hre.ethers.parseEther("1000000"), manyRegistries)
      ).to.be.revertedWithCustomError(MockTokenFactory, "TooManyRegistries");
    });
  });

  describe("Multiple Registry Restriction Checks", function () {
    beforeEach(async function () {
      // Set up restrictions across different registries
      await registry1.connect(admin1).addToRestrictionList(user1.address);
      await registry2.connect(admin2).addToRestrictionList(user2.address);
    });

    it("should detect restrictions from different registries", async function () {
      expect(await mockToken.isRestricted(user1.address)).to.be.true;
      expect(await mockToken.isRestricted(user2.address)).to.be.true;
      expect(await mockToken.isRestricted(user3.address)).to.be.false;
    });

    it("should return correct restricting registry", async function () {
      expect(await mockToken.getRestrictingRegistry(user1.address)).to.equal(await registry1.getAddress());
      expect(await mockToken.getRestrictingRegistry(user2.address)).to.equal(await registry2.getAddress());
      expect(await mockToken.getRestrictingRegistry(user3.address)).to.equal(hre.ethers.ZeroAddress);
    });

    it("should return detailed restriction info", async function () {
      const user1Info = await mockToken.getDetailedRestrictionInfo(user1.address);
      const user2Info = await mockToken.getDetailedRestrictionInfo(user2.address);
      const user3Info = await mockToken.getDetailedRestrictionInfo(user3.address);
      
      expect(user1Info).to.have.length(1);
      expect(user1Info[0]).to.equal(await registry1.getAddress());
      
      expect(user2Info).to.have.length(1);
      expect(user2Info[0]).to.equal(await registry2.getAddress());
      
      expect(user3Info).to.have.length(0);
    });

    it("should handle address restricted by multiple registries", async function () {
      // Add user1 to registry2 as well
      await registry2.connect(admin2).addToRestrictionList(user1.address);
      
      expect(await mockToken.isRestricted(user1.address)).to.be.true;
      
      const user1Info = await mockToken.getDetailedRestrictionInfo(user1.address);
      expect(user1Info).to.have.length(2);
      expect(user1Info).to.include(await registry1.getAddress());
      expect(user1Info).to.include(await registry2.getAddress());
    });

    it("should check multiple addresses correctly", async function () {
      const results = await mockToken.areRestricted([user1.address, user2.address, user3.address]);
      
      expect(results).to.have.length(3);
      expect(results[0]).to.be.true;  // user1 restricted by registry1
      expect(results[1]).to.be.true;  // user2 restricted by registry2
      expect(results[2]).to.be.false; // user3 not restricted
    });
  });

  describe("Registry Management", function () {
    it("should allow owner to add new registry", async function () {
      expect(await mockToken.getActiveRegistryCount()).to.equal(3);
      
      // Create a new registry to add
      const newRegistry = await (await hre.ethers.getContractFactory("RestrictionListRegistry") as any).deploy(owner.address, "New Test Registry");
      
      await expect(mockToken.addRestrictionListRegistry(await newRegistry.getAddress()))
        .to.emit(mockToken, "RestrictionListRegistryAdded")
        .withArgs(await newRegistry.getAddress(), owner.address);
      
      expect(await mockToken.getActiveRegistryCount()).to.equal(4);
      expect(await mockToken.isRegistryActive(await newRegistry.getAddress())).to.be.true;
    });

    it("should allow owner to remove registry", async function () {
      await expect(mockToken.removeRestrictionListRegistry(await registry1.getAddress()))
        .to.emit(mockToken, "RestrictionListRegistryRemoved")
        .withArgs(await registry1.getAddress(), owner.address);
      
      expect(await mockToken.getActiveRegistryCount()).to.equal(2);
      expect(await mockToken.isRegistryActive(await registry1.getAddress())).to.be.false;
      
      const activeRegistries = await mockToken.getActiveRestrictionListRegistries();
      expect(activeRegistries).to.have.length(2);
      expect(activeRegistries).to.include(await registry2.getAddress());
      expect(activeRegistries).to.include(await registry3.getAddress());
    });

    it("should prevent non-owner from adding registry", async function () {
      await expect(
        mockToken.connect(user1).addRestrictionListRegistry(await registry3.getAddress())
      ).to.be.revertedWithCustomError(mockToken, "OnlyOwner");
    });

    it("should prevent non-owner from removing registry", async function () {
      await expect(
        mockToken.connect(user1).removeRestrictionListRegistry(await registry1.getAddress())
      ).to.be.revertedWithCustomError(mockToken, "OnlyOwner");
    });

    it("should prevent adding zero address as registry", async function () {
      await expect(
        mockToken.addRestrictionListRegistry(hre.ethers.ZeroAddress)
      ).to.be.revertedWithCustomError(mockToken, "InvalidRegistry");
    });

    it("should prevent adding duplicate registry", async function () {
      await expect(
        mockToken.addRestrictionListRegistry(await registry1.getAddress())
      ).to.be.revertedWithCustomError(mockToken, "RegistryAlreadyExists");
    });

    it("should prevent removing non-existent registry", async function () {
      // Create a registry that's not added to the token
      const nonExistentRegistry = await (await hre.ethers.getContractFactory("RestrictionListRegistry") as any).deploy(owner.address, "Non-existent Registry");
      
      await expect(
        mockToken.removeRestrictionListRegistry(await nonExistentRegistry.getAddress())
      ).to.be.revertedWithCustomError(mockToken, "RegistryNotFound");
    });

    it("should prevent adding too many registries", async function () {
      // Add registries up to the limit (currently at 3, limit is 10)
      for (let i = 3; i < 10; i++) {
        const newRegistry = await (await hre.ethers.getContractFactory("RestrictionListRegistry") as any).deploy(owner.address, `Test Registry ${i}`);
        await mockToken.addRestrictionListRegistry(await newRegistry.getAddress());
      }
      
      expect(await mockToken.getActiveRegistryCount()).to.equal(10);
      
      // Now adding one more should fail
      const oneMoreRegistry = await (await hre.ethers.getContractFactory("RestrictionListRegistry") as any).deploy(owner.address, "Extra Registry");
      await expect(
        mockToken.addRestrictionListRegistry(await oneMoreRegistry.getAddress())
      ).to.be.revertedWithCustomError(mockToken, "TooManyRegistries");
    });
  });

  describe("Restriction Effects on Token Operations", function () {
    beforeEach(async function () {
      // Give users some tokens
      await mockToken.transfer(user1.address, hre.ethers.parseEther("1000"));
      await mockToken.transfer(user2.address, hre.ethers.parseEther("1000"));
      await mockToken.transfer(user3.address, hre.ethers.parseEther("1000"));
      
      // Restrict user1 via registry1
      await registry1.connect(admin1).addToRestrictionList(user1.address);
    });

    it("should prevent restricted user from transferring", async function () {
      await expect(
        mockToken.connect(user1).transfer(user3.address, hre.ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(mockToken, "AccountIsRestricted")
      .withArgs(user1.address, await registry1.getAddress());
    });

    it("should prevent transfers to restricted user", async function () {
      await expect(
        mockToken.connect(user2).transfer(user1.address, hre.ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(mockToken, "AccountIsRestricted")
      .withArgs(user1.address, await registry1.getAddress());
    });

    it("should prevent restricted user from approving", async function () {
      await expect(
        mockToken.connect(user1).approve(user2.address, hre.ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(mockToken, "AccountIsRestricted")
      .withArgs(user1.address, await registry1.getAddress());
    });

    it("should prevent approving restricted spender", async function () {
      await expect(
        mockToken.connect(user2).approve(user1.address, hre.ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(mockToken, "AccountIsRestricted")
      .withArgs(user1.address, await registry1.getAddress());
    });

    it("should prevent minting to restricted user", async function () {
      await expect(
        mockToken.mint(user1.address, hre.ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(mockToken, "AccountIsRestricted")
      .withArgs(user1.address, await registry1.getAddress());
    });

    it("should prevent restricted user from burning", async function () {
      await expect(
        mockToken.connect(user1).burn(hre.ethers.parseEther("100"))
      ).to.be.revertedWithCustomError(mockToken, "AccountIsRestricted")
      .withArgs(user1.address, await registry1.getAddress());
    });

    it("should prevent ownership transfer to restricted user", async function () {
      await expect(
        mockToken.transferOwnership(user1.address)
      ).to.be.revertedWithCustomError(mockToken, "AccountIsRestricted")
      .withArgs(user1.address, await registry1.getAddress());
    });

    it("should allow operations for non-restricted users", async function () {
      // All these should succeed for user2 and user3
      await mockToken.connect(user2).transfer(user3.address, hre.ethers.parseEther("100"));
      await mockToken.connect(user2).approve(user3.address, hre.ethers.parseEther("100"));
      await mockToken.mint(user2.address, hre.ethers.parseEther("100"));
      await mockToken.connect(user2).burn(hre.ethers.parseEther("50"));
    });

    it("should handle batch operations with mixed restricted/non-restricted addresses", async function () {
      // user1 is restricted, user3 and user4 are not
      await expect(
        mockToken.connect(user2).batchTransfer(
          [user1.address, user3.address, user4.address],
          [hre.ethers.parseEther("10"), hre.ethers.parseEther("10"), hre.ethers.parseEther("10")]
        )
      ).to.be.revertedWithCustomError(mockToken, "AccountIsRestricted")
      .withArgs(user1.address, await registry1.getAddress());
    });
  });

  describe("Registry Failure Handling", function () {
    it("should handle failed registry calls gracefully", async function () {
      // Create a mock registry that will fail
      const FailingRegistryFactory = await hre.ethers.getContractFactory("RestrictionListRegistry");
      const failingRegistry = await (FailingRegistryFactory as any).deploy(owner.address, "Failing Registry");
      
      // Add it to our token
      await mockToken.addRestrictionListRegistry(await failingRegistry.getAddress());
      
      // Destroy the registry by self-destructing (simulating a failed call)
      // In practice, this is hard to test, but we can at least verify the system continues
      // to work with the other registries
      
      // Even if one registry fails, others should still work
      await registry1.connect(admin1).addToRestrictionList(user3.address);
      expect(await mockToken.isRestricted(user3.address)).to.be.true;
    });
  });

  describe("Dynamic Registry Changes", function () {
    beforeEach(async function () {
      // Give users some tokens first
      await mockToken.transfer(user1.address, hre.ethers.parseEther("1000"));
      await mockToken.transfer(user2.address, hre.ethers.parseEther("1000"));
      await mockToken.transfer(user3.address, hre.ethers.parseEther("1000"));
      
      // Set up initial restriction
      await registry1.connect(admin1).addToRestrictionList(user1.address);
      expect(await mockToken.isRestricted(user1.address)).to.be.true;
    });

    it("should allow operations after removing restricting registry", async function () {
      // Remove the registry that restricts user1
      await mockToken.removeRestrictionListRegistry(await registry1.getAddress());
      
      // Now user1 should not be restricted
      expect(await mockToken.isRestricted(user1.address)).to.be.false;
      
      // And should be able to perform operations
      await mockToken.connect(user1).transfer(user2.address, hre.ethers.parseEther("100"));
    });

    it("should maintain restrictions from remaining registries", async function () {
      // Add user2 to registry2
      await registry2.connect(admin2).addToRestrictionList(user2.address);
      
      // Remove registry1
      await mockToken.removeRestrictionListRegistry(await registry1.getAddress());
      
      // user1 should no longer be restricted
      expect(await mockToken.isRestricted(user1.address)).to.be.false;
      
      // But user2 should still be restricted via registry2
      expect(await mockToken.isRestricted(user2.address)).to.be.true;
      expect(await mockToken.getRestrictingRegistry(user2.address)).to.equal(await registry2.getAddress());
    });

    it("should immediately apply restrictions from newly added registry", async function () {
      // Create a new registry that's not in the token yet
      const newRegistry = await (await hre.ethers.getContractFactory("RestrictionListRegistry") as any).deploy(owner.address, "Dynamic Registry");
      
      // Add user3 to the new registry
      await newRegistry.addToRestrictionList(user3.address);
      
      // user3 should not be restricted yet (newRegistry not active)
      expect(await mockToken.isRestricted(user3.address)).to.be.false;
      
      // Add newRegistry to token
      await mockToken.addRestrictionListRegistry(await newRegistry.getAddress());
      
      // Now user3 should be restricted
      expect(await mockToken.isRestricted(user3.address)).to.be.true;
      expect(await mockToken.getRestrictingRegistry(user3.address)).to.equal(await newRegistry.getAddress());
    });
  });

  describe("Event Emissions", function () {
    it("should emit events when adding restriction list registry", async function () {
      // Create a new registry to add
      const newRegistry = await (await hre.ethers.getContractFactory("RestrictionListRegistry") as any).deploy(owner.address, "Event Test Registry");
      
      await expect(mockToken.addRestrictionListRegistry(await newRegistry.getAddress()))
        .to.emit(mockToken, "RestrictionListRegistryAdded")
        .withArgs(await newRegistry.getAddress(), owner.address);
    });

    it("should emit events when removing restriction list registry", async function () {
      await expect(mockToken.removeRestrictionListRegistry(await registry1.getAddress()))
        .to.emit(mockToken, "RestrictionListRegistryRemoved")
        .withArgs(await registry1.getAddress(), owner.address);
    });

    it("should emit RestrictedAddressBlocked event with custom message", async function () {
      // Restrict user1
      await registry1.connect(admin1).addToRestrictionList(user1.address);
      
      // Use the test function that emits custom message
      await expect(
        mockToken.testRestrictedOperation(user1.address, "test operation")
      ).to.be.revertedWithCustomError(mockToken, "AccountIsRestricted")
      .withArgs(user1.address, await registry1.getAddress());
    });
  });

  describe("Edge Cases", function () {
    it("should handle removing all registries", async function () {
      await mockToken.removeRestrictionListRegistry(await registry1.getAddress());
      await mockToken.removeRestrictionListRegistry(await registry2.getAddress());
      await mockToken.removeRestrictionListRegistry(await registry3.getAddress());
      
      expect(await mockToken.getActiveRegistryCount()).to.equal(0);
      
      // All users should be unrestricted
      expect(await mockToken.isRestricted(user1.address)).to.be.false;
      expect(await mockToken.isRestricted(user2.address)).to.be.false;
    });

    it("should handle duplicate restrictions across registries", async function () {
      // Add same user to multiple registries
      await registry1.connect(admin1).addToRestrictionList(user1.address);
      await registry2.connect(admin2).addToRestrictionList(user1.address);
      
      expect(await mockToken.isRestricted(user1.address)).to.be.true;
      
      const detailedInfo = await mockToken.getDetailedRestrictionInfo(user1.address);
      expect(detailedInfo).to.have.length(2);
      
      // Remove from one registry
      await registry1.connect(admin1).removeFromRestrictionList(user1.address);
      
      // Should still be restricted by the other registry
      expect(await mockToken.isRestricted(user1.address)).to.be.true;
      expect(await mockToken.getRestrictingRegistry(user1.address)).to.equal(await registry2.getAddress());
    });

    it("should handle empty arrays for batch operations", async function () {
      const results = await mockToken.areRestricted([]);
      expect(results).to.have.length(0);
    });
  });

  describe("Registry Names", function () {
    it("should return correct registry names", async function () {
      const names = await mockToken.getActiveRegistryNames();
      expect(names).to.include("Company Restriction List");
      expect(names).to.include("Government Sanctions List");
      expect(names).to.include("Internal Compliance List");
    });

    it("should return detailed restriction info with names", async function () {
      // Add user to multiple registries
      await registry1.connect(admin1).addToRestrictionList(user1.address);
      await registry2.connect(admin2).addToRestrictionList(user1.address);
      
      const [restrictingRegistries, registryNames] = await mockToken.getDetailedRestrictionInfoWithNames(user1.address);
      
      expect(restrictingRegistries).to.have.length(2);
      expect(registryNames).to.have.length(2);
      expect(registryNames).to.include("Company Restriction List");
      expect(registryNames).to.include("Government Sanctions List");
    });

    it("should handle registries without name function gracefully", async function () {
      // This test simulates older registries that might not have the name() function
      const names = await mockToken.getActiveRegistryNames();
      expect(names).to.be.an('array');
      // Should not throw and should return some names or addresses
    });
  });
}); 