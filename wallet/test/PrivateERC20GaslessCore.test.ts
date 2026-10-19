/**
 * Core behaviour of PrivateERC20Contract256Gasless on a Bubble network (not Hardhat 31337): self-transfer semantics
 * and the emergency-recovery lifecycle (retirement, in-flight unshields, parked payouts).
 *
 * Run: npx hardhat test test/PrivateERC20GaslessCore.test.ts --network sepolia-arbitrum
 */
import { expect } from "chai";
import hre from "hardhat";
import { Wallet } from "ethers";
import dotenv from "dotenv";

import { decryptValueViaProxy, getUserKeyViaProxy } from "./helpers/bubbleCryptoTransport";
import {
  buildUnsignedItUint256,
  DELAY_BALANCE_SYNC_MS,
  DELAY_MPC_REDEEM_MS,
  delay,
  deployMockToken,
  deployPrivateTokenGasless,
  getPrivateTokenBalance,
  getPrivateTransferAmountHandle,
  mintAndApprove,
  waitForUnshieldOutcome,
} from "./helpers/testHelpers";

dotenv.config();

const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const TOKEN_NAME = "Gasless Core Token";
const NOTE_AMOUNT = 50n * 10n ** 18n + BigInt(Math.floor(Math.random() * 1_000_000));

function shouldSkip(): boolean {
  return (
    !process.env.MNEMONIC ||
    (!process.env.SEPOLIA_ARBITRUM_RPC_URL && !process.env.ALCHEMY_API_KEY)
  );
}

describe("PrivateERC20Contract256Gasless core", function () {
  this.timeout(900000);

  let owner: any;
  /** Second account: spender, non-owner and payee in the tests below. */
  let attacker: any;
  let ownerAesKey: Buffer;
  let ownerAesKeyHex: string;
  let mockToken: any;
  let privateToken: any;
  let tokenAddress: string;

  before(async function () {
    const network = await hre.ethers.provider.getNetwork();
    if (network.chainId === 31337n || shouldSkip()) {
      this.skip();
    }

    const signers = await hre.ethers.getSigners();
    owner = signers[0];
    attacker = signers[1] ?? Wallet.createRandom().connect(hre.ethers.provider);

    if ((await hre.ethers.provider.getBalance(attacker.address)) < hre.ethers.parseEther("0.0002")) {
      await (await owner.sendTransaction({
        to: attacker.address,
        value: hre.ethers.parseEther("0.002"),
      })).wait();
    }

    ownerAesKey = await getUserKeyViaProxy(owner, PROXY_URL);
    ownerAesKeyHex = ownerAesKey.toString("hex");

    mockToken = await deployMockToken(hre, owner, "Gasless Core USD", "GCUSD");
    privateToken = await deployPrivateTokenGasless(hre, owner, {
      underlyingAddress: await mockToken.getAddress(),
      ownerAddress: owner.address,
      masterAddress: owner.address,
      name: TOKEN_NAME,
      symbol: "gCORE",
    });
    tokenAddress = await privateToken.getAddress();

    await mintAndApprove({
      mockToken,
      privateToken,
      userAddress: owner.address,
      amount: NOTE_AMOUNT * 2n,
    });
    await (await privateToken.connect(owner).shield(NOTE_AMOUNT)).wait();
    await delay(DELAY_BALANCE_SYNC_MS);
  });

  function ownerIt256(value: bigint) {
    return buildUnsignedItUint256({ value, userAddress: owner.address, userAesKeyHex: ownerAesKeyHex, contractAddress: tokenAddress });
  }

  async function ownerBalance(): Promise<bigint> {
    await delay(DELAY_BALANCE_SYNC_MS);
    return getPrivateTokenBalance({ privateToken, address: owner.address, signer: owner, aesKey: ownerAesKey, proxyUrl: PROXY_URL });
  }

  describe("PrivateTransfer amount on self-transfers", function () {
    it("emits the transferred amount when the balance suffices", async function () {
      const value = 1000n;
      const balanceBefore = await ownerBalance();
      const receipt = await (
        await privateToken.connect(owner)["transfer(address,(address,(uint256,uint256)))"](owner.address, ownerIt256(value))
      ).wait();
      await delay(DELAY_BALANCE_SYNC_MS);
      const handle = getPrivateTransferAmountHandle(receipt, privateToken);
      expect(await decryptValueViaProxy(handle, owner, ownerAesKey, PROXY_URL)).to.equal(value);
      expect(await ownerBalance(), "self-transfer changed the balance").to.equal(balanceBefore);
    });

    it("emits zero when the balance does not suffice", async function () {
      const balanceBefore = await ownerBalance();
      const receipt = await (
        await privateToken
          .connect(owner)
          ["transfer(address,(address,(uint256,uint256)))"](owner.address, ownerIt256(NOTE_AMOUNT * 10n))
      ).wait();
      await delay(DELAY_BALANCE_SYNC_MS);
      const handle = getPrivateTransferAmountHandle(receipt, privateToken);
      expect(await decryptValueViaProxy(handle, owner, ownerAesKey, PROXY_URL)).to.equal(0n);
      expect(await ownerBalance(), "self-transfer changed the balance").to.equal(balanceBefore);
    });

    it("self transferFrom spends the allowance only when both the balance and the allowance cover it", async function () {
      async function ownerAllowance(): Promise<bigint> {
        await delay(DELAY_BALANCE_SYNC_MS);
        const handle: bigint = await privateToken.allowance(owner.address, attacker.address);
        return decryptValueViaProxy(handle, owner, ownerAesKey, PROXY_URL);
      }
      const selfTransferFrom = async (value: bigint) =>
        (
          await privateToken
            .connect(attacker)
            ["transferFrom(address,address,uint256)"](owner.address, owner.address, value)
        ).wait();

      const balanceBefore = await ownerBalance();
      await (await privateToken.connect(owner)["approve(address,uint256)"](attacker.address, 5n)).wait();
      await selfTransferFrom(2n);
      expect(await ownerAllowance(), "covered: allowance spent").to.equal(3n);

      await selfTransferFrom(10n);
      expect(await ownerAllowance(), "allowance too small: unchanged").to.equal(3n);

      const huge = NOTE_AMOUNT * 100n;
      await (await privateToken.connect(owner)["approve(address,uint256)"](attacker.address, huge)).wait();
      await selfTransferFrom(huge);
      expect(await ownerAllowance(), "balance too small: unchanged").to.equal(huge);
      expect(await ownerBalance(), "self transferFrom changed the balance").to.equal(balanceBefore);
    });

    it("encrypted and raw-handle self transferFrom spend the allowance and leave the balance unchanged", async function () {
      // The owner is its own spender, so the IT and the handle both belong to the caller.
      async function selfAllowance(): Promise<bigint> {
        await delay(DELAY_BALANCE_SYNC_MS);
        const handle: bigint = await privateToken.allowance(owner.address, owner.address);
        return decryptValueViaProxy(handle, owner, ownerAesKey, PROXY_URL);
      }
      const balance = await ownerBalance();
      expect(balance > 2n, "owner needs a private balance").to.equal(true);

      await (await privateToken.connect(owner)["approve(address,uint256)"](owner.address, 5n)).wait();
      await (
        await privateToken
          .connect(owner)
          ["transferFrom(address,address,(address,(uint256,uint256)))"](owner.address, owner.address, ownerIt256(2n))
      ).wait();
      expect(await selfAllowance(), "encrypted: allowance spent").to.equal(3n);
      expect(await ownerBalance(), "encrypted: balance changed").to.equal(balance);

      // Raw handle: the owner's own balance handle, so the amount is the whole balance.
      await (await privateToken.connect(owner)["approve(address,uint256)"](owner.address, balance + 1n)).wait();
      const balanceHandle: bigint = await privateToken["balanceOf(address)"](owner.address);
      await (await privateToken.connect(owner).contractTransferFrom(owner.address, owner.address, balanceHandle)).wait();
      expect(await selfAllowance(), "raw handle: allowance spent").to.equal(1n);
      expect(await ownerBalance(), "raw handle: balance changed").to.equal(balance);
    });
  });

  describe("Underlying", function () {
    it("shield rejects a fee-on-transfer underlying", async function () {
      const feeToken: any = await hre.ethers.deployContract("FeeOnTransferERC20", ["Fee USD", "FUSD"], owner);
      await feeToken.waitForDeployment();
      const feePrivate = await deployPrivateTokenGasless(hre, owner, {
        underlyingAddress: await feeToken.getAddress(),
        ownerAddress: owner.address,
        masterAddress: owner.address,
        name: "Fee Token",
        symbol: "gFEE",
      });
      const amount = 10n ** 18n;
      await mintAndApprove({ mockToken: feeToken, privateToken: feePrivate, userAddress: owner.address, amount });
      await expect(feePrivate.connect(owner).shield(amount)).to.be.revertedWith("Fee-on-transfer not supported");
    });
  });

  describe("Emergency recovery", function () {
    it("emergencyRecovery retires the token, drops in-flight unshields and sweeps later deposits", async function () {
      // Own token: recovery pauses it for good.
      const underlying = await deployMockToken(hre, owner, "Retire USD", "RUSD");
      const retiring = await deployPrivateTokenGasless(hre, owner, {
        underlyingAddress: await underlying.getAddress(),
        ownerAddress: owner.address,
        masterAddress: owner.address,
        name: "Retiring Token",
        symbol: "gRET",
      });
      const retiringAddress = await retiring.getAddress();
      const amount = 10n ** 18n;
      await mintAndApprove({ mockToken: underlying, privateToken: retiring, userAddress: owner.address, amount: 2n * amount });
      await (await retiring.connect(owner).shield(2n * amount)).wait();
      await delay(DELAY_BALANCE_SYNC_MS);

      await expect(retiring.connect(attacker).emergencyRecovery())
        .to.be.revertedWithCustomError(retiring, "OwnableUnauthorizedAccount")
        .withArgs(attacker.address);

      // Unshield, then recover right away so recovery lands before the decryption callback.
      const ownerBefore: bigint = await underlying.balanceOf(owner.address);
      const startBlock = await hre.ethers.provider.getBlockNumber();
      const unshieldTx = await retiring.connect(owner).unshield(amount);
      const recoveryTx = await retiring.connect(owner).emergencyRecovery();
      await unshieldTx.wait();
      // Recovery takes all backing, including the amount the pending unshield would have paid.
      await expect(recoveryTx).to.emit(retiring, "EmergencyRecovery").withArgs(owner.address, 2n * amount);

      expect(await retiring.retired()).to.equal(true);
      expect(await retiring.paused()).to.equal(true);
      expect(await retiring.totalSupply()).to.equal(0n);

      // The callback for the pre-recovery request is dropped: no payout, nothing parked.
      const { successEvents, failedEvents, parkedEvents } = await waitForUnshieldOutcome(retiring, hre, startBlock, {
        timeoutMs: DELAY_MPC_REDEEM_MS * 6,
        pollIntervalMs: 3000,
      });
      expect(successEvents.length, "in-flight unshield paid").to.equal(0);
      expect(parkedEvents.length, "in-flight unshield parked").to.equal(0);
      expect(failedEvents.length, "in-flight unshield not dropped").to.equal(1);
      expect(await underlying.balanceOf(owner.address)).to.equal(ownerBefore + 2n * amount);
      expect(await retiring.claimableUnderlying(owner.address)).to.equal(0n);

      await expect(retiring.connect(owner).unpause()).to.be.revertedWith("Token retired");
      await expect(retiring.connect(owner).unshield(amount)).to.be.revertedWithCustomError(retiring, "EnforcedPause");
      await expect(retiring.connect(owner).shield(amount)).to.be.revertedWithCustomError(retiring, "EnforcedPause");

      // Underlying sent straight to a retired token backs nothing; a later recovery sweeps it.
      await (await underlying.mint(retiringAddress, amount)).wait();
      await expect(retiring.connect(owner).emergencyRecovery())
        .to.emit(retiring, "EmergencyRecovery")
        .withArgs(owner.address, amount);
    });

    it("a parked unshield payout survives recovery and stays claimable on the retired token", async function () {
      // An underlying that can refuse transfers, so the callback's push to the payee fails and is parked.
      const underlying: any = await hre.ethers.deployContract("BlockableERC20", ["Blockable USD", "BUSD"], owner);
      await underlying.waitForDeployment();
      const payee = attacker; // master: receives unshieldForMaster payouts
      const parking = await deployPrivateTokenGasless(hre, owner, {
        underlyingAddress: await underlying.getAddress(),
        ownerAddress: owner.address,
        masterAddress: payee.address,
        name: "Parking Token",
        symbol: "gPRK",
      });
      const parkingAddress = await parking.getAddress();
      const amount = 10n ** 18n;
      await mintAndApprove({ mockToken: underlying, privateToken: parking, userAddress: owner.address, amount: 2n * amount });
      await (await parking.connect(owner).shield(2n * amount)).wait();
      await delay(DELAY_BALANCE_SYNC_MS);

      await (await underlying.setBlocked(payee.address, true)).wait();
      const startBlock = await hre.ethers.provider.getBlockNumber();
      await (await parking.connect(owner).unshieldForMaster(amount)).wait();
      const { successEvents, failedEvents, parkedEvents } = await waitForUnshieldOutcome(parking, hre, startBlock, {
        timeoutMs: DELAY_MPC_REDEEM_MS * 6,
        pollIntervalMs: 3000,
      });
      expect(successEvents.length, "payout went through").to.equal(0);
      expect(failedEvents.length, "payout dropped").to.equal(0);
      expect(parkedEvents.length, "payout not parked").to.equal(1);
      expect(await parking.claimableUnderlying(payee.address)).to.equal(amount);

      // Recovery takes only the unreserved half; the parked amount stays in the contract.
      await expect(parking.connect(owner).emergencyRecovery())
        .to.emit(parking, "EmergencyRecovery")
        .withArgs(owner.address, amount);
      expect(await parking.retired()).to.equal(true);
      expect(await underlying.balanceOf(parkingAddress)).to.equal(amount);

      await (await underlying.setBlocked(payee.address, false)).wait();
      await expect(parking.connect(payee).claimUnshielded(payee.address))
        .to.emit(parking, "UnshieldClaimed")
        .withArgs(payee.address, payee.address, amount);
      expect(await underlying.balanceOf(payee.address)).to.equal(amount);
      expect(await parking.claimableUnderlying(payee.address)).to.equal(0n);
    });
  });
});
