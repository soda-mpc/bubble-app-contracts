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
 *   C2  The old `_requireOprfRelayerDest` skipped the dest lock in auth context without checking that the IT owner
 *       signed. Unsigned relay requires the owner to grant full insert access to the token contract, so anyone holding
 *       the owner's note ITs could self-sign an authorization and burn the note to itself.
 *       Now: only a caller (`_msgSender()`) equal to the IT owner may choose a recipient other than the owner.
 *
 *   C3  A stranger passed the owner's public value IT (calldata is public) into `approve(spender, it)` or `transfer`
 *       and so got decrypt permission on the owner's amount. Now: value ITs must belong to `_msgSender()` (or, on
 *       a direct call, to `tx.origin`).
 *
 *   M1  A relayer that burned the owner's note to the owner was permitted on the burned amount and could read it.
 *       Now: only the owner (and the token) are permitted on it.
 *
 * Run: npx hardhat test test/PrivateERC20GaslessSecurity.test.ts --network sepolia-arbitrum
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
import { signExecuteWithAuthorization, signTransientInsertPermission } from "./helpers/gaslessAuth";
import {
  buildUnsignedItUint128,
  buildUnsignedItUint256,
  delay,
  DELAY_BALANCE_SYNC_MS,
  DELAY_MPC_EXTENDED_MS,
  deployMockToken,
  deployPrivateOPRFNotesLibrary,
  deployPrivateTokenGasless,
  findParsedLogInReceipt,
  GCACL_ABI,
  getGcAclAddress,
  getGcAclContract,
  getOprfMintedHandlesFromReceipt,
  getPrivateTokenBalance,
  getPrivateTransferAmountHandle,
  mintAndApprove,
  PRIVATE_ERC20_256_GASLESS_FQN,
  PRIVATE_OPRF_NOTES_FQN,
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

  function ownerIt256(value: bigint) {
    return buildUnsignedItUint256({ value, userAddress: owner.address, userAesKeyHex: ownerAesKeyHex, contractAddress: tokenAddress });
  }

  function ownerIt128(value: bigint) {
    return buildUnsignedItUint128({ value, userAddress: owner.address, userAesKeyHex: ownerAesKeyHex, contractAddress: tokenAddress });
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

  describe("C2 / C3 / M1: a relayer holding the owner's note ITs while the owner grants full insert access", function () {
    let tokenInput: any[];

    before(async function () {
      // Victim mints a note with a direct call (the owner is the caller, so no insert grant is needed).
      const quantityIt = buildUnsignedItUint256({
        value: NOTE_AMOUNT,
        userAddress: owner.address,
        userAesKeyHex: ownerAesKeyHex,
        contractAddress: tokenAddress,
      });
      const mintReceipt = await (await privateToken.connect(owner).mintOPRFToken(quantityIt)).wait();
      await delay(DELAY_MPC_EXTENDED_MS);

      const mintHandles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken);
      expect(mintHandles).to.not.be.undefined;
      const [x, y, q] = await decryptMultipleValuesViaProxy(
        [mintHandles!.xHandle, mintHandles!.yHandle, mintHandles!.qHandle],
        owner,
        ownerAesKey,
        PROXY_URL
      );
      expect(q).to.equal(NOTE_AMOUNT);

      // Unsigned-relay setup: the victim hands its note ITs to a relayer and grants the token contract
      // full insert access, so the token accepts the owner's ITs whoever submits them.
      tokenInput = [
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
      // GCACL rejects expirations less than one hour after block.timestamp (ExpirationDateBeforeOneHour).
      const expiry = BigInt(Math.floor(Date.now() / 1000) + 86400);
      await (await gcAclAsOwner.permitFullInsertAccess(tokenAddress, expiry)).wait();
      expect(await gcAclAsOwner.isFullInsertPermitted(owner.address, tokenAddress)).to.equal(true);
    });

    after(async function () {
      try {
        await (await gcAclAsOwner.revokeFullInsertPermission(tokenAddress)).wait();
      } catch (error) {
        console.warn(`[cleanup] revokeFullInsertPermission(token) failed: ${(error as Error).message}`);
      }
    });

    it("unsigned relayer burn to itself reverts (baseline dest lock)", async function () {
      const { x, q, y_clear } = tokenInput[0];
      await expect(
        privateToken.connect(attacker).burnToken(x, q, y_clear, attacker.address)
      ).to.be.revertedWith("Relayer dest must be IT owner");
    });

    it("C3: a stranger must not decrypt the owner's amount IT via approve(spender, it)", async function () {
      // Owner has granted the token full insert access (needed for unsigned relay). The IT is any amount the owner
      // submitted before (calldata is public), here a fresh one for a secret value.
      const secret = 123456789n;
      const ownerIt = buildUnsignedItUint256({
        value: secret,
        userAddress: owner.address,
        userAesKeyHex: ownerAesKeyHex,
        contractAddress: tokenAddress,
      });
      let approved = true;
      try {
        await (await privateToken.connect(attacker)["approve(address,(address,(uint256,uint256)))"](attacker.address, ownerIt)).wait();
      } catch (error) {
        approved = false;
        expect((error as Error).message).to.contain("IT not owned by caller");
      }
      if (approved) {
        const handle: bigint = await privateToken.connect(attacker).allowance(attacker.address, attacker.address);
        const leaked = await tryDecrypt(handle, attacker, attackerAesKey);
        expect.fail(`VULNERABLE: attacker decrypted the owner's IT through its own allowance: ${leaked} (secret ${secret})`);
      }
    });

    it("C2: self-signed splitTokenForRecipient / transferOPRF / redeemMany / redeemManyToUnderlying hit the dest lock", async function () {
      const note = [{ x: ownerIt128(1n), q: ownerIt256(1n), y_clear: 1n }];
      const calls = [
        privateToken.interface.encodeFunctionData("splitTokenForRecipient", [ownerIt128(1n), ownerIt256(1n), 1n, ownerIt256(1n), attacker.address]),
        privateToken.interface.encodeFunctionData("transferOPRF", [note, ownerIt256(1n), attacker.address]),
        privateToken.interface.encodeFunctionData("redeemMany", [note, ownerIt256(1n), attacker.address]),
        privateToken.interface.encodeFunctionData("redeemManyToUnderlying", [note, ownerIt256(1n), attacker.address, false]),
      ];
      for (const data of calls) {
        await expect(signAndForward(attacker, data)).to.be.revertedWith("Relayer dest must be IT owner");
      }
    });

    it("C2: a self-signed burnToken of the owner's note to the relayer reverts at the dest lock", async function () {
      const { x, q, y_clear } = tokenInput[0];
      await expect(
        signAndForward(attacker, privateToken.interface.encodeFunctionData("burnToken", [x, q, y_clear, attacker.address]))
      ).to.be.revertedWith("Relayer dest must be IT owner");
    });

    it("C3: transfer / transferFrom / mintOPRFToken reject the owner's IT from a stranger (direct)", async function () {
      const it = ownerIt256(1n);
      await expect(privateToken.connect(attacker)["transfer(address,(address,(uint256,uint256)))"](attacker.address, it)).to.be
        .revertedWith("IT not owned by caller");
      await expect(
        privateToken.connect(attacker)["transferFrom(address,address,(address,(uint256,uint256)))"](attacker.address, attacker.address, it)
      ).to.be.revertedWith("IT not owned by caller");
      await expect(privateToken.connect(attacker).mintOPRFToken(it)).to.be.revertedWith("IT not owned by caller");
    });

    it("C3: approve / transfer / transferFrom / mintOPRFToken reject the owner's IT when the stranger signs (forwarded)", async function () {
      const it = ownerIt256(1n);
      const calls = [
        privateToken.interface.encodeFunctionData("approve(address,(address,(uint256,uint256)))", [attacker.address, it]),
        privateToken.interface.encodeFunctionData("transfer(address,(address,(uint256,uint256)))", [attacker.address, it]),
        privateToken.interface.encodeFunctionData("transferFrom(address,address,(address,(uint256,uint256)))", [
          attacker.address,
          attacker.address,
          it,
        ]),
        privateToken.interface.encodeFunctionData("mintOPRFToken", [it]),
      ];
      for (const data of calls) {
        await expect(signAndForward(attacker, data)).to.be.revertedWith("IT not owned by caller");
      }
    });

    it("M1: a relayer that burns the owner's note to the owner cannot decrypt the amount", async function () {
      const amount = 1000n + BigInt(Math.floor(Math.random() * 1000));
      const mintReceipt = await (await privateToken.connect(owner)["shieldAndMint(uint256)"](amount)).wait();
      await delay(DELAY_MPC_EXTENDED_MS);
      const handles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken)!;
      const [x, y, q] = await decryptMultipleValuesViaProxy(
        [handles.xHandle, handles.yHandle, handles.qHandle],
        owner,
        ownerAesKey,
        PROXY_URL
      );

      const burnReceipt = await (
        await privateToken.connect(attacker).burnToken(ownerIt128(x), ownerIt256(q), y, owner.address)
      ).wait();
      await delay(DELAY_MPC_EXTENDED_MS);
      const creditedHandle = getPrivateTransferAmountHandle(burnReceipt, privateToken);
      const burnedLog = findParsedLogInReceipt(burnReceipt, privateToken, "OPRFBurned");
      expect(burnedLog, "OPRFBurned").to.not.equal(undefined);
      const burnedHandle = privateToken.interface.parseLog(burnedLog).args[2] as bigint;

      const gcAcl = gcAclAsOwner.connect(attacker);
      for (const [label, handle] of [["credited", creditedHandle], ["burned", burnedHandle]] as const) {
        expect(await gcAcl.isPermitted(handle, attacker.address), `relayer must not be permitted on the ${label} amount`).to.equal(false);
        expect(await decryptValueViaProxy(handle, owner, ownerAesKey, PROXY_URL), `${label} amount`).to.equal(amount);
      }
    });

    it("owner-signed burnToken can pay a third party (library path via forwarder)", async function () {
      const before = await getPrivateTokenBalance({
        privateToken,
        address: attacker.address,
        signer: attacker,
        aesKey: attackerAesKey,
        proxyUrl: PROXY_URL,
      });
      const { x, q, y_clear } = tokenInput[0];
      const auth = await signExecuteWithAuthorization({
        signer: owner,
        forwarder: forwarderAddress,
        tokenName: TOKEN_NAME,
        chainId,
        from: owner.address,
        data: privateToken.interface.encodeFunctionData("burnToken", [x, q, y_clear, attacker.address]),
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      });
      await (
        await forwarder
          .connect(attacker)
          .executeWithAuthorization(auth.from, auth.data, auth.validAfter, auth.validBefore, auth.nonce, auth.signature, 0, "0x")
      ).wait();
      await delay(DELAY_MPC_EXTENDED_MS);

      const after = await getPrivateTokenBalance({
        privateToken,
        address: attacker.address,
        signer: attacker,
        aesKey: attackerAesKey,
        proxyUrl: PROXY_URL,
      });
      expect(after - before).to.equal(NOTE_AMOUNT);
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
      expect(approval, "no Approval event found in the direct-call receipt").to.not.equal(undefined);
      expect(approval!.args[0].toLowerCase()).to.equal(attacker.address.toLowerCase());
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

  describe("Transient insert grant", function () {
    /** Owner-signed authorization for `data`, submitted by the attacker (the facilitator here) with an optional grant. */
    async function forwardAsOwner(data: string, grant?: { nonce: bigint; signature: string }) {
      const auth = await signExecuteWithAuthorization({
        signer: owner,
        forwarder: forwarderAddress,
        tokenName: TOKEN_NAME,
        chainId,
        from: owner.address,
        data,
        validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
      });
      const tx = await forwarder
        .connect(attacker)
        .executeWithAuthorization(
          auth.from,
          auth.data,
          auth.validAfter,
          auth.validBefore,
          auth.nonce,
          auth.signature,
          grant?.nonce ?? 0n,
          grant?.signature ?? "0x"
        );
      return tx.wait();
    }

    async function ownerGrant() {
      const gcAcl = await getGcAclContract(hre, owner);
      return signTransientInsertPermission({
        signer: owner,
        user: owner.address,
        token: tokenAddress,
        chainId,
        gcAcl: getGcAclAddress(chainId),
        nonce: await gcAcl.transientInsertNonce(owner.address),
      });
    }

    before(async function () {
      // A standing full insert permission would let the relayed call through without a grant.
      if (await gcAclAsOwner.isFullInsertPermitted(owner.address, tokenAddress)) {
        await (await gcAclAsOwner.revokeFullInsertPermission(tokenAddress)).wait();
      }
      expect(await gcAclAsOwner.isFullInsertPermitted(owner.address, tokenAddress)).to.equal(false);
    });

    it("a relayed IT operation needs the signer's grant, and a grant works once", async function () {
      const approveIt = () =>
        privateToken.interface.encodeFunctionData("approve(address,(address,(uint256,uint256)))", [
          attacker.address,
          ownerIt256(5n),
        ]);
      await expect(forwardAsOwner(approveIt()), "without a grant").to.be.reverted;

      const grant = await ownerGrant();
      const receipt = await forwardAsOwner(approveIt(), grant);
      const approval = receipt!.logs
        .map((log: any) => {
          try {
            return privateToken.interface.parseLog(log);
          } catch {
            return null;
          }
        })
        .find((e: any) => e?.name === "Approval");
      expect(approval, "no Approval event in the relayed receipt").to.not.equal(undefined);
      expect(approval!.args[0]).to.equal(owner.address);
      expect(approval!.args[1]).to.equal(attacker.address);

      await expect(forwardAsOwner(approveIt(), grant), "replayed grant").to.be.reverted;
    });

    it("a relayed call rejects ciphertext that is not the signer's, even the facilitator's own", async function () {
      // tx.origin is the facilitator here, so the tx.origin arm would accept its IT on a direct call.
      const facilitatorIt = buildUnsignedItUint256({
        value: 1n,
        userAddress: attacker.address,
        userAesKeyHex: attackerAesKey.toString("hex"),
        contractAddress: tokenAddress,
      });
      for (const sig of ["approve(address,(address,(uint256,uint256)))", "transfer(address,(address,(uint256,uint256)))"]) {
        const data = privateToken.interface.encodeFunctionData(sig, [attacker.address, facilitatorIt]);
        await expect(forwardAsOwner(data)).to.be.revertedWith("IT not owned by caller");
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
      await expect(privateToken.connect(owner).setTrustedForwarder(attacker.address)).to.be.revertedWith(
        "Forwarder must be a contract"
      );
      const otherForwarder: any = await hre.ethers.deployContract(
        "PrivateERC20GaslessForwarder",
        [await mockToken.getAddress()],
        owner
      );
      await otherForwarder.waitForDeployment();
      await expect(privateToken.connect(owner).setTrustedForwarder(await otherForwarder.getAddress())).to.be.revertedWith(
        "Forwarder token mismatch"
      );
      expect(await privateToken.trustedForwarder()).to.equal(forwarderAddress);
    });

    it("setTrustedForwarder(0) disables gasless calls", async function () {
      await (await privateToken.connect(owner).setTrustedForwarder(hre.ethers.ZeroAddress)).wait();
      try {
        expect(await privateToken.trustedForwarder()).to.equal(hre.ethers.ZeroAddress);
        const data = privateToken.interface.encodeFunctionData("approve(address,uint256)", [attacker.address, 1n]);
        await expect(signAndForward(owner, data)).to.be.revertedWith("Token does not trust forwarder");
      } finally {
        await (await privateToken.connect(owner).setTrustedForwarder(forwarderAddress)).wait();
      }
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

    it("owner upgrade to an implementation linked to a fresh library keeps state, the forwarder and notes", async function () {
      // A note minted through the old implementation and library, spent after the upgrade.
      const noteAmount = 1000n + BigInt(Math.floor(Math.random() * 1000));
      const mintReceipt = await (await privateToken.connect(owner)["shieldAndMint(uint256)"](noteAmount)).wait();
      await delay(DELAY_MPC_EXTENDED_MS);
      const handles = getOprfMintedHandlesFromReceipt(mintReceipt, privateToken)!;
      const [x, y, q] = await decryptMultipleValuesViaProxy(
        [handles.xHandle, handles.yHandle, handles.qHandle],
        owner,
        ownerAesKey,
        PROXY_URL
      );
      expect(q).to.equal(noteAmount);

      const balanceBefore: bigint = await privateToken["balanceOf(address)"](owner.address);
      const supplyBefore: bigint = await privateToken.totalSupply();
      const oprfKeyBefore = await hre.ethers.provider.getStorage(tokenAddress, OPRF_KEY_SLOT);
      // Each implementation is linked to a library deployed from the same commit, never a stale address.
      const oldLibrary: string = privateToken.oprfNotesLibrary;
      expect(oldLibrary).to.be.properAddress;
      const library = await deployPrivateOPRFNotesLibrary(hre, owner);
      const factory = await hre.ethers.getContractFactory(PRIVATE_ERC20_256_GASLESS_FQN, {
        signer: owner,
        libraries: { [PRIVATE_OPRF_NOTES_FQN]: library },
      });
      const impl = await factory.deploy();
      await impl.waitForDeployment();

      await expect(privateToken.connect(attacker).upgradeToAndCall(await impl.getAddress(), "0x"))
        .to.be.revertedWithCustomError(privateToken, "OwnableUnauthorizedAccount")
        .withArgs(attacker.address);
      await (await privateToken.connect(owner).upgradeToAndCall(await impl.getAddress(), "0x")).wait();

      const implSlot = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
      const implRaw = await hre.ethers.provider.getStorage(tokenAddress, implSlot);
      expect(hre.ethers.getAddress("0x" + implRaw.slice(-40))).to.equal(await impl.getAddress());
      expect(await privateToken.trustedForwarder()).to.equal(forwarderAddress);
      expect(await privateToken.name()).to.equal(TOKEN_NAME);
      expect(await privateToken["balanceOf(address)"](owner.address)).to.equal(balanceBefore);
      expect(await privateToken.totalSupply()).to.equal(supplyBefore);
      expect(await hre.ethers.provider.getStorage(tokenAddress, OPRF_KEY_SLOT), "OPRF key").to.equal(oprfKeyBefore);

      // The pre-upgrade note burns through the new library for its full amount.
      const burnReceipt = await (
        await privateToken.connect(owner).burnToken(ownerIt128(x), ownerIt256(q), y, owner.address)
      ).wait();
      await delay(DELAY_MPC_EXTENDED_MS);
      const credited = getPrivateTransferAmountHandle(burnReceipt, privateToken);
      expect(await decryptValueViaProxy(credited, owner, ownerAesKey, PROXY_URL), "pre-upgrade note").to.equal(noteAmount);

      // Gasless still works after the upgrade.
      const { tx } = await signAndForward(owner, privateToken.interface.encodeFunctionData("approve(address,uint256)", [attacker.address, 2n]));
      await expect(tx).to.emit(forwarder, "AuthorizationExecuted");
      // New issuance runs through the new library too.
      await expect(privateToken.connect(owner)["shieldAndMint(uint256)"](1n)).to.emit(privateToken, "OPRFMinted");
    });
  });

});
