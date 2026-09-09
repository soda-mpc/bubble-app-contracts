"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther, formatUnits, parseUnits } from "viem";
import toast from "react-hot-toast";
import { usePublicClient } from "wagmi";
import { ERC20_ABI, getAppContractsConfig } from "~~/config/contracts";
import { listAgents, type AgentRecord } from "~~/services/agents/agentStore";
import {
  listNotesForPrivateToken,
  purgeNotesNotForPrivateToken,
  type NotePackage,
} from "~~/services/notes/noteStore";
import { cashOutNoteToClear } from "~~/services/agents/cashOut";

function formatNoteAmount(note: NotePackage, symbol: string) {
  const amt = formatUnits(BigInt(note.q), note.decimals || 18);
  return `${amt} ${symbol}`;
}

export default function ActPage() {
  const publicClient = usePublicClient();
  const config = getAppContractsConfig();
  const [agents, setAgents] = useState<AgentRecord[]>([]);
  const [notes, setNotes] = useState<NotePackage[]>([]);
  const [agentId, setAgentId] = useState("");
  const [noteId, setNoteId] = useState("");
  const [amount, setAmount] = useState("");
  const [ethBal, setEthBal] = useState("—");
  const [ethBalRaw, setEthBalRaw] = useState(0n);
  const [clearBal, setClearBal] = useState("—");
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [tokenSymbol, setTokenSymbol] = useState("pTUSDC");

  const refreshLists = useCallback(() => {
    setAgents(listAgents());
    setNotes(listNotesForPrivateToken(config.privateErc20));
  }, [config.privateErc20]);

  useEffect(() => {
    if (config.privateErc20) {
      purgeNotesNotForPrivateToken(config.privateErc20);
    }
    refreshLists();
  }, [config.privateErc20, refreshLists]);

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

  const agent = useMemo(() => agents.find((a) => a.id === agentId), [agents, agentId]);
  const agentNotes = useMemo(
    () => notes.filter((n) => n.agentId === agentId && n.status !== "spent"),
    [notes, agentId]
  );
  const selectedNote = useMemo(
    () => agentNotes.find((n) => n.id === noteId),
    [agentNotes, noteId]
  );

  const refreshBalances = useCallback(async () => {
    if (!publicClient || !agent) return;
    const eth = await publicClient.getBalance({ address: agent.address });
    setEthBal(formatEther(eth));
    setEthBalRaw(eth);
    if (!config.underlying) {
      setClearBal("configure underlying");
      return;
    }
    const [decimals, balance] = await Promise.all([
      publicClient.readContract({
        address: config.underlying,
        abi: ERC20_ABI,
        functionName: "decimals",
      }) as Promise<number>,
      publicClient.readContract({
        address: config.underlying,
        abi: ERC20_ABI,
        functionName: "balanceOf",
        args: [agent.address],
      }) as Promise<bigint>,
    ]);
    setClearBal(formatUnits(balance, Number(decimals)));
  }, [publicClient, agent, config.underlying]);

  useEffect(() => {
    refreshBalances().catch(() => setClearBal("error"));
  }, [refreshBalances]);

  const canCashOut =
    Boolean(agent && selectedNote && amount && !busy) &&
    selectedNote!.x !== "0x" &&
    selectedNote!.q !== "0x" &&
    ethBalRaw > 0n;

  const onCashOut = async () => {
    if (!agent || !selectedNote) return;
    const decimals = selectedNote.decimals || 18;
    const value = parseUnits(amount || "0", decimals);
    if (value <= 0n) {
      toast.error("Enter a positive amount");
      return;
    }

    setBusy(true);
    setStatus("");
    try {
      const result = await cashOutNoteToClear({
        agent,
        note: selectedNote,
        amount: value,
        onStatus: (msg) => {
          setStatus(msg);
          toast(msg);
        },
      });
      toast.success(`Clear tokens arrived. Tx ${result.redeemTxHash.slice(0, 10)}…`);
      setAmount("");
      refreshLists();
      await refreshBalances();
    } catch (err: any) {
      toast.error(err?.shortMessage || err?.message || "Cash out failed");
    } finally {
      setBusy(false);
      setStatus("");
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="page-title">Act as agent</h1>
        <p className="page-subtitle">
          Convert part of an assigned anonymous note to clear tokens on the agent. Agent pays gas —
          no facilitator in v1.
        </p>
      </div>

      <div className="panel space-y-4 p-6">
        <div>
          <label className="field-label" htmlFor="act-agent">
            Agent
          </label>
          <select
            id="act-agent"
            className="field-input"
            value={agentId}
            onChange={(e) => {
              setAgentId(e.target.value);
              setNoteId("");
            }}
          >
            <option value="">Select…</option>
            {agents.map((a) => (
              <option key={a.id} value={a.id}>
                {a.name}
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="act-note">
            Note
          </label>
          <select
            id="act-note"
            className="field-input"
            value={noteId}
            onChange={(e) => setNoteId(e.target.value)}
            disabled={!agentId}
          >
            <option value="">Select…</option>
            {agentNotes.map((n) => (
              <option key={n.id} value={n.id}>
                {n.label} ({n.status}
                {n.q !== "0x" ? ` · ${formatNoteAmount(n, tokenSymbol)}` : ""})
              </option>
            ))}
          </select>
        </div>

        <div>
          <label className="field-label" htmlFor="act-amount">
            Clear amount
          </label>
          <div className="flex gap-2">
            <input
              id="act-amount"
              className="field-input"
              placeholder="0.1"
              value={amount}
              onChange={(e) => setAmount(e.target.value)}
            />
            {selectedNote && selectedNote.q !== "0x" && (
              <button
                type="button"
                className="btn btn-ghost shrink-0"
                onClick={() =>
                  setAmount(formatUnits(BigInt(selectedNote.q), selectedNote.decimals || 18))
                }
              >
                Max
              </button>
            )}
          </div>
        </div>

        {agent && ethBalRaw === 0n && (
          <p className="text-sm text-[var(--wallet-warning)]">
            Agent has 0 ETH — send a little Arb Sepolia ETH to {agent.address} for gas.
          </p>
        )}

        <button
          type="button"
          className="btn btn-primary"
          disabled={!canCashOut}
          onClick={onCashOut}
        >
          {busy ? status || "Working…" : "Cash out to clear"}
        </button>
        {busy && status && (
          <p className="text-sm text-[var(--wallet-text-muted)]">{status}</p>
        )}
      </div>

      {agent && (
        <div className="grid gap-4 md:grid-cols-2">
          <div className="panel p-5">
            <div className="text-xs font-semibold uppercase text-[var(--wallet-text-muted)]">
              Agent ETH
            </div>
            <div className="mt-2 text-xl font-semibold text-[var(--wallet-text-strong)]">{ethBal}</div>
            <div className="mono mt-1 text-xs text-[var(--wallet-text-muted)]">{agent.address}</div>
          </div>
          <div className="panel p-5">
            <div className="text-xs font-semibold uppercase text-[var(--wallet-text-muted)]">
              Agent clear
            </div>
            <div className="mt-2 text-xl font-semibold text-[var(--wallet-text-strong)]">{clearBal}</div>
          </div>
        </div>
      )}
    </div>
  );
}
