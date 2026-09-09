const SAFE_STORAGE_KEY = "safe-agent-ui:active-safe";
const AGENTS_STORAGE_KEY = "safe-agent-ui:agents";
const NOTES_STORAGE_KEY = "safe-agent-ui:notes";
const ACTIVITY_STORAGE_KEY = "safe-agent-ui:activity";

function canUseStorage() {
  return typeof window !== "undefined" && typeof window.localStorage !== "undefined";
}

export function readJson<T>(key: string, fallback: T): T {
  if (!canUseStorage()) return fallback;
  try {
    const raw = window.localStorage.getItem(key);
    if (!raw) return fallback;
    return JSON.parse(raw) as T;
  } catch {
    return fallback;
  }
}

export function writeJson<T>(key: string, value: T) {
  if (!canUseStorage()) return;
  window.localStorage.setItem(key, JSON.stringify(value));
}

export const storageKeys = {
  safe: SAFE_STORAGE_KEY,
  agents: AGENTS_STORAGE_KEY,
  notes: NOTES_STORAGE_KEY,
  activity: ACTIVITY_STORAGE_KEY,
};
