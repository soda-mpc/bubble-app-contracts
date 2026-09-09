import { getAddress } from "ethers";
import { readJson, storageKeys, writeJson } from "../storage/localStore";

export type NotePackage = {
  id: string;
  version: 1;
  chainId: number;
  privateToken: `0x${string}`;
  underlying: `0x${string}`;
  x: string;
  y: string;
  q: string;
  decimals: number;
  mintedAt: string;
  label: string;
  agentId?: string;
  mintTxHash?: string;
  status: "available" | "partially_spent" | "spent";
};

export function listNotes(): NotePackage[] {
  return readJson<NotePackage[]>(storageKeys.notes, []);
}

export function saveNotes(notes: NotePackage[]) {
  writeJson(storageKeys.notes, notes);
}

export function upsertNote(note: NotePackage) {
  const notes = listNotes();
  const idx = notes.findIndex((n) => n.id === note.id);
  if (idx >= 0) notes[idx] = note;
  else notes.unshift(note);
  saveNotes(notes);
}

export function removeNote(noteId: string) {
  saveNotes(listNotes().filter((n) => n.id !== noteId));
}

function sameAddress(a?: string, b?: string) {
  if (!a || !b) return false;
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

/** Notes minted against a different private token cannot be cash-out on the current one. */
export function listNotesForPrivateToken(privateToken?: string | null): NotePackage[] {
  if (!privateToken) return listNotes();
  return listNotes().filter((n) => sameAddress(n.privateToken, privateToken));
}

/** Drop local notes that do not match the configured private token. Returns removed count. */
export function purgeNotesNotForPrivateToken(privateToken: string): number {
  const before = listNotes();
  const keep = before.filter((n) => sameAddress(n.privateToken, privateToken));
  if (keep.length === before.length) return 0;
  saveNotes(keep);
  return before.length - keep.length;
}

export function assignNoteToAgent(noteId: string, agentId: string) {
  const notes = listNotes().map((n) => (n.id === noteId ? { ...n, agentId } : n));
  saveNotes(notes);
}
