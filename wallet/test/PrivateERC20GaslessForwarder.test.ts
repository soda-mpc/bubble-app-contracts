/**
 * Local checks for PrivateERC20GaslessForwarder. No MPC.
 * The inner call is TUSDC.mint, which ignores the ERC-2771 suffix.
 *
 * Run: npm run test:gasless
 */
import { expect } from "chai";
import hre from "hardhat";

import { signCancelAuthorization, signExecuteWithAuthorization } from "./helpers/gaslessAuth";

const NAME = "Test USDC";
const SYMBOL = "TUSDC";

describe("PrivateERC20GaslessForwarder", function () {
  async function deploy() {
    const [holder, facilitator] = await hre.ethers.getSigners();
    const token = await hre.ethers.deployContract("TUSDC", [NAME, SYMBOL], holder);
    await token.waitForDeployment();
    const tokenAddress = await token.getAddress();
    const forwarder = await hre.ethers.deployContract("PrivateERC20GaslessForwarder", [tokenAddress], holder);
    await forwarder.waitForDeployment();
    const forwarderAddress = await forwarder.getAddress();
    const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
    return { holder, facilitator, token, tokenAddress, forwarder, forwarderAddress, chainId };
  }

  function mintData(token: { interface: { encodeFunctionData: Function } }, to: string, value: bigint) {
    return token.interface.encodeFunctionData("mint", [to, value]);
  }

  it("runs a signed call as the signer while the facilitator pays gas", async function () {
    const { holder, facilitator, token, forwarder, forwarderAddress, chainId } = await deploy();
    const value = 25n * 10n ** 18n;
    const before = await token.balanceOf(holder.address);
    const auth = await signExecuteWithAuthorization({
      signer: holder,
      token: forwarderAddress,
      tokenName: NAME,
      chainId,
      from: holder.address,
      data: mintData(token, holder.address, value),
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });

    const tx = await forwarder.connect(facilitator).executeWithAuthorization(
      auth.from,
      auth.data,
      auth.validAfter,
      auth.validBefore,
      auth.nonce,
      auth.signature,
      0,
      "0x"
    );
    const receipt = await tx.wait();
    expect(receipt.from.toLowerCase()).to.equal(facilitator.address.toLowerCase());
    expect(await token.balanceOf(holder.address)).to.equal(before + value);

    await expect(
      forwarder.connect(facilitator).executeWithAuthorization(
        auth.from,
        auth.data,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        auth.signature,
        0,
        "0x"
      )
    ).to.be.revertedWith("Auth used");
  });

  it("rejects an expired authorization and a signature from the wrong account", async function () {
    const { holder, facilitator, token, forwarder, forwarderAddress, chainId } = await deploy();
    const data = mintData(token, holder.address, 1n);
    const expired = await signExecuteWithAuthorization({
      signer: holder,
      token: forwarderAddress,
      tokenName: NAME,
      chainId,
      from: holder.address,
      data,
      validBefore: 1n,
    });
    await expect(
      forwarder.connect(facilitator).executeWithAuthorization(
        expired.from,
        expired.data,
        expired.validAfter,
        expired.validBefore,
        expired.nonce,
        expired.signature,
        0,
        "0x"
      )
    ).to.be.revertedWith("Auth expired");

    const forged = await signExecuteWithAuthorization({
      signer: facilitator,
      token: forwarderAddress,
      tokenName: NAME,
      chainId,
      from: holder.address,
      data,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });
    await expect(
      forwarder.connect(facilitator).executeWithAuthorization(
        forged.from,
        forged.data,
        forged.validAfter,
        forged.validBefore,
        forged.nonce,
        forged.signature,
        0,
        "0x"
      )
    ).to.be.revertedWith("Invalid signature");
  });

  it("lets a relayer cancel with the signer's signature", async function () {
    const { holder, facilitator, token, forwarder, forwarderAddress, chainId } = await deploy();
    const auth = await signExecuteWithAuthorization({
      signer: holder,
      token: forwarderAddress,
      tokenName: NAME,
      chainId,
      from: holder.address,
      data: mintData(token, holder.address, 1n),
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });
    const cancelSig = await signCancelAuthorization({
      signer: holder,
      forwarder: forwarderAddress,
      tokenName: NAME,
      chainId,
      authorizer: holder.address,
      nonce: auth.nonce,
    });

    await expect(forwarder.connect(facilitator).cancelAuthorizationWithSig(holder.address, auth.nonce, cancelSig)).to.emit(
      forwarder,
      "AuthorizationCanceled"
    );
    await expect(
      forwarder.connect(facilitator).executeWithAuthorization(
        auth.from,
        auth.data,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        auth.signature,
        0,
        "0x"
      )
    ).to.be.revertedWith("Auth used");
  });

  it("rejects a cancel signature from the wrong account", async function () {
    const { holder, facilitator, forwarder, forwarderAddress, chainId } = await deploy();
    const nonce = hre.ethers.hexlify(hre.ethers.randomBytes(32));
    const cancelSig = await signCancelAuthorization({
      signer: facilitator,
      forwarder: forwarderAddress,
      tokenName: NAME,
      chainId,
      authorizer: holder.address,
      nonce,
    });
    await expect(
      forwarder.connect(facilitator).cancelAuthorizationWithSig(holder.address, nonce, cancelSig)
    ).to.be.revertedWith("Invalid signature");
  });
});
