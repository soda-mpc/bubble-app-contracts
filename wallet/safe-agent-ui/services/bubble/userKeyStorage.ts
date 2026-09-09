import { readJson, writeJson } from "../storage/localStore";

const USER_KEYS_STORAGE = "safe-agent-ui:bubble-user-keys";

type KeyMap = Record<string, string>; // `${addressLower}:${chainId}` -> aes hex

function keyId(address: string, chainId: number) {
  return `${address.toLowerCase()}:${chainId}`;
}

export function getStoredUserKey(address: string, chainId: number): string | null {
  const map = readJson<KeyMap>(USER_KEYS_STORAGE, {});
  return map[keyId(address, chainId)] || null;
}

export function storeUserKey(address: string, chainId: number, aesKeyHex: string) {
  const map = readJson<KeyMap>(USER_KEYS_STORAGE, {});
  map[keyId(address, chainId)] = aesKeyHex;
  writeJson(USER_KEYS_STORAGE, map);
}
