/**
 * Local checks for PrivateERC20GaslessForwarder. No MPC.
 * The target is ERC2771TargetMock, which reads the appended signer like the gasless token and records it.
 *
 * Run: npm run test:gasless
 */
import { expect } from "chai";
import hre from "hardhat";

import { signCancelAuthorization, signExecuteWithAuthorization } from "./helpers/gaslessAuth";

const NAME = "Forwarder Target";
const HOUR = 3600n;

describe("PrivateERC20GaslessForwarder", function () {
  async function deploy() {
    const [holder, facilitator, stranger] = await hre.ethers.getSigners();
    const target: any = await hre.ethers.deployContract("ERC2771TargetMock", [NAME], holder);
    await target.waitForDeployment();
    const targetAddress = await target.getAddress();
    const forwarder: any = await hre.ethers.deployContract("PrivateERC20GaslessForwarder", [targetAddress], holder);
    await forwarder.waitForDeployment();
    const forwarderAddress = await forwarder.getAddress();
    await (await target.setTrustedForwarder(forwarderAddress)).wait();
    const chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
    return { holder, facilitator, stranger, target, targetAddress, forwarder, forwarderAddress, chainId };
  }

  async function now(): Promise<bigint> {
    return BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
  }

  async function sign(
    ctx: Awaited<ReturnType<typeof deploy>>,
    data: string,
    opts: { signer?: any; from?: string; validAfter?: bigint; validBefore?: bigint } = {}
  ) {
    return signExecuteWithAuthorization({
      signer: opts.signer ?? ctx.holder,
      forwarder: ctx.forwarderAddress,
      tokenName: NAME,
      chainId: ctx.chainId,
      from: opts.from ?? ctx.holder.address,
      data,
      validAfter: opts.validAfter,
      validBefore: opts.validBefore ?? (await now()) + HOUR,
    });
  }

  function execute(ctx: Awaited<ReturnType<typeof deploy>>, auth: any, data?: string, grant?: { nonce: bigint; sig: string }) {
    return ctx.forwarder
      .connect(ctx.facilitator)
      .executeWithAuthorization(
        auth.from,
        data ?? auth.data,
        auth.validAfter,
        auth.validBefore,
        auth.nonce,
        auth.signature,
        grant?.nonce ?? 0,
        grant?.sig ?? "0x"
      );
  }

  const record = (ctx: Awaited<ReturnType<typeof deploy>>, value: bigint) =>
    ctx.target.interface.encodeFunctionData("record", [value]);

  it("runs a signed call as the signer while the facilitator pays gas", async function () {
    const ctx = await deploy();
    const auth = await sign(ctx, record(ctx, 42n));
    const receipt = (await (await execute(ctx, auth)).wait())!;
    expect(receipt.from.toLowerCase()).to.equal(ctx.facilitator.address.toLowerCase());
    expect(await ctx.target.lastSender()).to.equal(ctx.holder.address);
    expect(await ctx.target.lastValue()).to.equal(42n);
    await expect(execute(ctx, auth)).to.be.revertedWith("Auth used");
  });

  it("consumes the insert grant as the signer before the operation", async function () {
    const ctx = await deploy();
    const auth = await sign(ctx, record(ctx, 7n));
    await (await execute(ctx, auth, undefined, { nonce: 5n, sig: "0x1234" })).wait();
    expect(await ctx.target.lastGrantUser()).to.equal(ctx.holder.address);
    expect(await ctx.target.lastGrantNonce()).to.equal(5n);
    expect(await ctx.target.grantCallIndex()).to.be.lessThan(await ctx.target.recordCallIndex());
  });

  it("refuses a target that does not trust it", async function () {
    const ctx = await deploy();
    await (await ctx.target.setTrustedForwarder(hre.ethers.ZeroAddress)).wait();
    const auth = await sign(ctx, record(ctx, 1n));
    await expect(execute(ctx, auth)).to.be.revertedWith("Token does not trust forwarder");

    // A plain ERC20 has no isTrustedForwarder at all.
    const tusdc: any = await hre.ethers.deployContract("TUSDC", ["Test USDC", "TUSDC"], ctx.holder);
    await tusdc.waitForDeployment();
    const plain: any = await hre.ethers.deployContract("PrivateERC20GaslessForwarder", [await tusdc.getAddress()], ctx.holder);
    await plain.waitForDeployment();
    const plainAuth = await signExecuteWithAuthorization({
      signer: ctx.stranger,
      forwarder: await plain.getAddress(),
      tokenName: "Test USDC",
      chainId: ctx.chainId,
      from: ctx.stranger.address,
      data: tusdc.interface.encodeFunctionData("transferFrom", [ctx.holder.address, ctx.stranger.address, 1n]),
      validBefore: (await now()) + HOUR,
    });
    await expect(
      plain
        .connect(ctx.facilitator)
        .executeWithAuthorization(
          plainAuth.from,
          plainAuth.data,
          plainAuth.validAfter,
          plainAuth.validBefore,
          plainAuth.nonce,
          plainAuth.signature,
          0,
          "0x"
        )
    ).to.be.revertedWith("Token does not trust forwarder");
  });

  it("rejects an expired, not-yet-valid, wrongly signed or tampered authorization", async function () {
    const ctx = await deploy();
    const data = record(ctx, 1n);
    await expect(execute(ctx, await sign(ctx, data, { validBefore: 1n }))).to.be.revertedWith("Auth expired");
    await expect(execute(ctx, await sign(ctx, data, { validAfter: (await now()) + HOUR }))).to.be.revertedWith(
      "Auth not yet valid"
    );
    await expect(execute(ctx, await sign(ctx, data, { signer: ctx.facilitator }))).to.be.revertedWith(
      "Invalid signature"
    );
    const auth = await sign(ctx, data);
    await expect(execute(ctx, auth, record(ctx, 2n))).to.be.revertedWith("Invalid signature");
  });

  it("rejects `from` = the token or the forwarder before checking the signature", async function () {
    const ctx = await deploy();
    for (const from of [ctx.targetAddress, ctx.forwarderAddress]) {
      await expect(execute(ctx, await sign(ctx, record(ctx, 1n), { from }))).to.be.revertedWith(
        "from cannot be token or forwarder"
      );
    }
  });

  it("leaves the nonce unused when the target call reverts", async function () {
    const ctx = await deploy();
    const auth = await sign(ctx, ctx.target.interface.encodeFunctionData("fail", []));
    await expect(execute(ctx, auth)).to.be.revertedWith("target failed");
    expect(await ctx.forwarder.authorizationUsed(ctx.holder.address, auth.nonce)).to.equal(false);
  });

  it("lets the signer cancel directly", async function () {
    const ctx = await deploy();
    const auth = await sign(ctx, record(ctx, 1n));
    await expect(ctx.forwarder.connect(ctx.holder).cancelAuthorization(auth.nonce)).to.emit(
      ctx.forwarder,
      "AuthorizationCanceled"
    );
    await expect(execute(ctx, auth)).to.be.revertedWith("Auth used");
  });

  it("lets a relayer cancel with the signer's signature", async function () {
    const ctx = await deploy();
    const auth = await sign(ctx, record(ctx, 1n));
    const cancelSig = await signCancelAuthorization({
      signer: ctx.holder,
      forwarder: ctx.forwarderAddress,
      tokenName: NAME,
      chainId: ctx.chainId,
      authorizer: ctx.holder.address,
      nonce: auth.nonce,
    });
    await expect(
      ctx.forwarder.connect(ctx.facilitator).cancelAuthorizationWithSig(ctx.holder.address, auth.nonce, cancelSig)
    ).to.emit(ctx.forwarder, "AuthorizationCanceled");
    await expect(execute(ctx, auth)).to.be.revertedWith("Auth used");
  });

  it("rejects a cancel signature from the wrong account", async function () {
    const ctx = await deploy();
    const nonce = hre.ethers.hexlify(hre.ethers.randomBytes(32));
    const cancelSig = await signCancelAuthorization({
      signer: ctx.facilitator,
      forwarder: ctx.forwarderAddress,
      tokenName: NAME,
      chainId: ctx.chainId,
      authorizer: ctx.holder.address,
      nonce,
    });
    await expect(
      ctx.forwarder.connect(ctx.facilitator).cancelAuthorizationWithSig(ctx.holder.address, nonce, cancelSig)
    ).to.be.revertedWith("Invalid signature");
  });
});
