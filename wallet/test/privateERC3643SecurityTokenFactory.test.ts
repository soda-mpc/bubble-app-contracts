import { expect } from "chai";
import hre from "hardhat";

const ERC3643_SECURITY_FQN =
  "contracts/erc3643/PrivateERC3643SecurityToken256.sol:PrivateERC3643SecurityToken256";

async function deployFactoryFixture() {
  const [owner] = await hre.ethers.getSigners();
  const Implementation = await hre.ethers.getContractFactory(ERC3643_SECURITY_FQN, owner);
  const implementation = await Implementation.deploy();
  await implementation.waitForDeployment();

  const Factory = await hre.ethers.getContractFactory("PrivateERC3643SecurityTokenFactory256", owner);
  const factory = await Factory.deploy(await implementation.getAddress());
  await factory.waitForDeployment();

  return { owner, factory };
}

describe("PrivateERC3643SecurityTokenFactory256", function () {
  it("stores implementation and rejects zero implementation", async function () {
    const [owner] = await hre.ethers.getSigners();
    const Implementation = await hre.ethers.getContractFactory(ERC3643_SECURITY_FQN, owner);
    const implementation = await Implementation.deploy();
    await implementation.waitForDeployment();

    const Factory = await hre.ethers.getContractFactory("PrivateERC3643SecurityTokenFactory256", owner);
    await expect(Factory.deploy(hre.ethers.ZeroAddress)).to.be.revertedWithCustomError(
      { interface: Factory.interface },
      "ZeroImplementationAddress"
    );

    const factory = await Factory.deploy(await implementation.getAddress());
    await factory.waitForDeployment();

    expect(await factory.implementation()).to.equal(await implementation.getAddress());
    expect(await factory.totalTokensCreated()).to.equal(0n);
  });

  it("rejects invalid parameters before deploying proxy", async function () {
    const { owner, factory } = await deployFactoryFixture();
    const ownerAddress = await owner.getAddress();

    await expect(
      factory.createToken("", "pSEC", 18, ownerAddress, ownerAddress, hre.ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(factory, "EmptyName");

    await expect(
      factory.createToken("Private Security", "", 18, ownerAddress, ownerAddress, hre.ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(factory, "EmptySymbol");

    await expect(
      factory.createToken("Private Security", "pSEC", 18, hre.ethers.ZeroAddress, ownerAddress, hre.ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(factory, "ZeroIdentityRegistry");

    await expect(
      factory.createToken("Private Security", "pSEC", 18, ownerAddress, hre.ethers.ZeroAddress, hre.ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(factory, "ZeroCompliance");
  });
});
