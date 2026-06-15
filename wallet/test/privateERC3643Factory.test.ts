import { expect } from "chai";
import hre from "hardhat";

describe("PrivateERC3643ERC20Factory256", function () {
  it("stores implementation and rejects zero implementation", async function () {
    const [owner] = await hre.ethers.getSigners();
    const Implementation = await hre.ethers.getContractFactory(
      "contracts/erc3643/PrivateERC3643ERC20Contract256.sol:PrivateERC3643ERC20Contract256",
      owner
    );
    const implementation = await Implementation.deploy();
    await implementation.waitForDeployment();

    const Factory = await hre.ethers.getContractFactory("PrivateERC3643ERC20Factory256", owner);
    await expect(Factory.deploy(hre.ethers.ZeroAddress)).to.be.revertedWithCustomError(
      { interface: Factory.interface },
      "ZeroImplementationAddress"
    );

    const factory = await Factory.deploy(await implementation.getAddress());
    await factory.waitForDeployment();

    expect(await factory.implementation()).to.equal(await implementation.getAddress());
    expect(await factory.totalTokensCreated()).to.equal(0n);
  });
});
