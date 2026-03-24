import { expect } from "chai";
import hre from "hardhat";
import { Signer } from "ethers";

import { PrivateERC20Contract256 } from "../typechain-types";
import { deployPrivateTokenImplementation, mintAndApprove } from "./testHelpers";

/** Latest TokenCreated event from the factory (tests assume at least one exists). */
async function getLastTokenCreatedEvent(factory: any) {
  const events = await factory.queryFilter(factory.filters.TokenCreated());
  return events[events.length - 1];
}

async function createTokenAndGetEvent(
  factoryForTx: any,
  name: string,
  symbol: string,
  underlying: string,
  factoryForQuery?: any
) {
  const q = factoryForQuery ?? factoryForTx;
  const tx = await factoryForTx.createToken(name, symbol, underlying);
  const receipt = await tx.wait();
  const event = await getLastTokenCreatedEvent(q);
  return { receipt, event };
}

async function createTokenAndGetAddress(
  factoryForTx: any,
  name: string,
  symbol: string,
  underlying: string,
  factoryForQuery?: any
): Promise<string> {
  const { event } = await createTokenAndGetEvent(factoryForTx, name, symbol, underlying, factoryForQuery);
  return event.args.token;
}

async function sendEthForGas(from: Signer, to: string, valueWei: bigint) {
  await (await from.sendTransaction({ to, value: valueWei })).wait();
}

describe("PrivateERC20Factory", function () {
  // Default Mocha/Hardhat timeout (~40s) is too low for several deploys on public testnets (e.g. Sepolia).
  this.timeout(300000);

  let factory: any;
  let mockToken1: any;
  let mockToken2: any;
  let owner: Signer;
  let otherUser: Signer;
  let userAddress: string;

  before(async function () {
    const signers = await hre.ethers.getSigners();
    owner = signers[0];
    otherUser = signers[1];
    userAddress = await owner.getAddress();

    const MockTokenFactory = await hre.ethers.getContractFactory("TUSDC", owner);

    mockToken1 = await MockTokenFactory.deploy("Test USDC 1", "TUSDC1");
    await mockToken1.waitForDeployment();

    mockToken2 = await MockTokenFactory.deploy("Test USDC 2", "TUSDC2");
    await mockToken2.waitForDeployment();

    const implementation = await deployPrivateTokenImplementation(hre, owner);
    const implAddress = await implementation.getAddress();

    const FactoryContract = await hre.ethers.getContractFactory("PrivateERC20Factory", owner);
    factory = await FactoryContract.deploy(implAddress);
    await factory.waitForDeployment();
  });

  describe("Token Creation", function () {
    it("should successfully create a new private token", async function () {
      const tokenName = "Private USDC";
      const tokenSymbol = "pUSDC";
      const underlyingAddress = await mockToken1.getAddress();

      const { receipt, event: lastEvent } = await createTokenAndGetEvent(
        factory,
        tokenName,
        tokenSymbol,
        underlyingAddress
      );
      expect(receipt).to.not.be.undefined;

      expect(lastEvent.args.name).to.equal(tokenName);
      expect(lastEvent.args.symbol).to.equal(tokenSymbol);
      expect(lastEvent.args.underlying).to.equal(underlyingAddress);
      expect(lastEvent.args.creator).to.equal(userAddress);

      const tokenAddress = lastEvent.args.token;
      const privateToken = await hre.ethers.getContractAt("PrivateERC20Contract256", tokenAddress);

      expect(await privateToken.name()).to.equal(tokenName);
      expect(await privateToken.symbol()).to.equal(tokenSymbol);
      expect(await (privateToken as any).underlying()).to.equal(underlyingAddress);
    });

    it("should create multiple tokens for the same underlying", async function () {
      const underlyingAddress = await mockToken1.getAddress();

      const initialCount = await factory.totalTokensCreated();

      await createTokenAndGetAddress(factory, "Private Token 1", "PT1", underlyingAddress);
      await createTokenAndGetAddress(factory, "Private Token 2", "PT2", underlyingAddress);

      const finalCount = await factory.totalTokensCreated();
      expect(finalCount).to.equal(initialCount + 2n);
    });

    it("should create tokens for different creators", async function () {
      const underlyingAddress = await mockToken2.getAddress();

      const initialCount = await factory.totalTokensCreated();

      await createTokenAndGetAddress(factory, "User1 Token", "U1T", underlyingAddress);

      await sendEthForGas(owner, await otherUser.getAddress(), hre.ethers.parseEther("0.1"));

      const factoryWithOtherUser = factory.connect(otherUser);
      await createTokenAndGetAddress(
        factoryWithOtherUser,
        "User2 Token",
        "U2T",
        underlyingAddress,
        factory
      );

      const finalCount = await factory.totalTokensCreated();
      expect(finalCount).to.equal(initialCount + 2n);

      const events = await factory.queryFilter(factory.filters.TokenCreated());
      const recentEvents = events.slice(-2);
      expect(recentEvents[0].args.creator).to.equal(userAddress);
      expect(recentEvents[1].args.creator).to.equal(await otherUser.getAddress());
    });

    it("should fail with empty name", async function () {
      await expect(factory.createToken("", "TEST", await mockToken1.getAddress())).to.be.revertedWith(
        "Name cannot be empty"
      );
    });

    it("should fail with empty symbol", async function () {
      await expect(factory.createToken("Test Token", "", await mockToken1.getAddress())).to.be.revertedWith(
        "Symbol cannot be empty"
      );
    });

    it("should fail with zero address for underlying", async function () {
      await expect(factory.createToken("Test Token", "TEST", hre.ethers.ZeroAddress)).to.be.revertedWith(
        "Underlying cannot be zero address"
      );
    });

    it("should fail with invalid ERC20 contract", async function () {
      // Revert fails eth_estimateGas on live networks; explicit gasLimit + failed receipt handling (ethers v6).
      const tx = await factory.createToken("Test Token", "TEST", await factory.getAddress(), {
        gasLimit: 1_000_000n,
      });
      try {
        const receipt = await tx.wait();
        expect(receipt?.status).to.equal(0);
      } catch (e: any) {
        const st = e?.receipt?.status;
        if (e?.code === "CALL_EXCEPTION" && st != null && Number(st) === 0) {
          return;
        }
        throw e;
      }
    });
  });

  describe("Factory State Tracking", function () {
    let testTokenAddress: string;
    const testTokenName = "Query Test Token";
    const testTokenSymbol = "QTT";

    before(async function () {
      testTokenAddress = await createTokenAndGetAddress(
        factory,
        testTokenName,
        testTokenSymbol,
        await mockToken1.getAddress()
      );
    });

    it("should track total number of tokens created", async function () {
      const totalTokens = await factory.totalTokensCreated();
      expect(totalTokens).to.be.greaterThan(0);
    });

    it("should correctly identify tokens from factory", async function () {
      expect(await factory.isTokenFromFactory(testTokenAddress)).to.be.true;
      expect(await factory.isTokenFromFactory(await mockToken1.getAddress())).to.be.false;
      expect(await factory.isTokenFromFactory(hre.ethers.ZeroAddress)).to.be.false;
    });

    it("should emit complete TokenCreated events for subgraph indexing", async function () {
      const initialCount = await factory.totalTokensCreated();

      const { event: lastEvent } = await createTokenAndGetEvent(
        factory,
        "Event Test Token",
        "ETT",
        await mockToken1.getAddress()
      );

      expect(lastEvent.args.token).to.not.be.undefined;
      expect(lastEvent.args.name).to.equal("Event Test Token");
      expect(lastEvent.args.symbol).to.equal("ETT");
      expect(lastEvent.args.underlying).to.equal(await mockToken1.getAddress());
      expect(lastEvent.args.creator).to.equal(userAddress);

      expect(await factory.totalTokensCreated()).to.equal(initialCount + 1n);
    });
  });

  describe.only("Integration with PrivateERC20Contract256", function () {
    let privateTokenAddress: string;
    let privateToken: PrivateERC20Contract256;

    before(async function () {
      privateTokenAddress = await createTokenAndGetAddress(
        factory,
        "Integration Test Token",
        "ITT",
        await mockToken1.getAddress()
      );
      privateToken = await hre.ethers.getContractAt("PrivateERC20Contract256", privateTokenAddress);
    });

    it("should create functional PrivateERC20Contract256", async function () {
      expect(await privateToken.name()).to.equal("Integration Test Token");
      expect(await privateToken.symbol()).to.equal("ITT");
      expect(await privateToken.decimals()).to.equal(18);
      expect(await privateToken.totalSupply()).to.equal(0);
      expect(await (privateToken as any).underlying()).to.equal(await mockToken1.getAddress());
    });

    it("should create contract with correct owner", async function () {
      expect(await privateToken.owner()).to.equal(userAddress);
    });

    it("should be able to perform shield operations", async function () {
      const shieldAmount = 100n * 10n ** 18n;

      await mintAndApprove({
        mockToken: mockToken1,
        privateToken,
        userAddress,
        amount: shieldAmount,
      });

      const shieldTx = await privateToken.shield(shieldAmount);
      const shieldReceipt = await shieldTx.wait();
      expect(shieldReceipt).to.not.be.undefined;

      const expectedPrivateAmount = 100n * 10n ** 18n;
      expect(await privateToken.totalSupply()).to.equal(expectedPrivateAmount);
      expect(await mockToken1.balanceOf(privateTokenAddress)).to.equal(shieldAmount);
    });
  });
});
