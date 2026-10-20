/**
 * Storage layout checks for PrivateERC20Contract256Gasless. Static: compiler output only, no MPC, no network.
 *
 *   1. The OpenZeppelin upgrades plugin accepts the implementation.
 *   2. The namespace slot constant matches the ERC-7201 formula for the annotated namespace ID.
 *   3. The current layout is an upgrade-compatible, unchanged copy of the committed snapshot.
 *   4. Negative controls: the comparator rejects reordered, retyped and removed fields and accepts appends.
 *
 * A deliberate layout change (append-only) must update the snapshot in the same change:
 *   UPDATE_LAYOUT_SNAPSHOT=1 npm run test:layout
 *
 * Run: npm run test:layout
 */
import { expect } from "chai";
import fs from "fs";
import path from "path";
import hre from "hardhat";
import {
  getStorageLayout,
  getStorageUpgradeReport,
  getVersion,
  StorageLayout,
  withValidationDefaults,
} from "@openzeppelin/upgrades-core";
// Not a public API of @openzeppelin/hardhat-upgrades; both packages are pinned in package.json.
import { readValidations } from "@openzeppelin/hardhat-upgrades/dist/utils/validations";

import { PRIVATE_ERC20_256_GASLESS_FQN, PRIVATE_OPRF_NOTES_FQN } from "./helpers/testHelpers";

const NAMESPACE_ID = "bubble.storage.PrivateERC20Gasless";
const NAMESPACE = `erc7201:${NAMESPACE_ID}`;
const STORAGE_SOURCE = path.join(__dirname, "../contracts/libraries/PrivateERC20GaslessStorage.sol");
const SNAPSHOT = path.join(__dirname, "fixtures/PrivateERC20Gasless.storage-layout.json");

function erc7201Slot(id: string): bigint {
  const { ethers } = hre;
  const inner = BigInt(ethers.keccak256(ethers.toUtf8Bytes(id))) - 1n;
  const outer = BigInt(ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(["uint256"], [inner])));
  return outer & ~0xffn;
}

/**
 * label@slot:offset type, for every linear variable and every namespaced field. Types are compared by their
 * readable label: the type ids embed AST ids, which change between compilations.
 */
function fieldList(layout: StorageLayout): string[] {
  const entry = (f: { label: string; slot?: string; offset?: number; type: string }) =>
    `${f.label}@${f.slot}:${f.offset} ${(layout.types as any)[f.type]?.label ?? f.type}`;
  const linear = layout.storage.map((f) => `storage ${entry(f)}`);
  const namespaced = Object.entries(layout.namespaces ?? {}).flatMap(([id, fields]) =>
    fields.map((f) => `${id} ${entry(f)}`)
  );
  return [...linear, ...namespaced].sort();
}

describe("PrivateERC20Contract256Gasless storage layout", function () {
  let current: StorageLayout;

  before(async function () {
    await hre.run("compile", { quiet: true });
    const artifact = await hre.artifacts.readArtifact(PRIVATE_ERC20_256_GASLESS_FQN);
    // The plugin indexes the unlinked bytecode, so look it up from the artifact, not a linked factory.
    current = getStorageLayout(await readValidations(hre), getVersion(artifact.bytecode, artifact.deployedBytecode));
    if (process.env.UPDATE_LAYOUT_SNAPSHOT) {
      fs.mkdirSync(path.dirname(SNAPSHOT), { recursive: true });
      fs.writeFileSync(SNAPSHOT, JSON.stringify(current, null, 2) + "\n");
    }
  });

  it("passes the upgrades plugin validation", async function () {
    const factory = await hre.ethers.getContractFactory(PRIVATE_ERC20_256_GASLESS_FQN, {
      libraries: { [PRIVATE_OPRF_NOTES_FQN]: "0x0000000000000000000000000000000000000001" },
    });
    // PrivateOPRFNotes is a linked library. The plugin cannot check it; it was reviewed by hand: no storage of its
    // own, no selfdestruct, and it only runs through the token's DELEGATECALL (Solidity's library call guard).
    await hre.upgrades.validateImplementation(factory, { kind: "uups", unsafeAllowLinkedLibraries: true });
  });

  it("uses the ERC-7201 slot of its annotated namespace", function () {
    const source = fs.readFileSync(STORAGE_SOURCE, "utf8");
    expect(source).to.include(`@custom:storage-location ${NAMESPACE}`);
    const constant = source.match(/PRIVATE_ERC20_GASLESS_STORAGE_LOCATION\s*=\s*(0x[0-9a-fA-F]{64})/);
    expect(constant, "slot constant not found").to.not.equal(null);
    expect(BigInt(constant![1])).to.equal(erc7201Slot(NAMESPACE_ID));
  });

  it("matches the committed snapshot", function () {
    const snapshot: StorageLayout = JSON.parse(fs.readFileSync(SNAPSHOT, "utf8"));
    const report = getStorageUpgradeReport(snapshot, current, withValidationDefaults({}));
    expect(report.ok, `Storage layout is not upgrade-safe against the snapshot:\n${report.explain()}`).to.equal(true);
    expect(
      fieldList(current),
      "Storage layout changed. If the change is a deliberate append, run UPDATE_LAYOUT_SNAPSHOT=1 npm run test:layout"
    ).to.deep.equal(fieldList(snapshot));
    expect((current.namespaces ?? {})[NAMESPACE], `namespace ${NAMESPACE} not seen by the plugin`).to.not.equal(
      undefined
    );
  });

  describe("comparator controls", function () {
    const opts = withValidationDefaults({});
    const clone = (): any => JSON.parse(JSON.stringify(current));
    const ok = (updated: StorageLayout) => getStorageUpgradeReport(current, updated, opts).ok;

    it("accepts an appended field", function () {
      const updated = clone();
      const fields = updated.namespaces[NAMESPACE];
      const last = fields[fields.length - 1];
      fields.push({ ...last, label: "appendedField", slot: String(Number(last.slot) + 1), offset: 0, type: "t_uint256" });
      updated.types["t_uint256"] ??= { label: "uint256", numberOfBytes: "32" };
      expect(ok(updated)).to.equal(true);
    });

    it("rejects reordered fields", function () {
      const updated = clone();
      const [first, second] = updated.namespaces[NAMESPACE];
      [first.label, second.label] = [second.label, first.label];
      expect(ok(updated)).to.equal(false);
    });

    it("rejects a retyped field", function () {
      const updated = clone();
      updated.namespaces[NAMESPACE].find((f: any) => f.label === "unshieldEpoch").type = "t_address";
      expect(ok(updated)).to.equal(false);
    });

    it("rejects a removed field", function () {
      const updated = clone();
      updated.namespaces[NAMESPACE] = updated.namespaces[NAMESPACE].filter((f: any) => f.label !== "master");
      expect(ok(updated)).to.equal(false);
    });
  });
});
