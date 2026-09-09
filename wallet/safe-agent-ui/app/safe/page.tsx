"use client";

import { useState } from "react";
import { BrowserProvider } from "ethers";
import toast from "react-hot-toast";
import { useAccount, useWalletClient } from "wagmi";
import { useActiveSafe } from "~~/hooks/useActiveSafe";
import { deployOneOfOneSafe, importSafeForOwner } from "~~/services/safe/safeService";
import { recordActivity } from "~~/services/activity/activityStore";
import { walletClientToSigner } from "~~/utils/ethers";

export default function SafePage() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { safe, refresh, clearSafe } = useActiveSafe();
  const [importAddress, setImportAddress] = useState("");
  const [busy, setBusy] = useState(false);

  const onImport = async () => {
    if (!walletClient || !address) {
      toast.error("Connect MetaMask first");
      return;
    }
    setBusy(true);
    try {
      const signer = await walletClientToSigner(walletClient);
      const provider = signer.provider as BrowserProvider;
      const active = await importSafeForOwner(provider, importAddress.trim(), address);
      recordActivity({
        kind: "safe_import",
        summary: `Imported Safe ${active.address.slice(0, 10)}…`,
        address: active.address,
        safeAddress: active.address,
      });
      refresh();
      toast.success(`Imported Safe ${active.address.slice(0, 10)}…`);
    } catch (err: any) {
      const nested = err?.error?.message || err?.info?.error?.message || err?.shortMessage;
      const message = nested || err?.message || "Import failed";
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  const onDeploy = async () => {
    if (!walletClient || !address) {
      toast.error("Connect MetaMask first");
      return;
    }
    setBusy(true);
    try {
      const signer = await walletClientToSigner(walletClient);
      const active = await deployOneOfOneSafe(signer, address);
      recordActivity({
        kind: "safe_deploy",
        summary: `Deployed Safe ${active.address.slice(0, 10)}…`,
        txHash: active.deployTxHash,
        address: active.address,
        safeAddress: active.address,
      });
      refresh();
      toast.success(`Deployed Safe ${active.address.slice(0, 10)}…`);
    } catch (err: any) {
      const nested = err?.error?.message || err?.info?.error?.message || err?.shortMessage;
      const message = nested || err?.message || "Deploy failed";
      toast.error(message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="page-title">Safe wallet</h1>
        <p className="page-subtitle">
          Import an existing Safe you own, or deploy a new 1-of-1 Safe on Arbitrum Sepolia.
        </p>
      </div>

      <div className="panel p-6">
        <h2 className="mb-2 text-lg font-semibold text-[var(--wallet-text-strong)]">Current Safe</h2>
        {safe ? (
          <div className="space-y-2 text-sm">
            <div className="mono text-[var(--wallet-text-strong)]">{safe.address}</div>
            <div className="text-[var(--wallet-text-muted)]">
              Source: {safe.source}
              {safe.version ? ` · Safe ${safe.version}` : ""}
              {safe.threshold ? ` · threshold ${safe.threshold}` : ""}
            </div>
            {safe.owners?.length > 0 && (
              <div>
                <div className="field-label">Owners</div>
                <ul className="space-y-1">
                  {safe.owners.map((o) => (
                    <li key={o} className="mono text-xs">
                      {o}
                    </li>
                  ))}
                </ul>
              </div>
            )}
            <button type="button" className="btn btn-ghost btn-sm" onClick={clearSafe}>
              Clear active Safe
            </button>
          </div>
        ) : (
          <p className="text-[var(--wallet-text-muted)]">No Safe selected yet.</p>
        )}
      </div>

      <div className="panel p-6">
        <h2 className="mb-4 text-lg font-semibold text-[var(--wallet-text-strong)]">Import</h2>
        <label className="field-label" htmlFor="safe-import">
          Safe address
        </label>
        <input
          id="safe-import"
          className="field-input mb-4"
          placeholder="0x…"
          value={importAddress}
          onChange={(e) => setImportAddress(e.target.value)}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!isConnected || busy || !importAddress.trim()}
          onClick={onImport}
        >
          {busy ? "Working…" : "Import & verify ownership"}
        </button>
      </div>

      <div className="panel p-6">
        <h2 className="mb-2 text-lg font-semibold text-[var(--wallet-text-strong)]">Deploy new</h2>
        <p className="mb-4 text-sm text-[var(--wallet-text-muted)]">
          Creates a 1-of-1 Safe using canonical Safe 1.4.1 singleton + factory on Arbitrum Sepolia.
          Connected MetaMask becomes the sole owner.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!isConnected || busy}
          onClick={onDeploy}
        >
          {busy ? "Deploying…" : "Deploy 1-of-1 Safe"}
        </button>
      </div>
    </div>
  );
}
