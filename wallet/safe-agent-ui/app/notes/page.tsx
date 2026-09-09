"use client";

import { useEffect, useState } from "react";
import { formatUnits, parseUnits } from "viem";
import toast from "react-hot-toast";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { listAgents, type AgentRecord } from "~~/services/agents/agentStore";
import {
  assignNoteToAgent,
  listNotes,
  purgeNotesNotForPrivateToken,
  removeNote,
  type NotePackage,
  upsertNote,
} from "~~/services/notes/noteStore";
import { ERC20_ABI, getAppContractsConfig } from "~~/config/contracts";
import { useActiveSafe } from "~~/hooks/useActiveSafe";
import { ensureUserKey, decryptHandlesViaProxy } from "~~/services/bubble/proxy";
import {
  execSafePermitHandleView,
  mintOprfFromSafe,
} from "~~/services/safe/safeBubbleOps";
import { walletClientToSigner } from "~~/utils/ethers";
import { getAddress } from "ethers";
import { recordActivity } from "~~/services/activity/activityStore";

const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

function sameAddr(a?: string, b?: string) {
  if (!a || !b) return false;
  try {
    return getAddress(a) === getAddress(b);
  } catch {
    return a.toLowerCase() === b.toLowerCase();
  }
}

function formatNoteAmount(note: NotePackage, symbol: string) {
  const amount = formatUnits(BigInt(note.q), note.decimals || 18);
  return `${amount} ${symbol}`;
}

export default function NotesPage() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const publicClient = usePublicClient();
  const { safe } = useActiveSafe();
  const config = getAppContractsConfig();
  const [notes, setNotes] = useState<NotePackage[]>([]);
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [label, setLabel] = useState("");
  const [amount, setAmount] = useState("");
  const [assignMap, setAssignMap] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const [decimals] = useState(18);
  const [tokenSymbol, setTokenSymbol] = useState("pTUSDC");

  const refresh = () => {
    setNotes(listNotes());
    setAgents(listAgents());
  };

  useEffect(() => {
    if (config.privateErc20) {
      const removed = purgeNotesNotForPrivateToken(config.privateErc20);
      if (removed > 0) {
        toast.success(`Removed ${removed} note(s) from the old private token`);
      }
    }
    refresh();
  }, [config.privateErc20]);

  useEffect(() => {
    if (!publicClient || !config.privateErc20) return;
    publicClient
      .readContract({
        address: config.privateErc20,
        abi: ERC20_ABI,
        functionName: "symbol",
      })
      .then((sym) => setTokenSymbol(String(sym)))
      .catch(() => setTokenSymbol("pTUSDC"));
  }, [publicClient, config.privateErc20]);

  const onRemove = (note: NotePackage) => {
    if (!window.confirm(`Delete note “${note.label}”? This only clears localStorage.`)) return;
    removeNote(note.id);
    refresh();
    toast.success("Note removed");
  };

  const onMint = async () => {
    if (!walletClient || !address || !safe || !config.privateErc20 || !config.underlying) {
      toast.error("Need connected owner, Safe, and token addresses");
      return;
    }
    const quantity = parseUnits(amount || "0", decimals);
    if (quantity <= 0n) {
      toast.error("Enter a positive amount from private balance");
      return;
    }

    setBusy(true);
    try {
      const signer = await walletClientToSigner(walletClient);
      toast("Onboarding / loading Bubble key…");
      const aesKeyHex = await ensureUserKey(signer, config.chainId, config.bubbleProxyUrl);

      toast("Minting anonymous OPRF note via Safe…");
      const minted = await mintOprfFromSafe({
        safeAddress: safe.address,
        signer,
        ownerAddress: address,
        privateToken: config.privateErc20,
        quantity,
        ownerAesKeyHex: aesKeyHex,
      });

      toast("Granting view on note handles…");
      for (const handle of [minted.xHandle, minted.yHandle, minted.qHandle]) {
        const permitTx = await execSafePermitHandleView({
          safeAddress: safe.address,
          signer,
          viewer: address,
          handle,
        });
        recordActivity({
          kind: "permit_view",
          summary: "Safe permitted owner to decrypt note handle",
          txHash: permitTx.hash,
          safeAddress: safe.address,
          noteLabel: label.trim() || undefined,
        });
      }

      toast("Waiting for MPC, then decrypting note…");
      await delay(8000);
      const [x, y, q] = await decryptHandlesViaProxy({
        handles: [minted.xHandle, minted.yHandle, minted.qHandle],
        signer,
        aesKeyHex,
        proxyUrl: config.bubbleProxyUrl,
        chainId: config.chainId,
      });

      const note: NotePackage = {
        id: crypto.randomUUID(),
        version: 1,
        chainId: config.chainId,
        privateToken: config.privateErc20,
        underlying: config.underlying,
        x: x.toString(),
        y: y.toString(),
        q: q.toString(),
        decimals,
        mintedAt: new Date().toISOString(),
        label: label.trim() || `Note ${formatUnits(quantity, decimals)}`,
        mintTxHash: minted.hash,
        status: "available",
      };
      upsertNote(note);
      recordActivity({
        kind: "mint_note",
        summary: `Minted note “${note.label}” (${formatUnits(q, decimals)} ${tokenSymbol})`,
        txHash: minted.hash,
        safeAddress: safe.address,
        noteLabel: note.label,
        amount: `${formatUnits(q, decimals)} ${tokenSymbol}`,
      });
      setLabel("");
      setAmount("");
      refresh();
      toast.success(`Note minted — ${formatUnits(q, decimals)} ${tokenSymbol}`);
    } catch (err: any) {
      toast.error(err?.error?.message || err?.message || "Mint failed");
    } finally {
      setBusy(false);
    }
  };

  const onAssign = (noteId: string) => {
    const agentId = assignMap[noteId];
    if (!agentId) {
      toast.error("Pick an agent");
      return;
    }
    const note = notes.find((n) => n.id === noteId);
    const agent = agents.find((a) => a.id === agentId);
    assignNoteToAgent(noteId, agentId);
    recordActivity({
      kind: "assign_note",
      summary: `Assigned “${note?.label || "note"}” → ${agent?.name || "agent"}`,
      noteLabel: note?.label,
      agentId,
      agentName: agent?.name,
      address: agent?.address,
    });
    refresh();
    toast.success("Note assigned off-chain");
  };

  return (
    <div className="mx-auto flex max-w-4xl flex-col gap-6">
      <div>
        <h1 className="page-title">Anonymous notes</h1>
        <p className="page-subtitle">
          Mint an OPRF note from the Safe’s private balance, decrypt the bearer secret locally, then
          assign it to an agent off-chain (no on-chain link).
        </p>
      </div>

      <div className="panel p-6">
        <h2 className="mb-4 text-lg font-semibold text-[var(--wallet-text-strong)]">
          Mint OPRF from Safe
        </h2>
        {!isConnected || !safe ? (
          <p className="text-sm text-[var(--wallet-warning)]">Connect MetaMask and set a Safe first.</p>
        ) : (
          <>
            <div className="mb-3 grid gap-3 md:grid-cols-2">
              <div>
                <label className="field-label" htmlFor="note-label">
                  Label
                </label>
                <input
                  id="note-label"
                  className="field-input"
                  value={label}
                  onChange={(e) => setLabel(e.target.value)}
                  placeholder="payroll-week-12"
                />
              </div>
              <div>
                <label className="field-label" htmlFor="note-amount">
                  Amount (from private balance)
                </label>
                <input
                  id="note-amount"
                  className="field-input"
                  value={amount}
                  onChange={(e) => setAmount(e.target.value)}
                  placeholder="5"
                />
              </div>
            </div>
            <button
              type="button"
              className="btn btn-primary"
              disabled={busy || !amount}
              onClick={onMint}
            >
              {busy ? "Minting…" : "Mint anonymous note"}
            </button>
            <p className="mt-3 text-xs text-[var(--wallet-text-muted)]">
              Uses owner AES key for the quantity IT (tx.origin). Safe is the on-chain minter.
            </p>
          </>
        )}
      </div>

      <div className="panel overflow-hidden">
        <div className="border-b border-[var(--wallet-border)] px-6 py-4">
          <h2 className="text-lg font-semibold text-[var(--wallet-text-strong)]">
            Notes ({notes.length})
          </h2>
        </div>
        {notes.length === 0 ? (
          <p className="p-6 text-[var(--wallet-text-muted)]">No notes yet.</p>
        ) : (
          <ul className="divide-y divide-[var(--wallet-border)]">
            {notes.map((note) => {
              const agent = agents.find((a) => a.id === note.agentId);
              const hasSecret = note.x !== "0x" && note.q !== "0x";
              const wrongToken =
                Boolean(config.privateErc20) && !sameAddr(note.privateToken, config.privateErc20);
              return (
                <li key={note.id} className="space-y-3 px-6 py-4">
                  <div>
                    <div className="font-semibold text-[var(--wallet-text-strong)]">{note.label}</div>
                    <div className="text-xs text-[var(--wallet-text-muted)]">
                      {note.status}
                      {hasSecret ? ` · ${formatNoteAmount(note, tokenSymbol)}` : " · incomplete"}
                      {" · "}
                      {new Date(note.mintedAt).toLocaleString()}
                    </div>
                    <div className="text-xs text-[var(--wallet-text-muted)]">
                      Assigned: {agent ? agent.name : "—"}
                    </div>
                    {wrongToken && (
                      <div className="mt-1 text-xs text-[var(--wallet-warning)]">
                        Wrong private token — cash-out will fail. Delete and remint on the current token.
                      </div>
                    )}
                    {note.mintTxHash && (
                      <a
                        className="mono text-xs text-[var(--wallet-primary)] hover:underline"
                        href={`https://sepolia.arbiscan.io/tx/${note.mintTxHash}`}
                        target="_blank"
                        rel="noreferrer"
                      >
                        {note.mintTxHash.slice(0, 18)}…
                      </a>
                    )}
                  </div>
                  <div className="flex flex-col gap-2 sm:flex-row">
                    <select
                      className="field-input"
                      value={assignMap[note.id] || note.agentId || ""}
                      onChange={(e) => setAssignMap((m) => ({ ...m, [note.id]: e.target.value }))}
                      disabled={wrongToken}
                    >
                      <option value="">Select agent…</option>
                      {agents.map((a) => (
                        <option key={a.id} value={a.id}>
                          {a.name}
                        </option>
                      ))}
                    </select>
                    <button
                      type="button"
                      className="btn btn-primary shrink-0"
                      onClick={() => onAssign(note.id)}
                      disabled={!hasSecret || wrongToken}
                    >
                      Assign off-chain
                    </button>
                    <button
                      type="button"
                      className="btn shrink-0"
                      onClick={() => onRemove(note)}
                    >
                      Delete
                    </button>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
