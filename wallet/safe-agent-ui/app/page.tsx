"use client";

import { useAccount } from "wagmi";
import { useActiveSafe } from "~~/hooks/useActiveSafe";
import { getAppContractsConfig } from "~~/config/contracts";
import { listAgents } from "~~/services/agents/agentStore";
import {
  listNotesForPrivateToken,
  purgeNotesNotForPrivateToken,
} from "~~/services/notes/noteStore";
import { useEffect, useState } from "react";

export default function HomePage() {
  const { isConnected, address } = useAccount();
  const { safe } = useActiveSafe();
  const [agentCount, setAgentCount] = useState(0);
  const [noteCount, setNoteCount] = useState(0);
  const config = getAppContractsConfig();

  useEffect(() => {
    if (config.privateErc20) {
      purgeNotesNotForPrivateToken(config.privateErc20);
    }
    setAgentCount(listAgents().length);
    setNoteCount(listNotesForPrivateToken(config.privateErc20).length);
  }, [config.privateErc20]);

  return (
    <div className="mx-auto flex max-w-5xl flex-col gap-6">
      <div>
        <h1 className="page-title">Safe Agent demo</h1>
        <p className="page-subtitle">
          Deploy or import a Safe, create agent EOAs, mint anonymous OPRF notes, and cash out clear
          tokens to an agent — all in one browser.
        </p>
      </div>

      <div className="grid gap-4 md:grid-cols-3">
        <StatusCard
          title="Wallet"
          value={isConnected ? "Connected" : "Not connected"}
          detail={address ? `${address.slice(0, 8)}…${address.slice(-4)}` : "Connect MetaMask to continue"}
        />
        <StatusCard
          title="Safe"
          value={safe ? "Ready" : "Missing"}
          detail={safe ? safe.address : "Import or deploy on the Safe page"}
        />
        <StatusCard
          title="Roster"
          value={`${agentCount} agents · ${noteCount} notes`}
          detail="Stored in this browser (localStorage)"
        />
      </div>

      <div className="panel p-6">
        <h2 className="mb-2 text-lg font-semibold text-[var(--wallet-text-strong)]">Config</h2>
        <dl className="grid gap-2 text-sm md:grid-cols-2">
          <ConfigRow label="Chain ID" value={String(config.chainId)} />
          <ConfigRow label="Underlying" value={config.underlying || "not set (deploy later)"} />
          <ConfigRow label="Private ERC20" value={config.privateErc20 || "not set (deploy later)"} />
          <ConfigRow label="GCACL" value={config.gcAcl || "—"} />
          <ConfigRow label="Bubble proxy" value={config.bubbleProxyUrl} />
          <ConfigRow
            label="Facilitator"
            value={config.facilitatorUrl || "unused in v1 (agent pays gas)"}
          />
        </dl>
      </div>
    </div>
  );
}

function StatusCard({ title, value, detail }: { title: string; value: string; detail: string }) {
  return (
    <div className="panel p-5">
      <div className="text-xs font-semibold uppercase tracking-wide text-[var(--wallet-text-muted)]">
        {title}
      </div>
      <div className="mt-2 text-lg font-semibold text-[var(--wallet-text-strong)]">{value}</div>
      <div className="mono mt-1 text-xs text-[var(--wallet-text-muted)]">{detail}</div>
    </div>
  );
}

function ConfigRow({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-[var(--wallet-surface-muted)] px-3 py-2">
      <div className="text-xs text-[var(--wallet-text-muted)]">{label}</div>
      <div className="mono text-[var(--wallet-text-strong)]">{value}</div>
    </div>
  );
}
