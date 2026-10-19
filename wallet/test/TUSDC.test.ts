import { expect } from "chai";
import { randomBytes } from "crypto";
import hre from "hardhat";

import { signEip3009TransferWithAuthorization } from "./helpers/eip3009";

const NAME = "Test USDC";
const SYMBOL = "TUSDC";
const VERSION = "1";

const MINT_TYPES = {
  MintWithAuthorization: [
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const RECEIVE_TYPES = {
  ReceiveWithAuthorization: [
    { name: "from", type: "address" },
    { name: "to", type: "address" },
    { name: "value", type: "uint256" },
    { name: "validAfter", type: "uint256" },
    { name: "validBefore", type: "uint256" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

const CANCEL_TYPES = {
  CancelAuthorization: [
    { name: "authorizer", type: "address" },
    { name: "nonce", type: "bytes32" },
  ],
} as const;

function splitSig(signature: string) {
  const sig = hre.ethers.Signature.from(signature);
  return { v: sig.v, r: sig.r, s: sig.s };
}

describe("TUSDC gasless authorization", function () {
  it("lets a facilitator submit an EIP-2612 permit and an EIP-3009 transfer", async function () {
    const [holder, facilitator, spender] = await hre.ethers.getSigners();
    const token = await hre.ethers.deployContract("TUSDC", [NAME, SYMBOL], holder);
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();
    const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
    const domain = { name: NAME, version: VERSION, chainId, verifyingContract: tokenAddress };
    const value = 1_000n * 10n ** 18n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const permitSig = splitSig(
      await holder.signTypedData(
        domain,
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
          owner: holder.address,
          spender: spender.address,
          value,
          nonce: await token.nonces(holder.address),
          deadline,
        }
      )
    );
    await token
      .connect(facilitator)
      .permit(holder.address, spender.address, value, deadline, permitSig.v, permitSig.r, permitSig.s);
    expect(await token.allowance(holder.address, spender.address)).to.equal(value);

    const holderBefore = await token.balanceOf(holder.address);
    const auth = await signEip3009TransferWithAuthorization({
      signer: holder,
      token: tokenAddress,
      tokenName: NAME,
      tokenVersion: VERSION,
      chainId,
      from: holder.address,
      to: facilitator.address,
      value,
      validBefore: deadline,
    });
    await expect(
      token
        .connect(facilitator)
        .transferWithAuthorization(
          auth.from,
          auth.to,
          auth.value,
          auth.validAfter,
          auth.validBefore,
          auth.nonce,
          auth.v,
          auth.r,
          auth.s
        )
    )
      .to.emit(token, "AuthorizationUsed")
      .withArgs(holder.address, auth.nonce);
    expect(await token.balanceOf(facilitator.address)).to.equal(value);
    expect(await token.balanceOf(holder.address)).to.equal(holderBefore - value);

    const receiveValue = 50n * 10n ** 18n;
    const receiveNonce = "0x" + randomBytes(32).toString("hex");
    const receiveSig = splitSig(
      await holder.signTypedData(domain, RECEIVE_TYPES, {
        from: holder.address,
        to: spender.address,
        value: receiveValue,
        validAfter: 0n,
        validBefore: deadline,
        nonce: receiveNonce,
      })
    );
    await expect(
      token
        .connect(spender)
        .receiveWithAuthorization(
          holder.address,
          spender.address,
          receiveValue,
          0,
          deadline,
          receiveNonce,
          receiveSig.v,
          receiveSig.r,
          receiveSig.s
        )
    )
      .to.emit(token, "AuthorizationUsed")
      .withArgs(holder.address, receiveNonce);
    expect(await token.balanceOf(spender.address)).to.equal(receiveValue);

    const cancelNonce = "0x" + randomBytes(32).toString("hex");
    const cancelSig = splitSig(
      await holder.signTypedData(domain, CANCEL_TYPES, {
        authorizer: holder.address,
        nonce: cancelNonce,
      })
    );
    await expect(
      token.connect(facilitator).cancelAuthorization(holder.address, cancelNonce, cancelSig.v, cancelSig.r, cancelSig.s)
    )
      .to.emit(token, "AuthorizationCanceled")
      .withArgs(holder.address, cancelNonce);
    expect(await token.authorizationState(holder.address, cancelNonce)).to.equal(true);
  });

  it("lets a facilitator mint to the signer", async function () {
    const [deployer, facilitator, recipient] = await hre.ethers.getSigners();
    const token = await hre.ethers.deployContract("TUSDC", [NAME, SYMBOL], deployer);
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();
    const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
    const domain = { name: NAME, version: VERSION, chainId, verifyingContract: tokenAddress };
    const value = 250n * 10n ** 18n;
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);
    const nonce = "0x" + randomBytes(32).toString("hex");

    const mintSig = splitSig(
      await recipient.signTypedData(domain, MINT_TYPES, {
        to: recipient.address,
        value,
        validAfter: 0n,
        validBefore: deadline,
        nonce,
      })
    );

    const before = await token.balanceOf(recipient.address);
    const tx = await token
      .connect(facilitator)
      .mintWithAuthorization(recipient.address, value, 0, deadline, nonce, mintSig.v, mintSig.r, mintSig.s);
    await expect(tx)
      .to.emit(token, "AuthorizationUsed")
      .withArgs(recipient.address, nonce);
    const receipt = await tx.wait();
    expect(receipt.from.toLowerCase()).to.equal(facilitator.address.toLowerCase());
    expect(await token.balanceOf(recipient.address)).to.equal(before + value);
    expect(await token.authorizationState(recipient.address, nonce)).to.equal(true);

    await expect(
      token
        .connect(facilitator)
        .mintWithAuthorization(recipient.address, value, 0, deadline, nonce, mintSig.v, mintSig.r, mintSig.s)
    ).to.be.revertedWith("Auth used");

    const foreignNonce = "0x" + randomBytes(32).toString("hex");
    const foreignSig = splitSig(
      await facilitator.signTypedData(domain, MINT_TYPES, {
        to: recipient.address,
        value,
        validAfter: 0n,
        validBefore: deadline,
        nonce: foreignNonce,
      })
    );
    await expect(
      token
        .connect(facilitator)
        .mintWithAuthorization(recipient.address, value, 0, deadline, foreignNonce, foreignSig.v, foreignSig.r, foreignSig.s)
    ).to.be.revertedWith("Invalid signature");
  });

  it("burns only the caller's own tokens", async function () {
    const [holder, attacker] = await hre.ethers.getSigners();
    const token = await hre.ethers.deployContract("TUSDC", [NAME, SYMBOL], holder);
    await token.waitForDeployment();
    const amount = 10n * 10n ** 18n;
    await token.connect(holder).transfer(attacker.address, amount);
    const holderBefore = await token.balanceOf(holder.address);

    await token.connect(attacker).burn(amount);
    expect(await token.balanceOf(attacker.address)).to.equal(0);
    expect(await token.balanceOf(holder.address)).to.equal(holderBefore);
  });
});
