/**
 * Anonymous OPRF transfer flow on a Bubble network (not Hardhat 31337):
 *
 *   1. User U mints an OPRF note from its private balance (encrypted amount).
 *   2. U hands the note plaintext (x, y, q) off-chain to a fresh temp address T.
 *   3. T, never funded with gas, re-encrypts the note under its own key and, through the gasless forwarder,
 *      transfers part of it to any destination D and later cashes out the remainder to underlying at D2.
 *
 * U is an ordinary user of a token someone else (the facilitator here) deployed and owns, so the token's owner and
 * master do not point at U. Asserts that T's transactions carry no trace of U:
 *   - U's address and the note handles of U's mint appear in no calldata and in no log (token, library, GC
 *     contracts, forwarder) of T's transactions,
 *   - T never holds native gas; every T transaction is sent by the shared facilitator,
 *   - U is not permitted on any handle created for T, D or D2.
 * What it cannot cover: amount and timing correlation, and the issuer, who knows `y`, finding the note's burn.
 *
 * Run: npx hardhat test test/PrivateERC20GaslessAnonymity.test.ts --network sepolia-arbitrum
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
import {
  buildUnsignedItUint128,
  buildUnsignedItUint256,
  DELAY_BALANCE_SYNC_MS,
  DELAY_MPC_EXTENDED_MS,
  DELAY_MPC_REDEEM_MS,
  delay,
  deployMockToken,
  deployPrivateTokenGasless,
  getGcAclAddress,
  getGcAclContract,
  getOprfMintedEventsFromReceipt,
  getOprfMintedHandlesFromReceipt,
  mintAndApprove,
  skipUnlessBubbleNetwork,
  waitForUnshieldOutcome,
} from "./helpers/testHelpers";

dotenv.config();

const PROXY_URL = process.env.PROXY_URL || "https://proxy.bubble.sodalabs.net";
const TOKEN_NAME = "Anonymity Test Token";
const NOTE_AMOUNT = 20n * 10n ** 18n + BigInt(Math.floor(Math.random() * 1_000_000));
const PAY_AMOUNT = 5n * 10n ** 18n;

/** The facilitator deploys the contracts and pays every T transaction. */
const MIN_FACILITATOR_BALANCE = hre.ethers.parseEther("0.001");

describe("PrivateERC20Contract256Gasless anonymous OPRF transfer", function () {
  this.timeout(1_200_000);

  let user: any; // U: mints the note
  let facilitator: any; // shared relayer, pays gas
  let temp: HDNodeWallet; // T: fresh, never funded
  let dest: HDNodeWallet; // D: receives the transferred note
  let cashOut: HDNodeWallet; // D2: receives underlying for the remainder
  let userAesKeyHex: string;
  let userAesKey: Buffer;
  let tempAesKey: Buffer;
  let tempAesKeyHex: string;
  let destAesKey: Buffer;
  let mockToken: any;
  let privateToken: any;
  let forwarder: any;
  let tokenAddress: string;
  let forwarderAddress: string;
  let chainId: number;

  /** Off-chain handoff from U to T. */
  let note: { x: bigint; y: bigint; q: bigint };
  /** Handles of U's mint; none may show up in T's transactions. */
  let mintHandles: bigint[];
  /** Remainder note T keeps after paying D. */
  let remainder: { x: bigint; y: bigint; q: bigint };

  before(async function () {
    await skipUnlessBubbleNetwork(this);
    chainId = Number((await hre.ethers.provider.getNetwork()).chainId);
    const signers = await hre.ethers.getSigners();
    user = signers[0];
    facilitator = signers[1];
    // Checked up front, not topped up from U: a U → facilitator transfer would itself link them.
    expect(
      await hre.ethers.provider.getBalance(facilitator.address),
      `facilitator ${facilitator.address} (mnemonic account 1) needs at least ${hre.ethers.formatEther(MIN_FACILITATOR_BALANCE)} ETH`
    ).to.be.gte(MIN_FACILITATOR_BALANCE);
    temp = Wallet.createRandom().connect(hre.ethers.provider);
    dest = Wallet.createRandom().connect(hre.ethers.provider);
    cashOut = Wallet.createRandom();

    userAesKey = await getUserKeyViaProxy(user, PROXY_URL);
    userAesKeyHex = userAesKey.toString("hex");
    // Onboarding is an off-chain proxy call: no transaction, no gas for T or D.
    tempAesKey = await getUserKeyViaProxy(temp, PROXY_URL);
    tempAesKeyHex = tempAesKey.toString("hex");
    destAesKey = await getUserKeyViaProxy(dest, PROXY_URL);

    mockToken = await deployMockToken(hre, facilitator, "Anonymity USD", "AUSD");
    privateToken = await deployPrivateTokenGasless(hre, facilitator, {
      underlyingAddress: await mockToken.getAddress(),
      ownerAddress: facilitator.address,
      masterAddress: facilitator.address,
      name: TOKEN_NAME,
      symbol: "gANON",
    });
    tokenAddress = await privateToken.getAddress();
    forwarder = privateToken.gaslessForwarder;
    forwarderAddress = await forwarder.getAddress();

    await mintAndApprove({ mockToken: mockToken.connect(user), privateToken, userAddress: user.address, amount: NOTE_AMOUNT });
    await (await privateToken.connect(user).shield(NOTE_AMOUNT)).wait();
    await delay(DELAY_BALANCE_SYNC_MS);
  });

  // ---------------------------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------------------------

  function hex(address: string): string {
    return address.slice(2).toLowerCase();
  }

  /** What links a transaction to U: U's address and the handles of U's mint, as they appear in calldata and logs. */
  function userNeedles(): Array<[string, string]> {
    const needles: Array<[string, string]> = [["U address", hex(user.address)]];
    for (const h of mintHandles ?? []) {
      needles.push([`mint handle ${h}`, h.toString(16).padStart(64, "0")]);
    }
    return needles;
  }

  async function traces(txHash: string): Promise<{ calldata: string[]; logs: string[] }> {
    const tx = await hre.ethers.provider.getTransaction(txHash);
    const receipt = await hre.ethers.provider.getTransactionReceipt(txHash);
    const data = tx!.data.toLowerCase();
    const found = { calldata: [] as string[], logs: [] as string[] };
    for (const [label, needle] of userNeedles()) {
      if (data.includes(needle)) found.calldata.push(label);
      for (const log of receipt!.logs) {
        if ((log.topics.join("") + log.data).toLowerCase().includes(needle)) found.logs.push(`${label} in ${log.address}`);
      }
    }
    return found;
  }

  /** Fails if U's address or a handle of U's mint appears in the transaction's calldata or logs, or U sent it. */
  async function expectNoUserTrace(txHash: string, label: string) {
    const found = await traces(txHash);
    expect(found.calldata, `${label}: in calldata`).to.deep.equal([]);
    expect(found.logs, `${label}: in logs`).to.deep.equal([]);
    const tx = await hre.ethers.provider.getTransaction(txHash);
    expect(tx!.from.toLowerCase(), `${label}: sender`).to.not.equal(user.address.toLowerCase());
  }

  async function expectUserNotPermitted(handles: bigint[], label: string) {
    const gcAcl = await getGcAclContract(hre, facilitator);
    for (const h of handles) {
      expect(await gcAcl.isPermitted(h, user.address), `${label}: U permitted on ${h}`).to.equal(false);
    }
  }

  function tempIt256(value: bigint) {
    return buildUnsignedItUint256({ value, userAddress: temp.address, userAesKeyHex: tempAesKeyHex, contractAddress: tokenAddress });
  }

  function tempIt128(value: bigint) {
    return buildUnsignedItUint128({ value, userAddress: temp.address, userAesKeyHex: tempAesKeyHex, contractAddress: tokenAddress });
  }

  /** T signs `data` plus a one-transaction insert grant; the facilitator submits. T pays nothing. */
  async function relayForTemp(data: string) {
    const gcAcl = await getGcAclContract(hre, facilitator);
    const insertNonce: bigint = await gcAcl.transientInsertNonce(temp.address);
    const insert = await signTransientInsertPermission({
      signer: temp,
      user: temp.address,
      token: tokenAddress,
      chainId,
      gcAcl: getGcAclAddress(chainId),
      nonce: insertNonce,
    });
    const auth = await signExecuteWithAuthorization({
      signer: temp,
      forwarder: forwarderAddress,
      tokenName: TOKEN_NAME,
      chainId,
      from: temp.address,
      data,
      validBefore: BigInt(Math.floor(Date.now() / 1000) + 3600),
    });
    const tx = await forwarder
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
    return tx.wait();
  }

  // ---------------------------------------------------------------------------------------------
  // Flow
  // ---------------------------------------------------------------------------------------------

  it("1. U mints an OPRF note from its private balance (amount stays encrypted)", async function () {
    const quantityIt = buildUnsignedItUint256({
      value: NOTE_AMOUNT,
      userAddress: user.address,
      userAesKeyHex,
      contractAddress: tokenAddress,
    });
    const receipt = await (await privateToken.connect(user).mintOPRFToken(quantityIt)).wait();
    await delay(DELAY_MPC_EXTENDED_MS);

    const handles = getOprfMintedHandlesFromReceipt(receipt, privateToken)!;
    const [x, y, q] = await decryptMultipleValuesViaProxy(
      [handles.xHandle, handles.yHandle, handles.qHandle],
      user,
      userAesKey,
      PROXY_URL
    );
    expect(q).to.equal(NOTE_AMOUNT);
    mintHandles = [handles.xHandle, handles.yHandle, handles.qHandle];
    // Positive control for both halves of the scanner: U's own mint shows U in its calldata (the IT owner) and in
    // its logs, and its handles in its logs.
    const found = await traces(receipt.hash);
    expect(found.calldata, "scanner sees U in the mint calldata").to.include("U address");
    expect(found.logs.some((l) => l.startsWith("U address")), "scanner sees U in the mint logs").to.equal(true);
    expect(found.logs.some((l) => l.startsWith("mint handle")), "scanner sees the mint handles in the mint logs").to.equal(true);
    note = { x, y, q }; // handed off-chain to T
  });

  it("2. T transfers part of the note to D gaslessly, with no on-chain trace of U", async function () {
    expect(await hre.ethers.provider.getBalance(temp.address)).to.equal(0n);

    const data = privateToken.interface.encodeFunctionData("transferOPRF", [
      [{ x: tempIt128(note.x), q: tempIt256(note.q), y_clear: note.y }],
      tempIt256(PAY_AMOUNT),
      dest.address,
    ]);
    const receipt = await relayForTemp(data);
    await delay(DELAY_MPC_EXTENDED_MS);

    expect(receipt.from.toLowerCase()).to.equal(facilitator.address.toLowerCase());
    expect(await hre.ethers.provider.getBalance(temp.address)).to.equal(0n);
    await expectNoUserTrace(receipt.hash, "transferOPRF");

    const minted = getOprfMintedEventsFromReceipt(receipt, privateToken);
    const toDest = minted.find((e) => e.user.toLowerCase() === dest.address.toLowerCase())!;
    const toTemp = minted.find((e) => e.user.toLowerCase() === temp.address.toLowerCase())!;
    expect(toDest, "note minted to D").to.not.be.undefined;
    expect(toTemp, "remainder minted to T").to.not.be.undefined;
    await expectUserNotPermitted([toDest.x, toDest.y, toDest.q, toTemp.x, toTemp.y, toTemp.q], "transferOPRF");

    // D can open its note; T can open the remainder.
    const [, , destQ] = await decryptMultipleValuesViaProxy([toDest.x, toDest.y, toDest.q], dest, destAesKey, PROXY_URL);
    expect(destQ).to.equal(PAY_AMOUNT);
    const [rx, ry, rq] = await decryptMultipleValuesViaProxy([toTemp.x, toTemp.y, toTemp.q], temp, tempAesKey, PROXY_URL);
    expect(rq).to.equal(NOTE_AMOUNT - PAY_AMOUNT);
    remainder = { x: rx, y: ry, q: rq };
  });

  it("3. T cashes out the remainder to underlying at D2 gaslessly, with no on-chain trace of U", async function () {
    // T owns the note, so the dest lock lets it pay D2 directly; an EIP-3009 hop to a merchant is a product choice.
    const startBlock = await hre.ethers.provider.getBlockNumber();
    const data = privateToken.interface.encodeFunctionData("redeemManyToUnderlying", [
      [{ x: tempIt128(remainder.x), q: tempIt256(remainder.q), y_clear: remainder.y }],
      tempIt256(remainder.q),
      cashOut.address,
      false,
    ]);
    const receipt = await relayForTemp(data);
    expect(receipt.from.toLowerCase()).to.equal(facilitator.address.toLowerCase());
    await expectNoUserTrace(receipt.hash, "redeemManyToUnderlying");

    const { successEvents, failedEvents, parkedEvents } = await waitForUnshieldOutcome(privateToken, hre, startBlock, {
      timeoutMs: DELAY_MPC_REDEEM_MS * 6,
      pollIntervalMs: 3000,
    });
    expect(failedEvents.length, "unshield failed").to.equal(0);
    expect(parkedEvents.length, "unshield payout parked").to.equal(0);
    expect(successEvents.length).to.be.greaterThan(0);
    const unshield = successEvents[0];
    expect(String(unshield.args[0]).toLowerCase()).to.equal(cashOut.address.toLowerCase());
    expect(await mockToken.balanceOf(cashOut.address)).to.equal(NOTE_AMOUNT - PAY_AMOUNT);
    // The decryption callback is a separate transaction sent by the MPC relayer.
    await expectNoUserTrace(unshield.transactionHash, "callbackUnshield");
    expect(await hre.ethers.provider.getBalance(temp.address)).to.equal(0n);
  });

  it("4. U's own view: U cannot decrypt anything created for T, D or D2", async function () {
    // The cash-out pays D2 in underlying from the pool; D2 never gets a private balance.
    expect(await privateToken["balanceOf(address)"](cashOut.address), "D2 private balance handle").to.equal(0n);
    // U's own balance is unaffected by T's activity after the mint.
    const userBalance: bigint = await privateToken["balanceOf(address)"](user.address);
    expect(await decryptValueViaProxy(userBalance, user, userAesKey, PROXY_URL)).to.equal(0n);
  });
});
