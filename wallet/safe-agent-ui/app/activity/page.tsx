"use client";

import { useEffect, useState } from "react";
import {
  activityKindLabel,
  addressExplorerUrl,
  backfillActivityFromLocalState,
  clearActivity,
  listActivity,
  txExplorerUrl,
  type ActivityItem,
  type ActivityKind,
} from "~~/services/activity/activityStore";
import { getAppContractsConfig } from "~~/config/contracts";

function truncate(hash: string) {
  if (hash.length < 18) return hash;
  return `${hash.slice(0, 10)}…${hash.slice(-8)}`;
}

export default function ActivityPage() {
  const config = getAppContractsConfig();
  const [items, setItems] = useState<ActivityItem[]>([]);

  const refresh = () => {
    backfillActivityFromLocalState();
    setItems(listActivity());
  };

  useEffect(() => {
    refresh();
  }, []);

  const onClear = () => {
    if (!window.confirm("Clear all activity history from this browser?")) return;
    clearActivity();
    setItems([]);
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="page-title">Activity</h1>
          <p className="page-subtitle">
            Local history of Safe and agent actions. On-chain txs link to Arbiscan.
          </p>
        </div>
        {items.length > 0 && (
          <button type="button" className="btn btn-ghost btn-sm" onClick={onClear}>
            Clear
          </button>
        )}
      </div>

      <div className="panel overflow-hidden">
        {items.length === 0 ? (
          <p className="p-6 text-[var(--wallet-text-muted)]">
            No activity yet. Deploy a Safe, shield, mint notes, or cash out to populate this list.
          </p>
        ) : (
          <ul className="divide-y divide-[var(--wallet-border)]">
            {items.map((item) => (
              <li key={item.id} className="space-y-2 px-6 py-4">
                <div className="flex flex-wrap items-center gap-2">
                  <KindBadge kind={item.kind} />
                  <span className="font-medium text-[var(--wallet-text-strong)]">{item.summary}</span>
                </div>
                <div className="text-xs text-[var(--wallet-text-muted)]">
                  {new Date(item.at).toLocaleString()}
                  {item.agentName ? ` · agent ${item.agentName}` : ""}
                  {item.amount ? ` · ${item.amount}` : ""}
                </div>
                {item.txHash && (
                  <a
                    className="mono inline-flex text-xs text-[var(--wallet-primary)] hover:underline"
                    href={txExplorerUrl(item.txHash, config.chainId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    tx {truncate(item.txHash)}
                  </a>
                )}
                {!item.txHash && item.address && (
                  <a
                    className="mono inline-flex text-xs text-[var(--wallet-primary)] hover:underline"
                    href={addressExplorerUrl(item.address, config.chainId)}
                    target="_blank"
                    rel="noreferrer"
                  >
                    {truncate(item.address)}
                  </a>
                )}
                {item.safeAddress && (
                  <div>
                    <a
                      className="mono text-xs text-[var(--wallet-text-muted)] hover:underline"
                      href={addressExplorerUrl(item.safeAddress, config.chainId)}
                      target="_blank"
                      rel="noreferrer"
                    >
                      Safe {truncate(item.safeAddress)}
                    </a>
                  </div>
                )}
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

function KindBadge({ kind }: { kind: ActivityKind }) {
  return (
    <span className="rounded-md bg-[var(--wallet-surface-muted)] px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-[var(--wallet-text-muted)]">
      {activityKindLabel(kind)}
    </span>
  );
}
