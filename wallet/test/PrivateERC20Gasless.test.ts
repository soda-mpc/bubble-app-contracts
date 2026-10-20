/**
 * Gasless user flows of PrivateERC20Contract256Gasless on a Bubble network (not Hardhat 31337): a facilitator
 * submits the user's signed operations through the ERC-2771 forwarder and pays gas, including OPRF notes (mint,
 * owner consistency, destination lock, signed redeem to a third party). The original PrivateERC20Contract256 is
 * covered for comparison (msg.sender mint, no destination lock).
 *
 * This file: `npm run test:gasless:arbitrum-sepolia`
 * Local forwarder checks (no MPC): `npm run test:gasless`
 */
import { expect } from "chai";
import hre from "hardhat";
import { HDNodeWallet, Wallet } from "ethers";
import dotenv from "dotenv";

import {
  decryptMultipleValuesViaProxy,
  decryptValueViaProxy,
  getUserKeyViaProxy,
} from "./helpers/bubbleCryptoTransport";
import { signExecuteWithAuthorization, signTransientInsertPermission } from "./helpers/gaslessAuth";
import { encodeEncryptedTransfer, encodeShield } from "./helpers/gaslessCalldata";
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
  findParsedLogInReceipt,
  findParsedLogInReceiptWhere,
  getGcAclAddress,
  getGcAclContract,
  getPrivateTokenBalance,
  getPrivateTransferAmountHandle,
  getOprfMintedEventsFromReceipt,
  getOprfMintedHandlesFromReceipt,
  mintAndApprove,
  waitForUnshieldOutcome,
} from "./helpers/testHelpers";

dotenv.config();

const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const TOKEN_NAME = "Gasless Bubble Token";
const UNDERLYING_NAME = "Gasless Test USD";
const NOTE_AMOUNT = 50n * 10n ** 18n;
const PAY_AMOUNT = 10n ** 17n;

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
    (!process.env.SEPOLIA_ARBITRUM_RPC_URL && !process.env.ALCHEMY_API_KEY)
  );
}

describe("PrivateERC20Contract256Gasless", function () {
  this.timeout(900000);

  let owner: any;
  let facilitator: any;
  let destination: HDNodeWallet;
  let ownerAesKey: Buffer;
  let ownerAesKeyHex: string;
  let mockToken: any;
  let privateToken: any;
  let chainId: number;
  let tokenAddress: string;
  let forwarder: any;
  let forwarderAddress: string;

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

    mockToken = await deployMockToken(hre, owner, UNDERLYING_NAME, "GTUSD");
    privateToken = await deployPrivateTokenGasless(hre, owner, {
      underlyingAddress: await mockToken.getAddress(),
      ownerAddress: owner.address,
      masterAddress: owner.address,
      name: TOKEN_NAME,
      symbol: "gBUB",
    });
    tokenAddress = await privateToken.getAddress();
    forwarder = privateToken.gaslessForwarder;
    forwarderAddress = await forwarder.getAddress();

    await mintAndApprove({
      mockToken,
      privateToken,
      userAddress: owner.address,
      amount: NOTE_AMOUNT * 2n,
    });
  });

  async function insertGrantForOwner() {
    const gcAcl = await getGcAclContract(hre, owner);
    const nonce = await gcAcl.transientInsertNonce(owner.address);
    return signTransientInsertPermission({
      signer: owner,
      user: owner.address,
      token: tokenAddress,
      chainId,
      gcAcl: getGcAclAddress(chainId),
      nonce,
    });
  }

  async function submitAsOwner(data: string, withInsertGrant = false) {
    const auth = await signExecuteWithAuthorization({
      signer: owner,
      forwarder: forwarderAddress,
      tokenName: TOKEN_NAME,
      chainId,
      from: owner.address,
      data,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });
    const insert = withInsertGrant
      ? await insertGrantForOwner()
      : { nonce: 0n, signature: "0x" };
    return forwarder
      .connect(facilitator)
      .executeWithAuthorization(
        auth.from,
        auth.data,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        auth.signature,
        insert.nonce,
        insert.signature
      );
  }

  async function ownerPrivateBalance(): Promise<bigint> {
    await delay(DELAY_BALANCE_SYNC_MS);
    return getPrivateTokenBalance({ privateToken, address: owner.address, signer: owner, aesKey: ownerAesKey, proxyUrl: PROXY_URL });
  }

  async function execAsOwner(data: string, withInsertGrant = false) {
    const tx = await submitAsOwner(data, withInsertGrant);
    return tx.wait();
  }

  describe("executeWithAuthorization", function () {
    it("rejects owner/admin functions even when the owner signed the call", async function () {
      const data = privateToken.interface.encodeFunctionData("pause", []);
      const auth = await signExecuteWithAuthorization({
        signer: owner,
        forwarder: forwarderAddress,
        tokenName: TOKEN_NAME,
        chainId,
        from: owner.address,
        data,
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      });

      await expect(
        forwarder
          .connect(facilitator)
          .executeWithAuthorization(
            auth.from,
            auth.data,
            auth.validAfter,
            auth.validBefore,
            auth.nonce,
            auth.signature,
            0,
            "0x"
          )
      ).to.be.revertedWithCustomError(privateToken, "OwnableUnauthorizedAccount").withArgs(forwarderAddress);
      expect(await privateToken.paused()).to.equal(false);
      expect(await forwarder.authorizationUsed(owner.address, auth.nonce)).to.equal(false);
    });

    it("cancelAuthorization makes a signed authorization unusable", async function () {
      const auth = await signExecuteWithAuthorization({
        signer: owner,
        forwarder: forwarderAddress,
        tokenName: TOKEN_NAME,
        chainId,
        from: owner.address,
        data: privateToken.interface.encodeFunctionData("shield", [1n]),
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      });
      await expect(forwarder.connect(owner).cancelAuthorization(auth.nonce)).to.emit(forwarder, "AuthorizationCanceled");
      await expect(
        forwarder
          .connect(facilitator)
          .executeWithAuthorization(auth.from, auth.data, auth.validAfter, auth.validBefore, auth.nonce, auth.signature, 0, "0x")
      ).to.be.revertedWith("Auth used");
    });

    it("rejects when the EIP-712 signer is not `from`", async function () {
      const data = privateToken.interface.encodeFunctionData("shield", [1n]);
      const auth = await signExecuteWithAuthorization({
        signer: facilitator,
        forwarder: forwarderAddress,
        tokenName: TOKEN_NAME,
        chainId,
        from: owner.address,
        data,
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      });

      await expect(
        forwarder
          .connect(facilitator)
          .executeWithAuthorization(
            auth.from,
            auth.data,
            auth.validAfter,
            auth.validBefore,
            auth.nonce,
            auth.signature,
            0,
            "0x"
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
      const receipt = await execAsOwner(data, true);
      await delay(DELAY_MPC_EXTENDED_MS);

      const minted = getOprfMintedEventsFromReceipt(receipt, privateToken);
      expect(minted[0]?.user.toLowerCase()).to.equal(owner.address.toLowerCase());
      expect(minted.some((e) => e.user.toLowerCase() === facilitator.address.toLowerCase())).to.equal(
        false
      );
    });

    it("reverts a facilitator mint when the owner did not grant transient insert", async function () {
      const quantityIt = buildUnsignedItUint256({
        value: NOTE_AMOUNT,
        userAddress: owner.address,
        userAesKeyHex: ownerAesKeyHex,
        contractAddress: tokenAddress,
      });
      const data = privateToken.interface.encodeFunctionData("mintOPRFToken", [quantityIt]);
      await expect(submitAsOwner(data, false)).to.be.reverted;
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
        privateToken.interface.encodeFunctionData("mintOPRFToken", [quantityIt]),
        true
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
      const redeemReceipt = await execAsOwner(redeemData, true);
      // The redeem path announces the payout too: recipient, amount 0 (encrypted), and the decrypt request.
      const requested = redeemReceipt.logs
        .map((log: { topics: string[]; data: string }) => {
          try {
            return privateToken.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((parsed: { name: string } | null) => parsed?.name === "UnshieldRequested");
      expect(requested, "UnshieldRequested").to.not.be.undefined;
      expect(requested.args.to).to.equal(destination.address);
      expect(requested.args.amount).to.equal(0n);
      expect(requested.args.decryptId).to.be.a("bigint");

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

  describe("gasless user operations", function () {
  it("shields, transfers, and unshields from signatures, including a permit for the underlying", async function () {
    const shieldAmount = 3n * 10n ** 18n;
    const moveAmount = 10n ** 18n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const underlying = await mockToken.getAddress();

    await (await mockToken.mint(owner.address, shieldAmount)).wait();
    const permitSig = hre.ethers.Signature.from(
      await owner.signTypedData(
        {
          name: UNDERLYING_NAME,
          version: "1",
          chainId,
          verifyingContract: underlying,
        },
        {
          Permit: [
            { name: "owner", type: "address" },
            { name: "spender", type: "address" },
            { name: "value", type: "uint256" },
            { name: "nonce", type: "uint256" },
            { name: "deadline", type: "uint256" },
          ],
        },
        {
          owner: owner.address,
          spender: tokenAddress,
          value: shieldAmount,
          nonce: await mockToken.nonces(owner.address),
          deadline,
        }
      )
    );
    const permitTx = await mockToken
      .connect(facilitator)
      .permit(owner.address, tokenAddress, shieldAmount, deadline, permitSig.v, permitSig.r, permitSig.s);
    const permitReceipt = await permitTx.wait();
    expect(permitReceipt.from.toLowerCase()).to.equal(facilitator.address.toLowerCase());
    expect(await mockToken.allowance(owner.address, tokenAddress)).to.equal(shieldAmount);

    const underlyingBefore = await mockToken.balanceOf(owner.address);
    const shieldTx = await submitAsOwner(encodeShield(shieldAmount));
    const shieldReceipt = await shieldTx.wait();
    expect(shieldReceipt.from.toLowerCase()).to.equal(facilitator.address.toLowerCase());
    await delay(DELAY_BALANCE_SYNC_MS);
    expect(await mockToken.balanceOf(owner.address)).to.equal(underlyingBefore - shieldAmount);
    const privateBefore = await ownerPrivateBalance();

    const clearData = privateToken.interface.encodeFunctionData("transfer(address,uint256)", [
      destination.address,
      moveAmount,
    ]);
    await expect(submitAsOwner(clearData))
      .to.emit(privateToken, "Transfer")
      .withArgs(owner.address, destination.address, moveAmount);
    // `Transfer` carries the requested amount even if nothing moved, so check the balance.
    expect(await ownerPrivateBalance(), "clear transfer debit").to.equal(privateBefore - moveAmount);

    const amountIt = buildUnsignedItUint256({
      value: moveAmount,
      userAddress: owner.address,
      userAesKeyHex: ownerAesKeyHex,
      contractAddress: tokenAddress,
    });
    const privateReceipt = await execAsOwner(encodeEncryptedTransfer(destination.address, amountIt), true);
    const privateTransferLog = findParsedLogInReceipt(privateReceipt, privateToken, "PrivateTransfer");
    expect(privateTransferLog, "Expected PrivateTransfer event").to.not.equal(undefined);
    const privateTransfer = privateToken.interface.parseLog(privateTransferLog);
    expect(privateTransfer.args.from).to.equal(owner.address);
    expect(privateTransfer.args.to).to.equal(destination.address);
    await delay(DELAY_BALANCE_SYNC_MS);
    const movedHandle = getPrivateTransferAmountHandle(privateReceipt, privateToken);
    expect(await decryptValueViaProxy(movedHandle, owner, ownerAesKey, PROXY_URL), "encrypted transfer amount").to.equal(
      moveAmount
    );
    expect(await ownerPrivateBalance(), "encrypted transfer debit").to.equal(privateBefore - 2n * moveAmount);

    const approveData = privateToken.interface.encodeFunctionData("approve(address,uint256)", [
      destination.address,
      moveAmount,
    ]);
    const approveReceipt = await execAsOwner(approveData);
    // `Approval` is overloaded; the clear approve emits the 3-argument one.
    const approvalLog = findParsedLogInReceiptWhere(
      approveReceipt,
      privateToken,
      "Approval",
      (parsed) => parsed.args?.length === 3
    );
    expect(approvalLog, "Expected the 3-argument Approval event").to.not.equal(undefined);
    const approval = privateToken.interface.parseLog(approvalLog);
    expect(approval.args[0]).to.equal(owner.address);
    expect(approval.args[1]).to.equal(destination.address);
    expect(approval.args[2]).to.equal(moveAmount);

    const startBlock = await hre.ethers.provider.getBlockNumber();
    const unshieldTx = await submitAsOwner(privateToken.interface.encodeFunctionData("unshield", [moveAmount]));
    const unshieldReceipt = await unshieldTx.wait();
    expect(unshieldReceipt.from.toLowerCase()).to.equal(facilitator.address.toLowerCase());
    const { successEvents, failedEvents, parkedEvents } = await waitForUnshieldOutcome(privateToken, hre, startBlock, {
      timeoutMs: DELAY_MPC_REDEEM_MS * 6,
      pollIntervalMs: 3000,
    });
    expect(failedEvents.length, "unshield failed").to.equal(0);
    expect(parkedEvents.length, "unshield payout parked").to.equal(0);
    expect(successEvents.length).to.be.greaterThan(0);
    const unshieldTo = (successEvents[0].args?.to ?? successEvents[0].args?.[0]) as string;
    expect(unshieldTo.toLowerCase()).to.equal(owner.address.toLowerCase());
    expect(await mockToken.balanceOf(owner.address)).to.equal(underlyingBefore - shieldAmount + moveAmount);
    expect(await ownerPrivateBalance(), "unshield debit").to.equal(privateBefore - 3n * moveAmount);
  });
  });
});

describe("PrivateERC20Contract256 (original msg.sender model)", function () {
  this.timeout(900000);

  let owner: any;
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
