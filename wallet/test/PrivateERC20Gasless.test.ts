/**
 * Coverage for both token implementations on a Bubble network (not Hardhat 31337):
 *
 *   PrivateERC20Contract256Gasless — EIP-712 executeWithAuthorization, dest lock,
 *     signed redeem to a third party, OPRF IT user mismatch.
 *   PrivateERC20Contract256 (original) — msg.sender mint, no dest lock.
 *
 * Full original OPRF suite: `npm run test:oprf:arbitrum-sepolia`
 * This file: `npm run test:gasless:arbitrum-sepolia`
 */
import { expect } from "chai";
import hre from "hardhat";
import { Wallet } from "ethers";
import dotenv from "dotenv";

import {
  decryptMultipleValuesViaProxy,
  decryptValueViaProxy,
  getUserKeyViaProxy,
} from "./helpers/bubbleCryptoTransport";
import { signExecuteWithAuthorization } from "./helpers/gaslessAuth";
import {
  buildSignedItUint256,
  buildUnsignedItUint128,
  buildUnsignedItUint256,
  DELAY_BALANCE_SYNC_MS,
  DELAY_MPC_EXTENDED_MS,
  DELAY_MPC_REDEEM_MS,
  delay,
  deployMockToken,
  deployPrivateToken,
  deployPrivateTokenGasless,
  getGcAclContract,
  getOprfMintedEventsFromReceipt,
  getOprfMintedHandlesFromReceipt,
  mintAndApprove,
  waitForUnshieldOutcome,
} from "./helpers/testHelpers";

dotenv.config();

const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const TOKEN_NAME = "Gasless Bubble Token";
const NOTE_AMOUNT = 50n * 10n ** 18n;
const PAY_AMOUNT = 10n ** 17n;
const INSERT_TTL_SECONDS = 365n * 24n * 60n * 60n;

function dummyIt256(user: string) {
  return {
    userAddress: user,
    ciphertext: { ciphertextHigh: 1n, ciphertextLow: 1n },
  };
}

function dummyIt128(user: string) {
  return {
    userAddress: user,
    ciphertext: 1n,
  };
}

function shouldSkip(): boolean {
  return (
    !process.env.MNEMONIC ||
    (!process.env.QUICKNODE_ARBITRUM_SEPOLIA_URL &&
      !process.env.ALCHEMY_API_KEY &&
      !process.env.KURTOSIS)
  );
}

describe("PrivateERC20Contract256Gasless", function () {
  this.timeout(900000);

  let owner: any;
  let facilitator: any;
  let destination: Wallet;
  let ownerAesKey: Buffer;
  let ownerAesKeyHex: string;
  let mockToken: any;
  let privateToken: any;
  let chainId: number;
  let tokenAddress: string;

  before(async function () {
    const network = await hre.ethers.provider.getNetwork();
    chainId = Number(network.chainId);
    if (network.chainId === 31337n || shouldSkip()) {
      this.skip();
    }

    const signers = await hre.ethers.getSigners();
    owner = signers[0];
    facilitator = signers[1] ?? Wallet.createRandom().connect(hre.ethers.provider);
    destination = Wallet.createRandom();

    if ((await hre.ethers.provider.getBalance(facilitator.address)) < hre.ethers.parseEther("0.0002")) {
      await (await owner.sendTransaction({
        to: facilitator.address,
        value: hre.ethers.parseEther("0.002"),
      })).wait();
    }

    ownerAesKey = await getUserKeyViaProxy(owner, PROXY_URL);
    ownerAesKeyHex = ownerAesKey.toString("hex");

    mockToken = await deployMockToken(hre, owner, "Gasless Test USD", "GTUSD");
    privateToken = await deployPrivateTokenGasless(hre, owner, {
      underlyingAddress: await mockToken.getAddress(),
      ownerAddress: owner.address,
      masterAddress: owner.address,
      name: TOKEN_NAME,
      symbol: "gBUB",
    });
    tokenAddress = await privateToken.getAddress();

    await mintAndApprove({
      mockToken,
      privateToken,
      userAddress: owner.address,
      amount: NOTE_AMOUNT * 2n,
    });

    // Facilitator is tx.origin; ValidateCiphertext then requires insert ACL
    // (permittee = this token). Owner-direct calls skip this because tx.origin == IT owner.
    const gcAcl = await getGcAclContract(hre, owner);
    const expiration = BigInt(Math.floor(Date.now() / 1000)) + INSERT_TTL_SECONDS;
    await (await gcAcl.permitFullInsertAccess(tokenAddress, expiration)).wait();
  });

  async function execAsOwner(data: string) {
    const auth = await signExecuteWithAuthorization({
      signer: owner,
      token: tokenAddress,
      tokenName: TOKEN_NAME,
      chainId,
      from: owner.address,
      data,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });
    const tx = await privateToken
      .connect(facilitator)
      .executeWithAuthorization(
        auth.from,
        auth.data,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        auth.signature
      );
    return tx.wait();
  }

  describe("executeWithAuthorization", function () {
    it("lets a facilitator pause when the owner signed the call", async function () {
      const data = privateToken.interface.encodeFunctionData("pause", []);
      const auth = await signExecuteWithAuthorization({
        signer: owner,
        token: tokenAddress,
        tokenName: TOKEN_NAME,
        chainId,
        from: owner.address,
        data,
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      });

      await expect(
        privateToken
          .connect(facilitator)
          .executeWithAuthorization(
            auth.from,
            auth.data,
            auth.validAfter,
            auth.validBefore,
            auth.nonce,
            auth.signature
          )
      ).to.emit(privateToken, "AuthorizationExecuted");

      expect(await privateToken.paused()).to.equal(true);

      await expect(
        privateToken
          .connect(facilitator)
          .executeWithAuthorization(
            auth.from,
            auth.data,
            auth.validAfter,
            auth.validBefore,
            auth.nonce,
            auth.signature
          )
      ).to.be.revertedWith("Auth used");

      await (await privateToken.connect(owner).unpause()).wait();
    });

    it("rejects when the EIP-712 signer is not `from`", async function () {
      const data = privateToken.interface.encodeFunctionData("pause", []);
      const auth = await signExecuteWithAuthorization({
        signer: facilitator,
        token: tokenAddress,
        tokenName: TOKEN_NAME,
        chainId,
        from: owner.address,
        data,
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      });

      await expect(
        privateToken
          .connect(facilitator)
          .executeWithAuthorization(
            auth.from,
            auth.data,
            auth.validAfter,
            auth.validBefore,
            auth.nonce,
            auth.signature
          )
      ).to.be.revertedWith("Invalid signature");
    });

    it("shields to the signer, not the facilitator", async function () {
      const amount = NOTE_AMOUNT;
      const ownerBefore = await mockToken.balanceOf(owner.address);
      const data = privateToken.interface.encodeFunctionData("shield", [amount]);
      await execAsOwner(data);
      await delay(DELAY_BALANCE_SYNC_MS);

      expect(await mockToken.balanceOf(owner.address)).to.equal(ownerBefore - amount);
      const handle = await privateToken["balanceOf(address)"](owner.address);
      const decrypted = await decryptValueViaProxy(handle, owner, ownerAesKey, PROXY_URL);
      expect(decrypted).to.equal(amount);
    });

    it("mints an OPRF note to the signer via facilitator", async function () {
      const quantityIt = buildUnsignedItUint256({
        value: NOTE_AMOUNT,
        userAddress: owner.address,
        userAesKeyHex: ownerAesKeyHex,
        contractAddress: tokenAddress,
      });
      const data = privateToken.interface.encodeFunctionData("mintOPRFToken", [quantityIt]);
      const receipt = await execAsOwner(data);
      await delay(DELAY_MPC_EXTENDED_MS);

      const minted = getOprfMintedEventsFromReceipt(receipt, privateToken);
      expect(minted[0]?.user.toLowerCase()).to.equal(owner.address.toLowerCase());
      expect(minted.some((e) => e.user.toLowerCase() === facilitator.address.toLowerCase())).to.equal(
        false
      );
    });
  });

  describe("OPRF IT user consistency", function () {
    it("reverts splitToken when x/q/qSplit userAddresses disagree", async function () {
      const other = Wallet.createRandom().address;
      await expect(
        privateToken.splitToken(dummyIt128(owner.address), dummyIt256(other), 0, dummyIt256(owner.address))
      ).to.be.revertedWith("OPRF IT user mismatch");
    });

    it("reverts redeemMany when amount IT userAddress differs from token ITs", async function () {
      const other = Wallet.createRandom().address;
      await expect(
        privateToken.redeemMany(
          [{ x: dummyIt128(owner.address), q: dummyIt256(owner.address), y_clear: 1n }],
          dummyIt256(other),
          owner.address
        )
      ).to.be.revertedWith("OPRF IT user mismatch");
    });
  });

  describe("unsigned dest lock vs signed any destination", function () {
    it("unsigned relayer cannot redeem to itself", async function () {
      await expect(
        privateToken
          .connect(facilitator)
          .redeemManyToUnderlying(
            [{ x: dummyIt128(owner.address), q: dummyIt256(owner.address), y_clear: 1n }],
            dummyIt256(owner.address),
            facilitator.address,
            false
          )
      ).to.be.revertedWith("Relayer dest must be IT owner");
    });

    it("signed redeemManyToUnderlying can pay a third party", async function () {
      const quantityIt = buildUnsignedItUint256({
        value: NOTE_AMOUNT,
        userAddress: owner.address,
        userAesKeyHex: ownerAesKeyHex,
        contractAddress: tokenAddress,
      });
      await mintAndApprove({
        mockToken,
        privateToken,
        userAddress: owner.address,
        amount: NOTE_AMOUNT,
      });
      await execAsOwner(privateToken.interface.encodeFunctionData("shield", [NOTE_AMOUNT]));
      await delay(DELAY_BALANCE_SYNC_MS);
      const mintReceipt = await execAsOwner(
        privateToken.interface.encodeFunctionData("mintOPRFToken", [quantityIt])
      );
      await delay(DELAY_MPC_EXTENDED_MS);

      const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
      expect(mintHandles).to.not.be.undefined;

      const [x, y, q] = await decryptMultipleValuesViaProxy(
        [mintHandles!.xHandle, mintHandles!.yHandle, mintHandles!.qHandle],
        owner,
        ownerAesKey,
        PROXY_URL
      );

      const tokenInput = [
        {
          x: buildUnsignedItUint128({
            value: x,
            userAddress: owner.address,
            userAesKeyHex: ownerAesKeyHex,
            contractAddress: tokenAddress,
          }),
          q: buildUnsignedItUint256({
            value: q,
            userAddress: owner.address,
            userAesKeyHex: ownerAesKeyHex,
            contractAddress: tokenAddress,
          }),
          y_clear: y,
        },
      ];
      const amountIt = buildUnsignedItUint256({
        value: PAY_AMOUNT,
        userAddress: owner.address,
        userAesKeyHex: ownerAesKeyHex,
        contractAddress: tokenAddress,
      });

      const destBefore = await mockToken.balanceOf(destination.address);
      const startBlock = await hre.ethers.provider.getBlockNumber();
      const redeemData = privateToken.interface.encodeFunctionData("redeemManyToUnderlying", [
        tokenInput,
        amountIt,
        destination.address,
        false,
      ]);
      await execAsOwner(redeemData);

      const { successEvents, failedEvents } = await waitForUnshieldOutcome(privateToken, hre, startBlock, {
        timeoutMs: DELAY_MPC_REDEEM_MS * 6,
        pollIntervalMs: 3000,
      });
      expect(failedEvents.length).to.equal(0);
      expect(successEvents.length).to.be.greaterThan(0);
      const unshieldTo = (successEvents[0].args?.to ?? successEvents[0].args?.[0]) as string;
      expect(unshieldTo.toLowerCase()).to.equal(destination.address.toLowerCase());
      expect(await mockToken.balanceOf(destination.address)).to.equal(destBefore + PAY_AMOUNT);
    });
  });
});

describe("PrivateERC20Contract256 (original msg.sender model)", function () {
  this.timeout(900000);

  let owner: any;
  let facilitator: any;
  let ownerAesKey: Buffer;
  let ownerAesKeyHex: string;
  let mockToken: any;
  let original: any;

  before(async function () {
    const network = await hre.ethers.provider.getNetwork();
    if (network.chainId === 31337n || shouldSkip()) {
      this.skip();
    }

    const signers = await hre.ethers.getSigners();
    owner = signers[0];
    facilitator = signers[1] ?? Wallet.createRandom().connect(hre.ethers.provider);

    ownerAesKey = await getUserKeyViaProxy(owner, PROXY_URL);
    ownerAesKeyHex = ownerAesKey.toString("hex");

    mockToken = await deployMockToken(hre, owner, "Original Test USD", "OTUSD");
    original = await deployPrivateToken(hre, owner, {
      underlyingAddress: await mockToken.getAddress(),
      ownerAddress: owner.address,
      masterAddress: owner.address,
      name: "Original Token",
      symbol: "ORIG",
    });

    await mintAndApprove({
      mockToken,
      privateToken: original,
      userAddress: owner.address,
      amount: NOTE_AMOUNT,
    });
  });

  it("does not dest-lock unsigned relayer redeem", async function () {
    await expect(
      original
        .connect(facilitator)
        .redeemManyToUnderlying(
          [{ x: dummyIt128(owner.address), q: dummyIt256(owner.address), y_clear: 1n }],
          dummyIt256(owner.address),
          facilitator.address,
          false
        )
    ).to.not.be.revertedWith("Relayer dest must be IT owner");
  });

  it("owner mints an OPRF note with msg.sender (no executeWithAuthorization)", async function () {
    await (await original.connect(owner).shield(NOTE_AMOUNT)).wait();
    await delay(DELAY_BALANCE_SYNC_MS);

    const quantityIt = await buildSignedItUint256({
      value: NOTE_AMOUNT,
      userAddress: owner.address,
      userAesKeyHex: ownerAesKeyHex,
      contractAddress: await original.getAddress(),
      signer: owner,
    });
    const tx = await original.connect(owner).mintOPRFToken(quantityIt);
    const receipt = await tx.wait();
    await delay(DELAY_MPC_EXTENDED_MS);

    const minted = getOprfMintedEventsFromReceipt(receipt, original);
    expect(minted.length).to.be.greaterThan(0);
    expect(minted[0]?.user.toLowerCase()).to.equal(owner.address.toLowerCase());
  });
});
