import { expect } from "chai";
import { Interface } from "ethers";
import { randomBytes } from "crypto";
import hre from "hardhat";
import {
  deploySafeWallet,
  execSafeTransaction,
  getOrDeploySafeInfrastructure,
  packSafeSignatures,
} from "../helpers/safeHelpers";
import { decryptItUint256, prepareMessageForBubble256 } from "../helpers/bubbleCryptoTransport";
import {
  assertInformedEncryptedTransfer,
  assertInformedClearTransfer,
  encodeEncryptedTransfer,
} from "../helpers/safeInformedSign";
import { expectReverted } from "../helpers/testHelpers";

describe("Safe infrastructure", function () {
  it("deploys SafeL2 and SafeProxyFactory locally on hardhat", async function () {
    const infrastructure = await getOrDeploySafeInfrastructure(hre);
    expect(infrastructure.safeL2Address).to.properAddress;
    expect(infrastructure.factoryAddress).to.properAddress;
    expect(infrastructure.source).to.equal("local");

    const safeL2Code = await hre.ethers.provider.getCode(infrastructure.safeL2Address);
    const factoryCode = await hre.ethers.provider.getCode(infrastructure.factoryAddress);
    expect(safeL2Code.length).to.be.greaterThan(2);
    expect(factoryCode.length).to.be.greaterThan(2);
  });

  it("creates a 1-of-1 Safe proxy with setup owners", async function () {
    const [owner] = await hre.ethers.getSigners();
    const deployed = await deploySafeWallet(hre, [owner.address], 1, 7n);

    expect(deployed.safeAddress).to.properAddress;
    expect(await deployed.safe.VERSION()).to.equal("1.4.1");
    expect(await deployed.safe.getThreshold()).to.equal(1n);
    expect(await deployed.safe.getOwners()).to.deep.equal([owner.address]);
    expect(await deployed.safe.nonce()).to.equal(0n);
  });

  it("opens an itUint256 locally with the shared AES key", async function () {
    const user = hre.ethers.Wallet.createRandom();
    const aesKeyHex = randomBytes(16).toString("hex");
    const amount = 42n * 10n ** 18n;
    const { encryptedHigh, encryptedLow } = prepareMessageForBubble256(
      amount,
      user.address,
      aesKeyHex,
      user.address
    );
    expect(decryptItUint256(Buffer.from(aesKeyHex, "hex"), encryptedHigh, encryptedLow)).to.equal(amount);
  });

  describe("informed sign (co-signer inspects before signing)", function () {
    it("lets any co-signer open an encrypted transfer IT and accept the claimed amount", function () {
      const cryptoOwner = hre.ethers.Wallet.createRandom();
      const recipient = hre.ethers.Wallet.createRandom();
      const token = hre.ethers.Wallet.createRandom();
      const sharedAesKeyHex = randomBytes(16).toString("hex");
      const amount = 5n * 10n ** 18n;
      const { encryptedHigh, encryptedLow } = prepareMessageForBubble256(
        amount,
        cryptoOwner.address,
        sharedAesKeyHex,
        token.address
      );
      const data = encodeEncryptedTransfer(recipient.address, {
        userAddress: cryptoOwner.address,
        ciphertext: { ciphertextHigh: encryptedHigh, ciphertextLow: encryptedLow },
      });

      const opened = assertInformedEncryptedTransfer({
        data,
        sharedAesKey: sharedAesKeyHex,
        expectedRecipient: recipient.address,
        expectedAmount: amount,
        expectedUserAddress: cryptoOwner.address,
      });
      expect(opened.amount).to.equal(amount);
      expect(opened.recipient).to.equal(recipient.address);
    });

    it("refuses to sign when the IT amount does not match the claimed intent", function () {
      const cryptoOwner = hre.ethers.Wallet.createRandom();
      const recipient = hre.ethers.Wallet.createRandom();
      const token = hre.ethers.Wallet.createRandom();
      const sharedAesKeyHex = randomBytes(16).toString("hex");
      const realAmount = 5n * 10n ** 18n;
      const claimedAmount = 1n * 10n ** 18n;
      const { encryptedHigh, encryptedLow } = prepareMessageForBubble256(
        realAmount,
        cryptoOwner.address,
        sharedAesKeyHex,
        token.address
      );
      const data = encodeEncryptedTransfer(recipient.address, {
        userAddress: cryptoOwner.address,
        ciphertext: { ciphertextHigh: encryptedHigh, ciphertextLow: encryptedLow },
      });

      expect(() =>
        assertInformedEncryptedTransfer({
          data,
          sharedAesKey: sharedAesKeyHex,
          expectedRecipient: recipient.address,
          expectedAmount: claimedAmount,
          expectedUserAddress: cryptoOwner.address,
        })
      ).to.throw(/IT amount/);
    });

    it("ABI-decodes clear transfers without needing the shared AES key", function () {
      const clearIface = new Interface(["function transfer(address to, uint256 amount) returns (bool)"]);
      const recipient = hre.ethers.Wallet.createRandom().address;
      const amount = 3n * 10n ** 18n;
      const data = clearIface.encodeFunctionData("transfer", [recipient, amount]);
      const opened = assertInformedClearTransfer(data, recipient, amount);
      expect(opened.amount).to.equal(amount);
    });
  });

  it("rejects duplicate signers when packing Safe signatures", async function () {
    const owner = hre.ethers.Wallet.createRandom().address;
    expect(() =>
      packSafeSignatures([
        { signer: owner, data: "0x" + "11".repeat(65) },
        { signer: owner, data: "0x" + "22".repeat(65) },
      ])
    ).to.throw("Duplicate Safe signer");
  });

  describe("2-of-3 execTransaction", function () {
    it("executes with two owner signatures and reverts with one", async function () {
      const [ownerA, ownerB, ownerC, recipient] = await hre.ethers.getSigners();
      const deployed = await deploySafeWallet(
        hre,
        [ownerA.address, ownerB.address, ownerC.address],
        2,
        8n
      );
      const fundAmount = hre.ethers.parseEther("1");
      const sendAmount = hre.ethers.parseEther("0.1");
      await (await ownerA.sendTransaction({ to: deployed.safeAddress, value: fundAmount })).wait();

      const recipientBefore = await hre.ethers.provider.getBalance(recipient.address);
      await execSafeTransaction(
        deployed.safeAddress,
        ownerA,
        { to: recipient.address, value: sendAmount },
        { extraSigners: [ownerB] }
      );

      expect(await deployed.safe.nonce()).to.equal(1n);
      expect(await hre.ethers.provider.getBalance(deployed.safeAddress)).to.equal(fundAmount - sendAmount);
      expect(await hre.ethers.provider.getBalance(recipient.address)).to.equal(recipientBefore + sendAmount);

      await expectReverted(
        execSafeTransaction(deployed.safeAddress, ownerA, {
          to: recipient.address,
          value: 1n,
        })
      );
    });
  });
});
