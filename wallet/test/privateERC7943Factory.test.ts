import { expect } from "chai";
import hre from "hardhat";

import { deployMockToken } from "./helpers/testHelpers";

const ERC7943_FQN = "contracts/erc7943/PrivateERC7943ERC20Contract256.sol:PrivateERC7943ERC20Contract256";

async function deployImplementation(owner: any) {
  const Implementation = await hre.ethers.getContractFactory(ERC7943_FQN, owner);
  const implementation = await Implementation.deploy();
  await implementation.waitForDeployment();
  return implementation;
}

async function deployFactoryFixture() {
  const [owner, master] = await hre.ethers.getSigners();
  const implementation = await deployImplementation(owner);

  const Factory = await hre.ethers.getContractFactory("PrivateERC7943ERC20Factory256", owner);
  const factory = await Factory.deploy(await implementation.getAddress());
  await factory.waitForDeployment();

  const underlying = await deployMockToken(hre, owner, "Test USD 7943", "TUSD7943");
  await underlying.waitForDeployment();

  return { master, factory, underlying };
}

describe("PrivateERC7943ERC20Factory256", function () {
  it("stores implementation and rejects zero implementation", async function () {
    const [owner] = await hre.ethers.getSigners();
    const implementation = await deployImplementation(owner);
    const Factory = await hre.ethers.getContractFactory("PrivateERC7943ERC20Factory256", owner);

    await expect(Factory.deploy(hre.ethers.ZeroAddress)).to.be.revertedWithCustomError(
      { interface: Factory.interface },
      "ZeroImplementationAddress"
    );

    const factory = await Factory.deploy(await implementation.getAddress());
    await factory.waitForDeployment();

    expect(await factory.implementation()).to.equal(await implementation.getAddress());
    expect(await factory.totalTokensCreated()).to.equal(0n);
  });

  it("rejects invalid factory inputs before deploying proxy", async function () {
    const { factory, underlying, master } = await deployFactoryFixture();
    const underlyingAddress = await underlying.getAddress();
    const masterAddress = await master.getAddress();

    await expect(
      factory["createToken(string,string,address,bool,address,bool,bool)"](
        "",
        "pTUSD7943",
        underlyingAddress,
        false,
        masterAddress,
        false,
        false
      )
    ).to.be.revertedWithCustomError(factory, "EmptyName");

    await expect(
      factory["createToken(string,string,address,bool,address,bool,bool)"](
        "Private Test USD 7943",
        "",
        underlyingAddress,
        false,
        masterAddress,
        false,
        false
      )
    ).to.be.revertedWithCustomError(factory, "EmptySymbol");

    await expect(
      factory["createToken(string,string,address,bool,address,bool,bool)"](
        "Private Test USD 7943",
        "pTUSD7943",
        hre.ethers.ZeroAddress,
        false,
        masterAddress,
        false,
        false
      )
    ).to.be.revertedWithCustomError(factory, "ZeroUnderlyingAddress");

    await expect(
      factory["createToken(string,string,address,bool,address,bool,bool)"](
        "Private Test USD 7943",
        "pTUSD7943",
        underlyingAddress,
        false,
        hre.ethers.ZeroAddress,
        false,
        false
      )
    ).to.be.revertedWithCustomError(factory, "ZeroMaster");
  });
});
