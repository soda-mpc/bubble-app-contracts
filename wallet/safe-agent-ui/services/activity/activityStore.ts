import { formatUnits } from "ethers";
import scaffoldConfig from "~~/scaffold.config";
import { listNotes } from "../notes/noteStore";
import { listAgents } from "../agents/agentStore";
import { readJson, storageKeys, writeJson } from "../storage/localStore";

export type ActivityKind =
  | "safe_deploy"
  | "safe_import"
  | "shield"
  | "permit_view"
  | "mint_note"
  | "assign_note"
  | "agent_create"
  | "agent_delete"
  | "insert_acl"
  | "cash_out";

export type ActivityItem = {
  id: string;
  kind: ActivityKind;
  summary: string;
  txHash?: string;
  address?: string;
  safeAddress?: string;
  agentId?: string;
  agentName?: string;
  noteLabel?: string;
  amount?: string;
  at: string;
};

const KIND_LABELS: Record<ActivityKind, string> = {
  safe_deploy: "Safe deploy",
  safe_import: "Safe import",
  shield: "Shield",
  permit_view: "Permit view",
  mint_note: "Mint note",
  assign_note: "Assign note",
  agent_create: "Agent created",
  agent_delete: "Agent deleted",
  insert_acl: "Insert ACL",
  cash_out: "Cash out",
};

export function activityKindLabel(kind: ActivityKind) {
  return KIND_LABELS[kind] || kind;
}

export function explorerBaseUrl(chainId?: number) {
  const chain =
    scaffoldConfig.targetNetworks.find((c) => c.id === chainId) || scaffoldConfig.targetNetworks[0];
  return chain.blockExplorers?.default.url || "https://sepolia.arbiscan.io";
}

export function txExplorerUrl(txHash: string, chainId?: number) {
  return `${explorerBaseUrl(chainId)}/tx/${txHash}`;
}

export function addressExplorerUrl(address: string, chainId?: number) {
  return `${explorerBaseUrl(chainId)}/address/${address}`;
}

export function listActivity(): ActivityItem[] {
  return readJson<ActivityItem[]>(storageKeys.activity, []);
}

export function saveActivity(items: ActivityItem[]) {
  writeJson(storageKeys.activity, items);
}

export function clearActivity() {
  saveActivity([]);
}

export function recordActivity(
  input: Omit<ActivityItem, "id" | "at"> & { id?: string; at?: string }
): ActivityItem {
  const item: ActivityItem = {
    id: input.id || crypto.randomUUID(),
    kind: input.kind,
    summary: input.summary,
    txHash: input.txHash,
    address: input.address,
    safeAddress: input.safeAddress,
    agentId: input.agentId,
    agentName: input.agentName,
    noteLabel: input.noteLabel,
    amount: input.amount,
    at: input.at || new Date().toISOString(),
  };
  const items = listActivity();
  // Dedupe identical tx hashes for the same kind
  if (item.txHash) {
    const dup = items.find((i) => i.kind === item.kind && i.txHash?.toLowerCase() === item.txHash!.toLowerCase());
    if (dup) return dup;
  }
  items.unshift(item);
  saveActivity(items.slice(0, 500));
  return item;
}

/** Seed activity from existing local notes / agents (idempotent by note mint tx / agent id). */
export function backfillActivityFromLocalState() {
  const existing = listActivity();
  const knownTx = new Set(
    existing.filter((i) => i.txHash).map((i) => `${i.kind}:${i.txHash!.toLowerCase()}`)
  );
  const knownAgentCreate = new Set(
    existing.filter((i) => i.kind === "agent_create" && i.agentId).map((i) => i.agentId!)
  );
  const knownMintByNote = new Set(
    existing.filter((i) => i.kind === "mint_note" && i.noteLabel && i.at).map((i) => `${i.noteLabel}|${i.at}`)
  );

  for (const note of listNotes()) {
    const amountLabel =
      note.q && note.q !== "0x"
        ? formatUnits(BigInt(note.q), note.decimals || 18)
        : undefined;
    if (note.mintTxHash) {
      const key = `mint_note:${note.mintTxHash.toLowerCase()}`;
      if (!knownTx.has(key)) {
        recordActivity({
          kind: "mint_note",
          summary: `Minted note “${note.label}”`,
          txHash: note.mintTxHash,
          noteLabel: note.label,
          amount: amountLabel,
          at: note.mintedAt,
        });
        knownTx.add(key);
      }
    } else {
      const key = `${note.label}|${note.mintedAt}`;
      if (!knownMintByNote.has(key)) {
        recordActivity({
          kind: "mint_note",
          summary: `Note “${note.label}” (no tx stored)`,
          noteLabel: note.label,
          amount: amountLabel,
          at: note.mintedAt,
        });
        knownMintByNote.add(key);
      }
    }

    if (note.agentId) {
      const agent = listAgents().find((a) => a.id === note.agentId);
      const assignId = `assign:${note.id}:${note.agentId}`;
      if (!existing.some((i) => i.id === assignId)) {
        recordActivity({
          id: assignId,
          kind: "assign_note",
          summary: `Assigned “${note.label}” → ${agent?.name || "agent"}`,
          noteLabel: note.label,
          agentId: note.agentId,
          agentName: agent?.name,
          at: note.mintedAt,
        });
      }
    }
  }

  for (const agent of listAgents()) {
    if (knownAgentCreate.has(agent.id)) continue;
    recordActivity({
      id: `agent-create:${agent.id}`,
      kind: "agent_create",
      summary: `Created agent “${agent.name}”`,
      address: agent.address,
      agentId: agent.id,
      agentName: agent.name,
      at: agent.createdAt || new Date().toISOString(),
    });
    knownAgentCreate.add(agent.id);
  }
}
