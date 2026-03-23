import { expect } from "chai";
import hre from "hardhat";
import { SignerWithAddress } from "@nomicfoundation/hardhat-ethers/signers";
import { expectReverted, waitForCondition } from "./testUtils";

describe("RestrictionListRegistry", function () {
  this.timeout(180000);
  let restrictionListRegistry: any;
  let owner: SignerWithAddress;
  let user1: SignerWithAddress;
  let user2: SignerWithAddress;
  let user3: SignerWithAddress;
  let nonOwner: SignerWithAddress;

  beforeEach(async function () {
    [owner, user1, user2, user3, nonOwner] = await hre.ethers.getSigners();
    
    const RestrictionListRegistryFactory = await hre.ethers.getContractFactory("RestrictionListRegistry");
    restrictionListRegistry = await (RestrictionListRegistryFactory as any).deploy(owner.address, "Test Restriction List");
    await restrictionListRegistry.waitForDeployment();
    
    console.log("RestrictionListRegistry deployed to:", await restrictionListRegistry.getAddress());
  });

  describe("Deployment", function () {
    it("should set the correct owner", async function () {
      expect(await restrictionListRegistry.owner()).to.equal(owner.address);
    });

    it("should start with empty restriction list", async function () {
      expect(await restrictionListRegistry.restrictionListCount()).to.equal(0);
    });

    it("should have the correct name", async function () {
      expect(await restrictionListRegistry.name()).to.equal("Test Restriction List");
    });

    it("should not restrict any address initially", async function () {
      expect(await restrictionListRegistry.isRestricted(user1.address)).to.be.false;
      expect(await restrictionListRegistry.isRestricted(user2.address)).to.be.false;
    });

    it("should revert if deployed with zero address as owner", async function () {
      const RestrictionListRegistryFactory = await hre.ethers.getContractFactory("RestrictionListRegistry");
      await expect(
        (RestrictionListRegistryFactory as any).deploy(hre.ethers.ZeroAddress, "Test List")
      ).to.be.revertedWithCustomError(RestrictionListRegistryFactory, "OwnableInvalidOwner");
    });
  });

  describe("Single Address Operations", function () {
    describe("Adding single address", function () {
      it("should allow owner to add an address to restriction list", async function () {
        const tx = await restrictionListRegistry.addToRestrictionList(user1.address);
        await tx.wait();

        expect(await restrictionListRegistry.isRestricted(user1.address)).to.be.true;
        expect(await restrictionListRegistry.restrictionListCount()).to.equal(1);
      });

      it("should emit AddedToRestrictionList event when adding address", async function () {
        const tx = await restrictionListRegistry.addToRestrictionList(user1.address);
        const receipt = await tx.wait();
        const hasAddedEvent = receipt?.logs.some((log: any) => {
          try {
            const parsed = restrictionListRegistry.interface.parseLog(log);
            return parsed?.name === "AddedToRestrictionList" &&
              parsed?.args?.account === user1.address &&
              parsed?.args?.admin === owner.address;
          } catch {
            return false;
          }
        });
        expect(hasAddedEvent).to.equal(true);
      });

      it("should revert when non-owner tries to add address", async function () {
        await expectReverted(restrictionListRegistry.connect(nonOwner).addToRestrictionList(user1.address));
      });

      it("should revert when trying to add zero address", async function () {
        await expectReverted(restrictionListRegistry.addToRestrictionList(hre.ethers.ZeroAddress));
      });

      it("should revert when trying to add owner address", async function () {
        await expectReverted(restrictionListRegistry.addToRestrictionList(owner.address));
      });

      it.only("should revert when trying to add already restricted address", async function () {
        await (await restrictionListRegistry.addToRestrictionList(user1.address)).wait();
        await waitForCondition(async () => restrictionListRegistry.isRestricted(user1.address));
        await expectReverted(restrictionListRegistry.addToRestrictionList(user1.address));
      });
    });

    describe("Removing single address", function () {
      beforeEach(async function () {
        // Add user1 to restriction list for removal tests
        await (await restrictionListRegistry.addToRestrictionList(user1.address)).wait();
        await waitForCondition(async () => restrictionListRegistry.isRestricted(user1.address));
      });

      it("should allow owner to remove an address from restriction list", async function () {
        const tx = await restrictionListRegistry.removeFromRestrictionList(user1.address);
        await tx.wait();

        expect(await restrictionListRegistry.isRestricted(user1.address)).to.be.false;
        expect(await restrictionListRegistry.restrictionListCount()).to.equal(0);
      });

      it("should emit RemovedFromRestrictionList event when removing address", async function () {
        const tx = await restrictionListRegistry.removeFromRestrictionList(user1.address);
        const receipt = await tx.wait();
        const hasRemovedEvent = receipt?.logs.some((log: any) => {
          try {
            const parsed = restrictionListRegistry.interface.parseLog(log);
            return parsed?.name === "RemovedFromRestrictionList" &&
              parsed?.args?.account === user1.address &&
              parsed?.args?.admin === owner.address;
          } catch {
            return false;
          }
        });
        expect(hasRemovedEvent).to.equal(true);
      });

      it("should revert when non-owner tries to remove address", async function () {
        await expectReverted(restrictionListRegistry.connect(nonOwner).removeFromRestrictionList(user1.address));
      });

      it("should revert when trying to remove non-restricted address", async function () {
        await expectReverted(restrictionListRegistry.removeFromRestrictionList(user2.address));
      });
    });
  });

  describe("Batch Operations", function () {
    describe("Adding multiple addresses", function () {
      it("should allow owner to add multiple addresses", async function () {
        const addresses = [user1.address, user2.address, user3.address];
        const tx = await restrictionListRegistry.addMultipleToRestrictionList(addresses);
        await tx.wait();

        expect(await restrictionListRegistry.isRestricted(user1.address)).to.be.true;
        expect(await restrictionListRegistry.isRestricted(user2.address)).to.be.true;
        expect(await restrictionListRegistry.isRestricted(user3.address)).to.be.true;
        expect(await restrictionListRegistry.restrictionListCount()).to.equal(3);
      });

      it("should emit individual AddedToRestrictionList events for each address", async function () {
        const addresses = [user1.address, user2.address];
        
        const tx = await restrictionListRegistry.addMultipleToRestrictionList(addresses);
        const receipt = await tx.wait();

        // Filter for AddedToRestrictionList events
        const events = receipt?.logs.filter((log: any) => {
          try {
            const parsed = restrictionListRegistry.interface.parseLog(log);
            return parsed?.name === "AddedToRestrictionList";
          } catch {
            return false;
          }
        });

        expect(events).to.have.length(2);
        
      });

      it("should skip invalid addresses and already restricted addresses", async function () {
        // First, add user1 to restriction list
        await restrictionListRegistry.addToRestrictionList(user1.address);
        
        // Try to add array including zero address, owner, already restricted user1, and new user2
        const addresses = [hre.ethers.ZeroAddress, owner.address, user1.address, user2.address];
        const tx = await restrictionListRegistry.addMultipleToRestrictionList(addresses);
        await tx.wait();

        // Only user2 should be newly restricted
        expect(await restrictionListRegistry.isRestricted(user1.address)).to.be.true; // Was already restricted
        expect(await restrictionListRegistry.isRestricted(user2.address)).to.be.true; // Newly restricted
        expect(await restrictionListRegistry.isRestricted(owner.address)).to.be.false; // Should be skipped
        expect(await restrictionListRegistry.restrictionListCount()).to.equal(2); // user1 + user2
      });

      it("should revert with empty array", async function () {
        await expectReverted(restrictionListRegistry.addMultipleToRestrictionList([]));
      });

      it("should revert with too many accounts", async function () {
        // Create array with 101 addresses (more than the 100 limit)
        const manyAddresses = new Array(101).fill(user1.address);
        
        await expectReverted(restrictionListRegistry.addMultipleToRestrictionList(manyAddresses));
      });

      it("should revert when non-owner tries to add multiple addresses", async function () {
        const addresses = [user1.address, user2.address];
        await expectReverted(restrictionListRegistry.connect(nonOwner).addMultipleToRestrictionList(addresses));
      });
    });

    describe("Removing multiple addresses", function () {
      beforeEach(async function () {
        // Add multiple users to restriction list for removal tests
        const addresses = [user1.address, user2.address, user3.address];
        await (await restrictionListRegistry.addMultipleToRestrictionList(addresses)).wait();
        await waitForCondition(async () => (await restrictionListRegistry.restrictionListCount()) === 3n);
      });

      it("should allow owner to remove multiple addresses", async function () {
        const addresses = [user1.address, user2.address];
        const tx = await restrictionListRegistry.removeMultipleFromRestrictionList(addresses);
        await tx.wait();

        expect(await restrictionListRegistry.isRestricted(user1.address)).to.be.false;
        expect(await restrictionListRegistry.isRestricted(user2.address)).to.be.false;
        expect(await restrictionListRegistry.isRestricted(user3.address)).to.be.true; // Still restricted
        expect(await restrictionListRegistry.restrictionListCount()).to.equal(1);
      });

      it("should emit individual RemovedFromRestrictionList events for each address", async function () {
        const addresses = [user1.address, user2.address];
        
        const tx = await restrictionListRegistry.removeMultipleFromRestrictionList(addresses);
        const receipt = await tx.wait();

        // Filter for RemovedFromRestrictionList events
        const events = receipt?.logs.filter((log: any) => {
          try {
            const parsed = restrictionListRegistry.interface.parseLog(log);
            return parsed?.name === "RemovedFromRestrictionList";
          } catch {
            return false;
          }
        });

        expect(events).to.have.length(2);

      });

      it("should skip non-restricted addresses", async function () {
        // Remove user1 first
        await restrictionListRegistry.removeFromRestrictionList(user1.address);
        
        // Try to remove array including non-restricted user1 and restricted user2
        const addresses = [user1.address, user2.address];
        const tx = await restrictionListRegistry.removeMultipleFromRestrictionList(addresses);
        await tx.wait();

        // Only user2 should be removed, user1 was skipped
        expect(await restrictionListRegistry.isRestricted(user1.address)).to.be.false; // Was already not restricted
        expect(await restrictionListRegistry.isRestricted(user2.address)).to.be.false; // Newly removed
        expect(await restrictionListRegistry.isRestricted(user3.address)).to.be.true; // Still restricted
        expect(await restrictionListRegistry.restrictionListCount()).to.equal(1);
      });

      it("should revert with empty array", async function () {
        await expectReverted(restrictionListRegistry.removeMultipleFromRestrictionList([]));
      });

      it("should revert when non-owner tries to remove multiple addresses", async function () {
        const addresses = [user1.address, user2.address];
        await expectReverted(restrictionListRegistry.connect(nonOwner).removeMultipleFromRestrictionList(addresses));
      });
    });
  });

  describe("Query Functions", function () {
    beforeEach(async function () {
      // Set up some restricted addresses
      const addresses = [user1.address, user2.address];
      await (await restrictionListRegistry.addMultipleToRestrictionList(addresses)).wait();
      await waitForCondition(async () => (await restrictionListRegistry.restrictionListCount()) === 2n);
    });

    it("should return correct restriction status", async function () {
      expect(await restrictionListRegistry.isRestricted(user1.address)).to.be.true;
      expect(await restrictionListRegistry.isRestricted(user2.address)).to.be.true;
      expect(await restrictionListRegistry.isRestricted(user3.address)).to.be.false;
    });

    it("should return correct restriction count", async function () {
      expect(await restrictionListRegistry.restrictionListCount()).to.equal(2);
    });

    it("should return correct address at index", async function () {
      const address0 = await restrictionListRegistry.restrictedAddressAt(0);
      const address1 = await restrictionListRegistry.restrictedAddressAt(1);
      
      // The addresses should be either user1 or user2 (order may vary due to EnumerableSet)
      expect([user1.address, user2.address]).to.include(address0);
      expect([user1.address, user2.address]).to.include(address1);
      expect(address0).to.not.equal(address1);
    });

    it("should revert when querying index out of bounds", async function () {
      await expectReverted(restrictionListRegistry.restrictedAddressAt(2));
    });

    it("should return all restricted addresses", async function () {
      const allRestricted = await restrictionListRegistry.getAllRestrictedAddresses();
      
      expect(allRestricted).to.have.length(2);
      expect(allRestricted).to.include(user1.address);
      expect(allRestricted).to.include(user2.address);
    });
  });

  describe("Emergency Functions", function () {
    beforeEach(async function () {
      // Set up some restricted addresses
      const addresses = [user1.address, user2.address, user3.address];
      await (await restrictionListRegistry.addMultipleToRestrictionList(addresses)).wait();
      await waitForCondition(async () => (await restrictionListRegistry.restrictionListCount()) === 3n);
    });

    it("should allow owner to clear all restrictions", async function () {
      expect(await restrictionListRegistry.restrictionListCount()).to.equal(3);
      
      const tx = await restrictionListRegistry.clearRestrictionList();
      await tx.wait();

      expect(await restrictionListRegistry.restrictionListCount()).to.equal(0);
      expect(await restrictionListRegistry.isRestricted(user1.address)).to.be.false;
      expect(await restrictionListRegistry.isRestricted(user2.address)).to.be.false;
      expect(await restrictionListRegistry.isRestricted(user3.address)).to.be.false;
    });

    it("should emit individual RemovedFromRestrictionList events when clearing", async function () {
      const tx = await restrictionListRegistry.clearRestrictionList();
      const receipt = await tx.wait();
      const removedEvents = receipt?.logs.filter((log: any) => {
        try {
          const parsed = restrictionListRegistry.interface.parseLog(log);
          return parsed?.name === "RemovedFromRestrictionList";
        } catch {
          return false;
        }
      });
      expect(removedEvents).to.have.length(3);
    });

    it("should revert when non-owner tries to clear restrictions", async function () {
      await expectReverted(restrictionListRegistry.connect(nonOwner).clearRestrictionList());
    });
  });

  describe("Ownership Protection", function () {
    it("should prevent restricted address from becoming owner", async function () {
      // Restrict user1
      await restrictionListRegistry.addToRestrictionList(user1.address);
      
      // Try to transfer ownership to restricted user1
      await expectReverted(restrictionListRegistry.transferOwnership(user1.address));
    });

    it("should allow transferring ownership to non-restricted address", async function () {
      await restrictionListRegistry.transferOwnership(user2.address);
      
      expect(await restrictionListRegistry.owner()).to.equal(user2.address);
    });
  });

  describe("Gas Efficiency Tests", function () {
    it("should demonstrate gas costs for single vs batch operations", async function () {
      // Test single additions
      const tx1 = await restrictionListRegistry.addToRestrictionList(user1.address);
      const receipt1 = await tx1.wait();
      console.log("Gas for single addition:", receipt1?.gasUsed.toString());

      // Test batch additions
      const addresses = [user2.address, user3.address];
      const tx2 = await restrictionListRegistry.addMultipleToRestrictionList(addresses);
      const receipt2 = await tx2.wait();
      console.log("Gas for batch addition (2 addresses):", receipt2?.gasUsed.toString());
      
      // Batch should be more efficient per address
      const gasPerAddressInBatch = Number(receipt2?.gasUsed) / 2;
      const gasForSingleAddress = Number(receipt1?.gasUsed);
      
      console.log("Gas per address in batch:", gasPerAddressInBatch);
      console.log("Gas for single address:", gasForSingleAddress);
      
      // Batch should be more efficient (though we emit individual events, we save on transaction overhead)
      expect(gasPerAddressInBatch).to.be.lessThan(gasForSingleAddress);
    });
  });
}); 