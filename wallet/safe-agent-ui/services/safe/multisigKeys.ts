import { Wallet, getAddress } from "ethers";
import { readJson, writeJson } from "../storage/localStore";

const CO_OWNERS_KEY = "safe-agent-ui:demo-co-owners";
const SHARED_AES_KEY = "safe-agent-ui:shared-aes";

export type DemoCoOwner = {
  address: string;
  privateKey: string;
  label: string;
};

type CoOwnerMap = Record<string, DemoCoOwner[]>; // safeAddress lower -> owners
type SharedAesMap = Record<string, string>; // safeAddress lower -> aes hex

function safeId(safeAddress: string) {
  return getAddress(safeAddress).toLowerCase();
}

/** Local demo co-owners (private keys in localStorage) so one browser can complete k-of-n. */
export function getDemoCoOwners(safeAddress: string): DemoCoOwner[] {
  const map = readJson<CoOwnerMap>(CO_OWNERS_KEY, {});
  return map[safeId(safeAddress)] || [];
}

export function setDemoCoOwners(safeAddress: string, owners: DemoCoOwner[]) {
  const map = readJson<CoOwnerMap>(CO_OWNERS_KEY, {});
  map[safeId(safeAddress)] = owners;
  writeJson(CO_OWNERS_KEY, map);
}

export function clearDemoCoOwners(safeAddress: string) {
  const map = readJson<CoOwnerMap>(CO_OWNERS_KEY, {});
  delete map[safeId(safeAddress)];
  writeJson(CO_OWNERS_KEY, map);
}

export function generateDemoCoOwners(count: number): DemoCoOwner[] {
  return Array.from({ length: count }, (_, i) => {
    const wallet = Wallet.createRandom();
    return {
      address: wallet.address,
      privateKey: wallet.privateKey,
      label: `Co-owner ${i + 1}`,
    };
  });
}

export function getSharedAesKey(safeAddress: string): string | null {
  const map = readJson<SharedAesMap>(SHARED_AES_KEY, {});
  return map[safeId(safeAddress)] || null;
}

export function setSharedAesKey(safeAddress: string, aesKeyHex: string) {
  if (aesKeyHex.length !== 32) {
    throw new Error("AES key must be 16 bytes (32 hex chars)");
  }
  const map = readJson<SharedAesMap>(SHARED_AES_KEY, {});
  map[safeId(safeAddress)] = aesKeyHex.toLowerCase();
  writeJson(SHARED_AES_KEY, map);
}

export function clearSharedAesKey(safeAddress: string) {
  const map = readJson<SharedAesMap>(SHARED_AES_KEY, {});
  delete map[safeId(safeAddress)];
  writeJson(SHARED_AES_KEY, map);
}
