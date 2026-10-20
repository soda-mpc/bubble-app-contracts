/**
 * PrivateERC20GaslessFactory: deploys a gasless token proxy and its forwarder in one transaction.
 *
 *   Input checks run before any MPC call, so they also run on Hardhat (31337).
 *   Token creation initializes the token's OPRF key through MPC, so it runs on a Bubble network only.
 *
 * Run: npx hardhat test test/PrivateERC20GaslessFactory.test.ts --network sepolia-arbitrum
 */
import { expect } from "chai";
import hre from "hardhat";

import { signExecuteWithAuthorization } from "./helpers/gaslessAuth";
import {
  deployMockToken,
  deployPrivateOPRFNotesLibrary,
  findParsedLogInReceipt,
  PRIVATE_ERC20_256_GASLESS_FQN,
  PRIVATE_OPRF_NOTES_FQN,
  skipUnlessBubbleNetwork,
} from "./helpers/testHelpers";

describe("PrivateERC20GaslessFactory", function () {
  this.timeout(600000);

  let creator: any;
  let factory: any;
  let implementationAddress: string;
  let mockToken: any;

  before(async function () {
    [creator] = await hre.ethers.getSigners();
    const library = await deployPrivateOPRFNotesLibrary(hre, creator);
    const implementationFactory = await hre.ethers.getContractFactory(PRIVATE_ERC20_256_GASLESS_FQN, {
      signer: creator,
      libraries: { [PRIVATE_OPRF_NOTES_FQN]: library },
    });
    const implementation = await implementationFactory.deploy();
    await implementation.waitForDeployment();
    implementationAddress = await implementation.getAddress();
    factory = await hre.ethers.deployContract("PrivateERC20GaslessFactory", [implementationAddress], creator);
    await factory.waitForDeployment();
    mockToken = await deployMockToken(hre, creator, "Factory USD", "FUSD");
  });

  /** The `TokenCreated` event in `receipt`; fails the test if it is missing. */
  function tokenCreated(receipt: any) {
    const log = findParsedLogInReceipt(receipt, factory, "TokenCreated");
    expect(log, "TokenCreated").to.not.equal(undefined);
    return factory.interface.parseLog(log);
  }

  describe("input checks", function () {
    it("rejects a zero implementation", async function () {
      const Factory = await hre.ethers.getContractFactory("PrivateERC20GaslessFactory", creator);
      await expect(Factory.deploy(hre.ethers.ZeroAddress)).to.be.revertedWith("Implementation cannot be zero address");
    });

    it("rejects an empty name or symbol, a zero underlying and a non-ERC20 underlying", async function () {
      const create = factory["createToken(string,string,address)"];
      const underlying = await mockToken.getAddress();
      await expect(create("", "gF", underlying)).to.be.revertedWith("Name cannot be empty");
      await expect(create("Gasless F", "", underlying)).to.be.revertedWith("Symbol cannot be empty");
      await expect(create("Gasless F", "gF", hre.ethers.ZeroAddress)).to.be.revertedWith("Underlying cannot be zero address");
      await expect(create("Gasless F", "gF", creator.address)).to.be.revertedWith("Invalid ERC20 contract");
      expect(await factory.totalTokensCreated()).to.equal(0n);
    });
  });

  describe("createToken (Bubble network)", function () {
    let token: any;
    let forwarder: any;

    before(async function () {
      await skipUnlessBubbleNetwork(this);
    });

    it("deploys a token and its trusted forwarder, with the creator as master and pending owner", async function () {
      const underlying = await mockToken.getAddress();
      const tx = await factory["createToken(string,string,address)"]("Gasless Factory Token", "gFAC", underlying);
      const receipt = await tx.wait();
      const created = tokenCreated(receipt);
      const { token: tokenAddress, forwarder: forwarderAddress } = created.args;
      expect(created.args.creator).to.equal(creator.address);
      expect(created.args.underlying).to.equal(underlying);
      expect(created.args.underlyingIsWrappedNative).to.equal(false);

      token = await hre.ethers.getContractAt(PRIVATE_ERC20_256_GASLESS_FQN, tokenAddress, creator);
      forwarder = await hre.ethers.getContractAt("PrivateERC20GaslessForwarder", forwarderAddress, creator);

      expect(await factory.isTokenFromFactory(tokenAddress)).to.equal(true);
      expect(await factory.tokenForwarder(tokenAddress)).to.equal(forwarderAddress);
      expect(await factory.totalTokensCreated()).to.equal(1n);

      const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
      const implRaw = await hre.ethers.provider.getStorage(tokenAddress, implSlot);
      expect(hre.ethers.getAddress("0x" + implRaw.slice(-40))).to.equal(implementationAddress);

      expect(await forwarder.token()).to.equal(tokenAddress);
      expect(await token.trustedForwarder()).to.equal(forwarderAddress);
      expect(await token.name()).to.equal("Gasless Factory Token");
      expect(await token.underlying()).to.equal(underlying);
      expect(await token.master()).to.equal(creator.address);
      // Ownable2Step: the factory stays owner until the creator accepts.
      expect(await token.owner()).to.equal(await factory.getAddress());
      expect(await token.pendingOwner()).to.equal(creator.address);
    });

    it("until the creator accepts, admin is frozen and only the creator can accept", async function () {
      await expect(token.pause()).to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount").withArgs(creator.address);
      const [, stranger] = await hre.ethers.getSigners();
      await expect(token.connect(stranger).acceptOwnership())
        .to.be.revertedWithCustomError(token, "OwnableUnauthorizedAccount")
        .withArgs(stranger.address);
      expect(await token.owner()).to.equal(await factory.getAddress());
    });

    it("the creator accepts ownership and the forwarder relays the creator's signed calls", async function () {
      await (await token.acceptOwnership()).wait();
      expect(await token.owner()).to.equal(creator.address);

      const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
      const spender = hre.ethers.Wallet.createRandom().address;
      const data = token.interface.encodeFunctionData("approve(address,uint256)", [spender, 3n]);
      const auth = await signExecuteWithAuthorization({
        signer: creator,
        forwarder: await forwarder.getAddress(),
        tokenName: await token.name(),
        chainId,
        from: creator.address,
        data,
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      });
      const tx = forwarder.executeWithAuthorization(
        auth.from,
        auth.data,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        auth.signature,
        0,
        "0x"
      );
      await expect(tx).to.emit(forwarder, "AuthorizationExecuted").withArgs(creator.address, auth.nonce);
    });

    it("the four-argument overload records a wrapped-native underlying", async function () {
      const wrapped: any = await hre.ethers.deployContract("WrappedNativeMock", [false], creator);
      await wrapped.waitForDeployment();
      const wrappedAddress = await wrapped.getAddress();
      const receipt = await (
        await factory["createToken(string,string,address,bool)"]("Gasless Wrapped", "gWNM", wrappedAddress, true)
      ).wait();
      const created = tokenCreated(receipt);
      expect(created.args.underlyingIsWrappedNative).to.equal(true);
      const wrappedToken = await hre.ethers.getContractAt(PRIVATE_ERC20_256_GASLESS_FQN, created.args.token, creator);
      expect(await wrappedToken.underlyingIsWrappedNative()).to.equal(true);
      expect(await factory.totalTokensCreated()).to.equal(2n);
    });
  });
});
