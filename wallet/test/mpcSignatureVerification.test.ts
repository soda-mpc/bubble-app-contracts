/**
 * Unit tests for the proxy-response verification.
 *
 * These pin the property the security work exists to establish: a response is only trusted when
 * the MPC evaluator signatures over it recover to the expected signer set. They run on the default
 * Hardhat network with no proxy, no funded account and no Bubble deployment, by injecting a locally
 * generated signer set — so a refactor that disables verification fails CI rather than passing it.
 */
import { expect } from "chai";
import { Wallet, getBytes, keccak256 } from "ethers";

import { assertOnboardSigned, assertOutputSigned } from "./helpers/bubbleCryptoTransport";

/** Assert that `promise` rejects with a message matching `pattern`. */
async function expectRejection(promise: Promise<unknown>, pattern: RegExp): Promise<void> {
  try {
    await promise;
  } catch (error) {
    expect((error as Error).message).to.match(pattern);
    return;
  }
  expect.fail(`expected rejection matching ${pattern}, but it resolved`);
}

/**
 * Sign `message` the way the MPC evaluators do: over the raw keccak256 of the message (no EIP-191
 * prefix), serialised as r ‖ s ‖ yParity with v as 0/1 — the form `verifySignatures` recovers.
 */
function signAll(wallets: Wallet[], message: Uint8Array): string[] {
  return wallets.map((w) => {
    const sig = w.signingKey.sign(keccak256(message));
    return Buffer.concat([
      Buffer.from(getBytes(sig.r)),
      Buffer.from(getBytes(sig.s)),
      Buffer.from([sig.yParity]),
    ]).toString("base64");
  });
}

describe("MPC signature verification", function () {
  const evaluators = [Wallet.createRandom(), Wallet.createRandom()];
  const signers = evaluators.map((w) => w.address);
  const impostors = [Wallet.createRandom(), Wallet.createRandom()];

  describe("onboarding (assertOnboardSigned)", function () {
    const shares = Buffer.alloc(512, 0xab);

    it("accepts shares signed by the evaluator set", async function () {
      const sigs = signAll(evaluators, shares);
      await assertOnboardSigned(shares, sigs, signers);
    });

    it("rejects shares signed by anyone else", async function () {
      const sigs = signAll(impostors, shares);
      await expectRejection(assertOnboardSigned(shares, sigs, signers), /did not verify/);
    });

    it("rejects shares the signatures do not cover", async function () {
      const sigs = signAll(evaluators, shares);
      const tampered = Buffer.from(shares);
      tampered[0] ^= 0xff;
      await expectRejection(assertOnboardSigned(tampered, sigs, signers), /did not verify/);
    });

    it("rejects a response with no signatures", async function () {
      await expectRejection(assertOnboardSigned(shares, undefined, signers), /no mpc_signatures/);
      await expectRejection(assertOnboardSigned(shares, [], signers), /no mpc_signatures/);
    });

    it("rejects a signature count that does not match the signer set", async function () {
      const sigs = signAll([evaluators[0]], shares);
      await expectRejection(assertOnboardSigned(shares, sigs, signers), /1 onboard signatures for 2 signers/);
    });
  });

  describe("encrypt-to-user (assertOutputSigned)", function () {
    const handle = getBytes("0x" + "11".repeat(32));
    const output = Buffer.alloc(64, 0xcd);
    const message = Buffer.concat([Buffer.from(handle), output]);

    it("accepts an output signed by the evaluator set", async function () {
      const sigs = signAll(evaluators, message);
      await assertOutputSigned(handle, output, sigs, signers);
    });

    it("rejects an output signed by anyone else", async function () {
      const sigs = signAll(impostors, message);
      await expectRejection(assertOutputSigned(handle, output, sigs, signers), /did not verify/);
    });

    it("rejects an output swapped after signing", async function () {
      const sigs = signAll(evaluators, message);
      const swapped = Buffer.alloc(64, 0xee);
      await expectRejection(assertOutputSigned(handle, swapped, sigs, signers), /did not verify/);
    });

    it("rejects a signature bound to a different handle", async function () {
      const otherHandle = getBytes("0x" + "22".repeat(32));
      const sigs = signAll(evaluators, Buffer.concat([Buffer.from(otherHandle), output]));
      await expectRejection(assertOutputSigned(handle, output, sigs, signers), /did not verify/);
    });

    it("rejects a response with no signatures", async function () {
      await expectRejection(assertOutputSigned(handle, output, undefined, signers), /no mpc_signatures/);
    });
  });
});
