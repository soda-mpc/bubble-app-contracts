import { expect } from "chai";
import hre from "hardhat";

import {
  deployMockToken,
  deployPrivateTokenWithRestrictionList,
  deployRestrictionListRegistry,
  skipUnlessBubbleNetwork,
} from "./helpers/testHelpers";

describe("RestrictionListIntegration", function () {
  before(async function () {
    await skipUnlessBubbleNetwork(this);
  });

  this.timeout(180000);

  let owner: any;
  let user1: any;
  let user2: any;
  let user3: any;
  let user4: any;

  let companyRegistry: any;
  let govRegistry: any;
  let internalRegistry: any;
  let token: any;

  beforeEach(async function () {
    [owner, user1, user2, user3, user4] = await hre.ethers.getSigners();

    companyRegistry = await deployRestrictionListRegistry(hre, owner, "Company Restriction List");
    govRegistry = await deployRestrictionListRegistry(hre, owner, "Government Sanctions List");
    internalRegistry = await deployRestrictionListRegistry(hre, owner, "Internal Compliance List");

    const underlying = await deployMockToken(hre, owner);

    token = await deployPrivateTokenWithRestrictionList({
      hre,
      signer: owner,
      underlyingAddress: await underlying.getAddress(),
      ownerAddress: owner.address,
      masterAddress: owner.address,
      name: "Restricted Private Token",
      symbol: "RPT",
    });

    await (await token.addRestrictionListRegistry(await companyRegistry.getAddress())).wait();
    await (await token.addRestrictionListRegistry(await govRegistry.getAddress())).wait();
  });

  describe("Initial setup", function () {
    it("should initialize with two active registries", async function () {
      expect(await token.getActiveRegistryCount()).to.equal(2);
      expect(await token.isRegistryActive(await companyRegistry.getAddress())).to.equal(true);
      expect(await token.isRegistryActive(await govRegistry.getAddress())).to.equal(true);
    });

    it("should return expected active registry names", async function () {
      const names = await token.getActiveRegistryNames();
      expect(names).to.include("Company Restriction List");
      expect(names).to.include("Government Sanctions List");
    });
  });

  describe("Restriction queries", function () {
    it("should detect restrictions from different registries", async function () {
      await (await companyRegistry.addToRestrictionList(user1.address)).wait();
      await (await govRegistry.addToRestrictionList(user2.address)).wait();

      expect(await token.isRestricted(user1.address)).to.equal(true);
      expect(await token.isRestricted(user2.address)).to.equal(true);
      expect(await token.isRestricted(user3.address)).to.equal(false);
    });

    it("should return first restricting registry and full details", async function () {
      await (await companyRegistry.addToRestrictionList(user1.address)).wait();
      await (await govRegistry.addToRestrictionList(user1.address)).wait();

      const firstRestricting = await token.getRestrictingRegistry(user1.address);
      expect([await companyRegistry.getAddress(), await govRegistry.getAddress()]).to.include(firstRestricting);

      const detailed = await token.getDetailedRestrictionInfo(user1.address);
      expect(detailed).to.have.length(2);
      expect(detailed).to.include(await companyRegistry.getAddress());
      expect(detailed).to.include(await govRegistry.getAddress());

      const comprehensive = await token.getComprehensiveRestrictionInfo(user1.address);
      expect(comprehensive).to.have.length(2);
      expect(comprehensive).to.include(await companyRegistry.getAddress());
      expect(comprehensive).to.include(await govRegistry.getAddress());
    });

    it("should return per-address restriction status for batch query", async function () {
      await (await companyRegistry.addToRestrictionList(user1.address)).wait();
      await (await govRegistry.addToRestrictionList(user2.address)).wait();

      const results = await token.areRestricted([user1.address, user2.address, user3.address, user4.address]);
      expect(results).to.deep.equal([true, true, false, false]);
    });

    it("should return detailed restriction info with names", async function () {
      await (await companyRegistry.addToRestrictionList(user1.address)).wait();
      await (await govRegistry.addToRestrictionList(user1.address)).wait();

      const [restrictingRegistries, registryNames] = await token.getDetailedRestrictionInfoWithNames(user1.address);
      expect(restrictingRegistries).to.have.length(2);
      expect(registryNames).to.have.length(2);
      expect(registryNames).to.include("Company Restriction List");
      expect(registryNames).to.include("Government Sanctions List");
    });

    it("should fail closed when any registry check reverts", async function () {
      const RevertingRegistryFactory = await hre.ethers.getContractFactory("RevertingRestrictionList");
      const revertingRegistry = await (RevertingRegistryFactory as any).deploy();
      await revertingRegistry.waitForDeployment();

      await (await token.addRestrictionListRegistry(await revertingRegistry.getAddress())).wait();

      await expect(token.isRestricted(user1.address))
        .to.be.revertedWithCustomError(token, "RestrictionRegistryCheckFailed")
        .withArgs(await revertingRegistry.getAddress());

      await expect(token.getRestrictingRegistry(user1.address))
        .to.be.revertedWithCustomError(token, "RestrictionRegistryCheckFailed")
        .withArgs(await revertingRegistry.getAddress());

      await expect(token.getDetailedRestrictionInfo(user1.address))
        .to.be.revertedWithCustomError(token, "RestrictionRegistryCheckFailed")
        .withArgs(await revertingRegistry.getAddress());
    });

    it("should allow owner to remove a deficient registry and recover checks", async function () {
      const RevertingRegistryFactory = await hre.ethers.getContractFactory("RevertingRestrictionList");
      const revertingRegistry = await (RevertingRegistryFactory as any).deploy();
      await revertingRegistry.waitForDeployment();

      const revertingRegistryAddress = await revertingRegistry.getAddress();
      await (await token.addRestrictionListRegistry(revertingRegistryAddress)).wait();

      await expect(token.isRestricted(user1.address))
        .to.be.revertedWithCustomError(token, "RestrictionRegistryCheckFailed")
        .withArgs(revertingRegistryAddress);

      await (await token.removeRestrictionListRegistry(revertingRegistryAddress)).wait();
      expect(await token.isRegistryActive(revertingRegistryAddress)).to.equal(false);
      expect(await token.isRestricted(user1.address)).to.equal(false);
      expect(await token.getDetailedRestrictionInfo(user1.address)).to.deep.equal([]);
    });
  });

  describe("Registry management", function () {
    it("should add and remove registries", async function () {
      expect(await token.getActiveRegistryCount()).to.equal(2);

      await (await token.addRestrictionListRegistry(await internalRegistry.getAddress())).wait();
      expect(await token.getActiveRegistryCount()).to.equal(3);
      expect(await token.isRegistryActive(await internalRegistry.getAddress())).to.equal(true);

      await (await token.removeRestrictionListRegistry(await internalRegistry.getAddress())).wait();
      expect(await token.getActiveRegistryCount()).to.equal(2);
      expect(await token.isRegistryActive(await internalRegistry.getAddress())).to.equal(false);
    });

    it("should reject duplicate registry addition", async function () {
      await expect(token.addRestrictionListRegistry(await companyRegistry.getAddress()))
        .to.be.revertedWithCustomError(token, "RegistryAlreadyExists");
    });

    it("should reject zero registry address", async function () {
      await expect(token.addRestrictionListRegistry(hre.ethers.ZeroAddress))
        .to.be.revertedWithCustomError(token, "InvalidRegistry");
    });

    it("should reject removing unknown registry", async function () {
      await expect(token.removeRestrictionListRegistry(await internalRegistry.getAddress()))
        .to.be.revertedWithCustomError(token, "RegistryNotFound");
    });
  });
});
