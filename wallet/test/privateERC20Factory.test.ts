import { expect } from "chai";
import hre from "hardhat";
import { Signer } from "ethers";

import { PrivateERC20Contract256 } from "../typechain-types";

describe("PrivateERC20Factory", function () {
  let factory: any;
  let mockToken1: any;
  let mockToken2: any;
  let owner: Signer;
  let otherUser: Signer;
  let userAddress: string;

  before(async function () {
    // Get signers from Hardhat
    const signers = await hre.ethers.getSigners();
    owner = signers[0];
    otherUser = signers[1];
    userAddress = await owner.getAddress();

    // Deploy mock tokens for testing
    console.log("Deploying mock tokens...");
    const MockTokenFactory = await hre.ethers.getContractFactory("TUSDC", owner);
    
    mockToken1 = await MockTokenFactory.deploy("Test USDC 1", "TUSDC1");
    await mockToken1.waitForDeployment();
    console.log("Mock token 1 deployed at:", await mockToken1.getAddress());

    mockToken2 = await MockTokenFactory.deploy("Test USDC 2", "TUSDC2");
    await mockToken2.waitForDeployment();
    console.log("Mock token 2 deployed at:", await mockToken2.getAddress());

    // Deploy PrivateERC20Contract256 implementation for the factory
    console.log("Deploying PrivateERC20Contract256 implementation...");
    const ImplFactory = await hre.ethers.getContractFactory("PrivateERC20Contract256", owner);
    const implementation = await ImplFactory.deploy();
    await implementation.waitForDeployment();
    const implAddress = await implementation.getAddress();
    console.log("PrivateERC20Contract256 implementation at:", implAddress);

    // Deploy factory with implementation
    console.log("Deploying PrivateERC20Factory...");
    const FactoryContract = await hre.ethers.getContractFactory("PrivateERC20Factory", owner);
    factory = await FactoryContract.deploy(implAddress);
    await factory.waitForDeployment();
    console.log("Deployed PrivateERC20Factory at:", await factory.getAddress());
  });

  describe("Token Creation", function () {
    it("should successfully create a new private token", async function () {
      const tokenName = "Private USDC";
      const tokenSymbol = "pUSDC";
      const underlyingAddress = await mockToken1.getAddress();

      const createTx = await factory.createToken(tokenName, tokenSymbol, underlyingAddress);
      const receipt = await createTx.wait();
      expect(receipt).to.not.be.undefined;

      // Check TokenCreated event
      const events = await factory.queryFilter(factory.filters.TokenCreated());
      expect(events.length).to.be.greaterThan(0);
      
      const lastEvent = events[events.length - 1];
      expect(lastEvent.args.name).to.equal(tokenName);
      expect(lastEvent.args.symbol).to.equal(tokenSymbol);
      expect(lastEvent.args.underlying).to.equal(underlyingAddress);
      expect(lastEvent.args.creator).to.equal(userAddress);

      // Verify the token was created correctly
      const tokenAddress = lastEvent.args.token;
      const privateToken = await hre.ethers.getContractAt("PrivateERC20Contract256", tokenAddress);
      
      expect(await privateToken.name()).to.equal(tokenName);
      expect(await privateToken.symbol()).to.equal(tokenSymbol);
      expect(await (privateToken as any).underlying()).to.equal(underlyingAddress);
    });

    it("should create multiple tokens for the same underlying", async function () {
      const underlyingAddress = await mockToken1.getAddress();
      
      const initialCount = await factory.totalTokensCreated();
      
      const token1Tx = await factory.createToken("Private Token 1", "PT1", underlyingAddress);
      await token1Tx.wait();
      
      const token2Tx = await factory.createToken("Private Token 2", "PT2", underlyingAddress);
      await token2Tx.wait();

      const finalCount = await factory.totalTokensCreated();
      expect(finalCount).to.equal(initialCount + 2n);
    });

    it("should create tokens for different creators", async function () {
      const underlyingAddress = await mockToken2.getAddress();
      
      const initialCount = await factory.totalTokensCreated();
      
      // Create token with first user
      const token1Tx = await factory.createToken("User1 Token", "U1T", underlyingAddress);
      const receipt1 = await token1Tx.wait();
      
      // Fund the other user for gas fees (needed when using real blockchain)
      const transferTx = await owner.sendTransaction({
        to: await otherUser.getAddress(),
        value: hre.ethers.parseEther("0.1")
      });
      await transferTx.wait();
      
      // Connect other user and create token with second user
      const factoryWithOtherUser = factory.connect(otherUser);
      const token2Tx = await factoryWithOtherUser.createToken("User2 Token", "U2T", underlyingAddress);
      const receipt2 = await token2Tx.wait();

      // Verify both tokens were created and tracked
      const finalCount = await factory.totalTokensCreated();
      expect(finalCount).to.equal(initialCount + 2n);
      
      // Check events to verify different creators
      const events = await factory.queryFilter(factory.filters.TokenCreated());
      const recentEvents = events.slice(-2);
      expect(recentEvents[0].args.creator).to.equal(userAddress);
      expect(recentEvents[1].args.creator).to.equal(await otherUser.getAddress());
    });

    it("should fail with empty name", async function () {
      await expect(factory.createToken("", "TEST", await mockToken1.getAddress()))
        .to.be.revertedWith("Name cannot be empty");
    });

    it("should fail with empty symbol", async function () {
      await expect(factory.createToken("Test Token", "", await mockToken1.getAddress()))
        .to.be.revertedWith("Symbol cannot be empty");
    });

    it("should fail with zero address for underlying", async function () {
      await expect(factory.createToken("Test Token", "TEST", hre.ethers.ZeroAddress))
        .to.be.revertedWith("Underlying cannot be zero address");
    });

    it("should fail with invalid ERC20 contract", async function () {
      // Use factory address as invalid ERC20
      await expect(factory.createToken("Test Token", "TEST", await factory.getAddress()))
        .to.be.reverted;
    });
  });

  describe("Factory State Tracking", function () {
    let testTokenAddress: string;
    const testTokenName = "Query Test Token";
    const testTokenSymbol = "QTT";

    before(async function () {
      // Create a test token
      const createTx = await factory.createToken(testTokenName, testTokenSymbol, await mockToken1.getAddress());
      const receipt = await createTx.wait();
      
      const events = await factory.queryFilter(factory.filters.TokenCreated());
      testTokenAddress = events[events.length - 1].args.token;
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
      
      const createTx = await factory.createToken("Event Test Token", "ETT", await mockToken1.getAddress());
      await createTx.wait();

      const events = await factory.queryFilter(factory.filters.TokenCreated());
      const lastEvent = events[events.length - 1];
      
      // Verify all necessary data is in the event for subgraph
      expect(lastEvent.args.token).to.not.be.undefined;
      expect(lastEvent.args.name).to.equal("Event Test Token");
      expect(lastEvent.args.symbol).to.equal("ETT");
      expect(lastEvent.args.underlying).to.equal(await mockToken1.getAddress());
      expect(lastEvent.args.creator).to.equal(userAddress);
      
      // Verify counter was incremented
      expect(await factory.totalTokensCreated()).to.equal(initialCount + 1n);
    });
  });

  describe("Integration with PrivateERC20Contract256", function () {
    let privateTokenAddress: string;
    let privateToken: PrivateERC20Contract256;

    before(async function () {
      // Create a token through the factory
      const createTx = await factory.createToken(
        "Integration Test Token", 
        "ITT", 
        await mockToken1.getAddress()
      );
      await createTx.wait();
      
      const events = await factory.queryFilter(factory.filters.TokenCreated());
      privateTokenAddress = events[events.length - 1].args.token;
      privateToken = await hre.ethers.getContractAt("PrivateERC20Contract256", privateTokenAddress);
    });

    it("should create functional PrivateERC20Contract256", async function () {
      // Verify basic functionality
      expect(await privateToken.name()).to.equal("Integration Test Token");
      expect(await privateToken.symbol()).to.equal("ITT");
      expect(await privateToken.decimals()).to.equal(5);
      expect(await privateToken.totalSupply()).to.equal(0);
      expect(await (privateToken as any).underlying()).to.equal(await mockToken1.getAddress());
    });

    it("should create contract with correct owner", async function () {
      // The owner is the account that called createToken (msg.sender)
      expect(await privateToken.owner()).to.equal(userAddress);
    });

    it("should be able to perform shield operations", async function () {
      const shieldAmount = 100n * 10n ** 18n; // 100 tokens with 18 decimals
      
      // Mint tokens to user
      await (await mockToken1.mint(userAddress, shieldAmount)).wait();
      
      // Approve the private token to spend mock tokens
      await (await mockToken1.approve(privateTokenAddress, shieldAmount)).wait();
      
      // Shield the tokens
      const shieldTx = await privateToken.shield(shieldAmount);
      const shieldReceipt = await shieldTx.wait();
      expect(shieldReceipt).to.not.be.undefined;
      
      // Verify shield was successful
      const expectedPrivateAmount = 100n * 10n ** 5n; // 100 tokens with 5 decimals
      expect(await privateToken.totalSupply()).to.equal(expectedPrivateAmount);
      expect(await mockToken1.balanceOf(privateTokenAddress)).to.equal(shieldAmount);
    });
  });
}); 