/**
 * Security regressions for PrivateERC20Contract256Gasless on a Bubble network (not Hardhat 31337).
 *
 * Each test asserts the SECURE behaviour. Against the old self-call implementation they failed with the reported
 * leak; when an attack succeeds, the failure message reports what the attacker obtained.
 *
 *   C1  The old executeWithAuthorization ran `data` via `address(this).call`, so `msg.sender == address(this)` and
 *       `isSenderPermitted` checked the CONTRACT's permissions, which cover every stored handle. `contractApprove`
 *       then permitted the handle to `from`: any account could decrypt other balances and the OPRF key.
 *       Now: a separate ERC-2771 forwarder (no MPC permissions) relays calls, and raw-handle ops require
 *       `isPermitted(handle, _msgSender())`.
 *
 * Run: npx hardhat test test/PrivateERC20GaslessSecurity.test.ts --network sepolia-arbitrum
 */
import { expect } from "chai";
import hre from "hardhat";
import { Wallet } from "ethers";
import dotenv from "dotenv";

import {
  decryptValueViaProxy,
  getUserKeyViaProxy,
} from "./helpers/bubbleCryptoTransport";
import { signExecuteWithAuthorization } from "./helpers/gaslessAuth";
import {
  DELAY_BALANCE_SYNC_MS,
  delay,
  deployMockToken,
  deployPrivateTokenGasless,
  GCACL_ABI,
  getGcAclAddress,
  mintAndApprove,
} from "./helpers/testHelpers";

dotenv.config();

const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const TOKEN_NAME = "Gasless Security Token";
// Random wei offset per run: identical computations can yield identical handles, and GCACL permits are keyed
// by handle, so a fixed amount would inherit permits granted to the attacker by a previous (vulnerable) run.
const NOTE_AMOUNT = 50n * 10n ** 18n + BigInt(Math.floor(Math.random() * 1_000_000));

/** ERC-7201 base of `bubble.storage.PrivateERC20Gasless` (PrivateERC20GaslessStorage.Layout); `_oprfKey` is the 9th field (offset 8). */
const PRIVATE_ERC20_GASLESS_STORAGE_LOCATION = 0x723dce8969bfc779025e7294feda768a136910d15014f276e725c5b3cde3b400n;
const OPRF_KEY_SLOT = PRIVATE_ERC20_GASLESS_STORAGE_LOCATION + 8n;

function shouldSkip(): boolean {
  return (
    !process.env.MNEMONIC ||
    (!process.env.SEPOLIA_ARBITRUM_RPC_URL && !process.env.ALCHEMY_API_KEY)
  );
}

describe("PrivateERC20Contract256Gasless security", function () {
  this.timeout(900000);

  let owner: any;
  let attacker: any;
  let ownerAesKey: Buffer;
  let ownerAesKeyHex: string;
  let attackerAesKey: Buffer;
  let mockToken: any;
  let privateToken: any;
  let gcAclAsOwner: any;
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
    attacker = signers[1] ?? Wallet.createRandom().connect(hre.ethers.provider);

    if ((await hre.ethers.provider.getBalance(attacker.address)) < hre.ethers.parseEther("0.0002")) {
      await (await owner.sendTransaction({
        to: attacker.address,
        value: hre.ethers.parseEther("0.002"),
      })).wait();
    }

    ownerAesKey = await getUserKeyViaProxy(owner, PROXY_URL);
    ownerAesKeyHex = ownerAesKey.toString("hex");
    attackerAesKey = await getUserKeyViaProxy(attacker, PROXY_URL);

    gcAclAsOwner = await hre.ethers.getContractAt(
      [...GCACL_ABI, "function revokeFullInsertPermission(address permittee)"],
      getGcAclAddress(chainId),
      owner
    );

    mockToken = await deployMockToken(hre, owner, "Gasless Security USD", "GSUSD");
    privateToken = await deployPrivateTokenGasless(hre, owner, {
      underlyingAddress: await mockToken.getAddress(),
      ownerAddress: owner.address,
      masterAddress: owner.address,
      name: TOKEN_NAME,
      symbol: "gSEC",
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
    // Victim's private balance, shielded directly (no gasless involvement).
    await (await privateToken.connect(owner).shield(NOTE_AMOUNT)).wait();
    await delay(DELAY_BALANCE_SYNC_MS);
  });

  /** Attacker authorizes its own call (`from = attacker`) and submits it. No insert grant. */
  async function executeAsAttacker(data: string): Promise<{ ok: boolean; error?: unknown }> {
    const auth = await signExecuteWithAuthorization({
      signer: attacker,
      forwarder: forwarderAddress,
      tokenName: TOKEN_NAME,
      chainId,
      from: attacker.address,
      data,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });
    try {
      const tx = await forwarder
        .connect(attacker)
        .executeWithAuthorization(
          auth.from,
          auth.data,
          auth.validAfter,
          auth.validBefore,
          auth.nonce,
          auth.signature,
          0,
          "0x"
        );
      await tx.wait();
      return { ok: true };
    } catch (error) {
      return { ok: false, error };
    }
  }

  /** Signs `data` as `signer` (EIP-712 domain of the forwarder unless overridden) and submits it from `submitter`. */
  async function signAndForward(
    signer: any,
    data: string,
    opts: { submitter?: any; from?: string; verifyingContract?: string; validBefore?: bigint } = {}
  ) {
    const auth = await signExecuteWithAuthorization({
      signer,
      forwarder: opts.verifyingContract ?? forwarderAddress,
      tokenName: TOKEN_NAME,
      chainId,
      from: opts.from ?? (await signer.getAddress()),
      data,
      validBefore: opts.validBefore ?? BigInt(Math.floor(Date.now() / 1000) + 3600),
    });
    const tx = await forwarder
      .connect(opts.submitter ?? attacker)
      .executeWithAuthorization(auth.from, auth.data, auth.validAfter, auth.validBefore, auth.nonce, auth.signature, 0, "0x");
    return { tx, auth };
  }

  async function tryDecrypt(handle: bigint, signer: any, aesKey: Buffer): Promise<string> {
    await delay(DELAY_BALANCE_SYNC_MS);
    try {
      return (await decryptValueViaProxy(handle, signer, aesKey, PROXY_URL)).toString();
    } catch (error) {
      return `<decrypt failed: ${(error as Error).message}>`;
    }
  }

  describe("C1: authorized self-call bypasses isSenderPermitted", function () {
    it("direct contractApprove with a foreign balance handle reverts (baseline)", async function () {
      const victimHandle: bigint = await privateToken["balanceOf(address)"](owner.address);
      console.log(`      victim balance handle: ${hre.ethers.toBeHex(victimHandle)}`);
      expect(victimHandle).to.not.equal(0n);
      await expect(
        privateToken.connect(attacker).contractApprove(attacker.address, victimHandle)
      ).to.be.revertedWith("Handle not permitted");
    });

    it("authorized contractApprove must not grant the attacker a permit on the victim's balance handle", async function () {
      const gcAcl = gcAclAsOwner.connect(attacker);
      const victimHandle: bigint = await privateToken["balanceOf(address)"](owner.address);
      expect(await gcAcl.isPermitted(victimHandle, attacker.address)).to.equal(false);

      const result = await executeAsAttacker(
        privateToken.interface.encodeFunctionData("contractApprove", [attacker.address, victimHandle])
      );
      const permitted: boolean = await gcAcl.isPermitted(victimHandle, attacker.address);

      if (result.ok && permitted) {
        const leaked = await tryDecrypt(victimHandle, attacker, attackerAesKey);
        expect.fail(
          `VULNERABLE: attacker obtained a persistent permit on the owner's balance handle; ` +
            `decrypted owner balance = ${leaked} (expected ${NOTE_AMOUNT})`
        );
      }
      expect(result.ok, "authorized contractApprove on a foreign handle should revert").to.equal(false);
      expect(permitted).to.equal(false);
    });

    it("authorized contractApprove must not grant the attacker a permit on the OPRF key handle", async function () {
      const gcAcl = gcAclAsOwner.connect(attacker);
      const keyHandle = BigInt(await hre.ethers.provider.getStorage(tokenAddress, OPRF_KEY_SLOT));
      console.log(`      OPRF key handle: ${hre.ethers.toBeHex(keyHandle)}`);
      expect(keyHandle, "OPRF key handle should be readable from proxy storage").to.not.equal(0n);
      expect(await gcAcl.isPermitted(keyHandle, attacker.address)).to.equal(false);

      const result = await executeAsAttacker(
        privateToken.interface.encodeFunctionData("contractApprove", [attacker.address, keyHandle])
      );
      const permitted: boolean = await gcAcl.isPermitted(keyHandle, attacker.address);

      if (result.ok && permitted) {
        const leaked = await tryDecrypt(keyHandle, attacker, attackerAesKey);
        expect.fail(
          `VULNERABLE: attacker obtained a persistent permit on the OPRF key handle ` +
            `(slot ${hre.ethers.toBeHex(OPRF_KEY_SLOT)}); decrypt attempt = ${leaked}`
        );
      }
      expect(result.ok, "authorized contractApprove on the OPRF key handle should revert").to.equal(false);
      expect(permitted).to.equal(false);
    });
  });

  describe("C1: other raw-handle entrypoints via forwarder", function () {
    it("contractTransfer with a foreign handle reverts", async function () {
      const victimHandle: bigint = await privateToken["balanceOf(address)"](owner.address);
      await expect(
        signAndForward(attacker, privateToken.interface.encodeFunctionData("contractTransfer", [attacker.address, victimHandle]))
      ).to.be.revertedWith("Handle not permitted");
    });

    it("contractTransferFrom with a foreign handle reverts", async function () {
      const victimHandle: bigint = await privateToken["balanceOf(address)"](owner.address);
      await expect(
        signAndForward(
          attacker,
          privateToken.interface.encodeFunctionData("contractTransferFrom", [owner.address, attacker.address, victimHandle])
        )
      ).to.be.revertedWith("Handle not permitted");
    });
  });

  describe("C1 positive control", function () {
    it("signed contractApprove with the signer's own balance handle still works", async function () {
      const ownHandle: bigint = await privateToken["balanceOf(address)"](owner.address);
      const auth = await signExecuteWithAuthorization({
        signer: owner,
        forwarder: forwarderAddress,
        tokenName: TOKEN_NAME,
        chainId,
        from: owner.address,
        data: privateToken.interface.encodeFunctionData("contractApprove", [attacker.address, ownHandle]),
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      });
      await expect(
        forwarder
          .connect(attacker)
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
      ).to.emit(forwarder, "AuthorizationExecuted");
    });
  });

  describe("Forwarder authorization rules", function () {
    const approveData = () => privateToken.interface.encodeFunctionData("approve(address,uint256)", [attacker.address, 1n]);

    it("rejects replaying a used authorization", async function () {
      const { tx, auth } = await signAndForward(owner, approveData());
      await tx.wait();
      await expect(
        forwarder
          .connect(attacker)
          .executeWithAuthorization(auth.from, auth.data, auth.validAfter, auth.validBefore, auth.nonce, auth.signature, 0, "0x")
      ).to.be.revertedWith("Auth used");
    });

    it("rejects an expired authorization", async function () {
      const now = BigInt((await hre.ethers.provider.getBlock("latest"))!.timestamp);
      await expect(signAndForward(owner, approveData(), { validBefore: now - 1n })).to.be.revertedWith("Auth expired");
    });

    it("rejects a signature made for the token's EIP-712 domain (old verifyingContract)", async function () {
      await expect(signAndForward(owner, approveData(), { verifyingContract: tokenAddress })).to.be.revertedWith(
        "Invalid signature"
      );
    });

    it("rejects `from` = token or forwarder (no EIP-1271 on either)", async function () {
      // Rejected before any signature check or call into the token.
      await expect(signAndForward(attacker, approveData(), { from: tokenAddress })).to.be.revertedWith(
        "from cannot be token or forwarder"
      );
      await expect(signAndForward(attacker, approveData(), { from: forwarderAddress })).to.be.revertedWith(
        "from cannot be token or forwarder"
      );
    });

    it("ignores an address appended to a direct call (only the trusted forwarder can set the sender)", async function () {
      const data =
        privateToken.interface.encodeFunctionData("approve(address,uint256)", [attacker.address, 7n]) +
        owner.address.slice(2).toLowerCase();
      const receipt = await (await attacker.sendTransaction({ to: tokenAddress, data })).wait();
      const approval = receipt.logs
        .map((log: any) => {
          try {
            return privateToken.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((e: any) => e?.name === "Approval");
      expect(approval.args[0].toLowerCase()).to.equal(attacker.address.toLowerCase());
    });

    it("rejects consumeInsertGrant unless called by the forwarder", async function () {
      await expect(privateToken.connect(attacker).consumeInsertGrant(0, "0x")).to.be.revertedWith("Only forwarder");
    });

    it("rejects forwarded user operations while the token is paused", async function () {
      await (await privateToken.connect(owner).pause()).wait();
      try {
        await expect(signAndForward(owner, approveData())).to.be.revertedWithCustomError(privateToken, "EnforcedPause");
      } finally {
        await (await privateToken.connect(owner).unpause()).wait();
      }
    });
  });

  describe("Admin functions and upgrade", function () {
    it("setTrustedForwarder rejects the token address and non-owners", async function () {
      await expect(privateToken.connect(owner).setTrustedForwarder(tokenAddress)).to.be.revertedWith(
        "Forwarder cannot be token"
      );
      await expect(privateToken.connect(attacker).setTrustedForwarder(attacker.address))
        .to.be.revertedWithCustomError(privateToken, "OwnableUnauthorizedAccount")
        .withArgs(attacker.address);
      expect(await privateToken.trustedForwarder()).to.equal(forwarderAddress);
    });

    it("owner-signed setTrustedForwarder / upgradeToAndCall via the forwarder revert", async function () {
      await expect(
        signAndForward(owner, privateToken.interface.encodeFunctionData("setTrustedForwarder", [attacker.address]))
      )
        .to.be.revertedWithCustomError(privateToken, "OwnableUnauthorizedAccount")
        .withArgs(forwarderAddress);
      await expect(
        signAndForward(owner, privateToken.interface.encodeFunctionData("upgradeToAndCall", [attacker.address, "0x"]))
      )
        .to.be.revertedWithCustomError(privateToken, "OwnableUnauthorizedAccount")
        .withArgs(forwarderAddress);
      expect(await privateToken.trustedForwarder()).to.equal(forwarderAddress);
    });

    it("acceptOwnership via the forwarder reverts", async function () {
      await (await privateToken.connect(owner).transferOwnership(attacker.address)).wait();
      try {
        await expect(signAndForward(attacker, privateToken.interface.encodeFunctionData("acceptOwnership", []))).to.be
          .revertedWith("Not via forwarder");
        expect(await privateToken.owner()).to.equal(owner.address);
      } finally {
        await (await privateToken.connect(owner).transferOwnership(hre.ethers.ZeroAddress)).wait();
      }
    });
  });

});
