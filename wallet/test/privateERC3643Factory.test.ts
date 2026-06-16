import { expect } from "chai";
import hre from "hardhat";
const ERC3643_FQN = "contracts/erc3643/PrivateERC3643ERC20Contract256.sol:PrivateERC3643ERC20Contract256";

async function deployFactoryFixture() {
  const [owner, master] = await hre.ethers.getSigners();
  const Implementation = await hre.ethers.getContractFactory(ERC3643_FQN, owner);
  const implementation = await Implementation.deploy();
  await implementation.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("PrivateERC3643ERC20Factory256", owner);
  const factory = await Factory.deploy(await implementation.getAddress());
  await factory.waitForDeployment();

  return { master, factory };
}

describe("PrivateERC3643ERC20Factory256", function () {
  it("stores implementation and rejects zero implementation", async function () {
    const [owner] = await hre.ethers.getSigners();
    const Implementation = await hre.ethers.getContractFactory(
      ERC3643_FQN,
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

  it("rejects zero explicit master before deploying proxy", async function () {
    const { master, factory } = await deployFactoryFixture();

    await expect(
      factory[
        "createToken(string,string,address,bool,address,address,address,address)"
      ](
        "Private Test USD",
        "pTUSD",
        await master.getAddress(),
        false,
        hre.ethers.ZeroAddress,
        await master.getAddress(),
        await master.getAddress(),
        hre.ethers.ZeroAddress
      )
    ).to.be.revertedWithCustomError(factory, "ZeroMaster");
  });
});
