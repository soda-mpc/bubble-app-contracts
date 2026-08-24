import { expect } from "chai";
import hre from "hardhat";
import {
  deploySafeWallet,
  getOrDeploySafeInfrastructure,
} from "../helpers/safeHelpers";

describe("Safe infrastructure", function () {
  it("deploys SafeL2 and SafeProxyFactory locally on hardhat", async function () {
    const infrastructure = await getOrDeploySafeInfrastructure(hre);
    expect(infrastructure.safeL2Address).to.properAddress;
    expect(infrastructure.factoryAddress).to.properAddress;
    expect(infrastructure.source).to.equal("local");

    const safeL2Code = await hre.ethers.provider.getCode(infrastructure.safeL2Address);
    const factoryCode = await hre.ethers.provider.getCode(infrastructure.factoryAddress);
    expect(safeL2Code.length).to.be.greaterThan(2);
    expect(factoryCode.length).to.be.greaterThan(2);
  });

  it("creates a 1-of-1 Safe proxy with setup owners", async function () {
    const [owner] = await hre.ethers.getSigners();
    const deployed = await deploySafeWallet(hre, [owner.address], 1, 7n);

    expect(deployed.safeAddress).to.properAddress;
    expect(await deployed.safe.VERSION()).to.equal("1.4.1");
    expect(await deployed.safe.getThreshold()).to.equal(1n);
    expect(await deployed.safe.getOwners()).to.deep.equal([owner.address]);
    expect(await deployed.safe.nonce()).to.equal(0n);
  });
});
