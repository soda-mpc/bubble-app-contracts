"use client";

import { useEffect, useState } from "react";
import { BrowserProvider, isAddress } from "ethers";
import toast from "react-hot-toast";
import { useAccount, useWalletClient } from "wagmi";
import { useActiveSafe } from "~~/hooks/useActiveSafe";
import { ensureUserKey } from "~~/services/bubble/proxy";
import { getAppContractsConfig } from "~~/config/contracts";
import {
  deployOneOfOneSafe,
  deploySafeWallet,
  importSafeForOwner,
} from "~~/services/safe/safeService";
import {
  clearDemoCoOwners,
  clearSharedAesKey,
  generateDemoCoOwners,
  getDemoCoOwners,
  getSharedAesKey,
  setDemoCoOwners,
  setSharedAesKey,
  type DemoCoOwner,
} from "~~/services/safe/multisigKeys";
import { recordActivity } from "~~/services/activity/activityStore";
import { walletClientToSigner } from "~~/utils/ethers";

export default function SafePage() {
  const { address, isConnected } = useAccount();
  const { data: walletClient } = useWalletClient();
  const { safe, refresh, clearSafe } = useActiveSafe();
  const config = getAppContractsConfig();
  const [importAddress, setImportAddress] = useState("");
  const [busy, setBusy] = useState(false);
  const [extraOwnersText, setExtraOwnersText] = useState("");
  const [threshold, setThreshold] = useState(2);
  const [demoCoOwners, setDemoCoOwnersState] = useState<DemoCoOwner[]>([]);
  const [sharedAes, setSharedAes] = useState("");

  useEffect(() => {
    if (!safe?.address) {
      setDemoCoOwnersState([]);
      setSharedAes("");
      return;
    }
    setDemoCoOwnersState(getDemoCoOwners(safe.address));
    setSharedAes(getSharedAesKey(safe.address) || "");
  }, [safe?.address]);

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
        summary: `Imported Safe ${active.address.slice(0, 10)}… (${active.threshold}-of-${active.owners.length})`,
        address: active.address,
        safeAddress: active.address,
      });
      refresh();
      toast.success(
        `Imported Safe ${active.address.slice(0, 10)}… · ${active.threshold}-of-${active.owners.length}`
      );
    } catch (err: any) {
      const nested = err?.error?.message || err?.info?.error?.message || err?.shortMessage;
      toast.error(nested || err?.message || "Import failed");
    } finally {
      setBusy(false);
    }
  };

  const onDeployOneOfOne = async () => {
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
        summary: `Deployed 1-of-1 Safe ${active.address.slice(0, 10)}…`,
        txHash: active.deployTxHash,
        address: active.address,
        safeAddress: active.address,
      });
      refresh();
      toast.success(`Deployed Safe ${active.address.slice(0, 10)}…`);
    } catch (err: any) {
      const nested = err?.error?.message || err?.info?.error?.message || err?.shortMessage;
      toast.error(nested || err?.message || "Deploy failed");
    } finally {
      setBusy(false);
    }
  };

  const onDeployMultisig = async () => {
    if (!walletClient || !address) {
      toast.error("Connect MetaMask first");
      return;
    }

    const extras = extraOwnersText
      .split(/[\n,]+/)
      .map((s) => s.trim())
      .filter(Boolean);

    let owners = [address, ...extras];
    let localDemo: DemoCoOwner[] = [];

    // If no extra addresses pasted, generate demo co-owners for same-browser 2-of-3.
    if (extras.length === 0) {
      localDemo = generateDemoCoOwners(2);
      owners = [address, ...localDemo.map((o) => o.address)];
    }

    for (const o of owners) {
      if (!isAddress(o)) {
        toast.error(`Invalid owner address: ${o}`);
        return;
      }
    }

    const t = Math.min(Math.max(1, threshold), owners.length);
    setBusy(true);
    try {
      const signer = await walletClientToSigner(walletClient);
      const active = await deploySafeWallet(signer, owners, t);
      if (localDemo.length > 0) {
        setDemoCoOwners(active.address, localDemo);
        setDemoCoOwnersState(localDemo);
      }
      recordActivity({
        kind: "safe_deploy",
        summary: `Deployed ${t}-of-${owners.length} Safe ${active.address.slice(0, 10)}…`,
        txHash: active.deployTxHash,
        address: active.address,
        safeAddress: active.address,
      });
      refresh();
      toast.success(`Deployed ${t}-of-${owners.length} Safe ${active.address.slice(0, 10)}…`);
    } catch (err: any) {
      const nested = err?.error?.message || err?.info?.error?.message || err?.shortMessage;
      toast.error(nested || err?.message || "Deploy failed");
    } finally {
      setBusy(false);
    }
  };

  const onSaveSharedAes = async () => {
    if (!safe?.address) return;
    try {
      if (sharedAes.trim()) {
        setSharedAesKey(safe.address, sharedAes.trim());
        toast.success("Shared AES key saved for this Safe");
      } else {
        clearSharedAesKey(safe.address);
        toast.success("Cleared shared AES key");
      }
    } catch (err: any) {
      toast.error(err?.message || "Invalid AES key");
    }
  };

  const onUseMyKeyAsShared = async () => {
    if (!walletClient || !safe?.address) {
      toast.error("Connect wallet and set a Safe");
      return;
    }
    setBusy(true);
    try {
      const signer = await walletClientToSigner(walletClient);
      const aes = await ensureUserKey(signer, config.chainId, config.bubbleProxyUrl);
      setSharedAesKey(safe.address, aes);
      setSharedAes(aes);
      toast.success("Connected account’s Bubble key set as shared AES (for IT inspection)");
    } catch (err: any) {
      toast.error(err?.message || "Onboard failed");
    } finally {
      setBusy(false);
    }
  };

  const onClearDemo = () => {
    if (!safe?.address) return;
    clearDemoCoOwners(safe.address);
    setDemoCoOwnersState([]);
    toast.success("Cleared local demo co-owners");
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="page-title">Safe wallet</h1>
        <p className="page-subtitle">
          Import a Safe, deploy 1-of-1, or deploy k-of-n (e.g. 2-of-3) for the shared Bubble vault
          flow.
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
              {safe.threshold ? ` · ${safe.threshold}-of-${safe.owners?.length || "?"}` : ""}
            </div>
            {safe.owners?.length > 0 && (
              <div>
                <div className="field-label">Owners</div>
                <ul className="space-y-1">
                  {safe.owners.map((o) => (
                    <li key={o} className="mono text-xs">
                      {o}
                      {address && o.toLowerCase() === address.toLowerCase() ? " (you)" : ""}
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

      {safe && (
        <div className="panel p-6">
          <h2 className="mb-2 text-lg font-semibold text-[var(--wallet-text-strong)]">
            Shared AES (IT inspection)
          </h2>
          <p className="mb-4 text-sm text-[var(--wallet-text-muted)]">
            Co-signers use this key to open encrypted transfer amounts before signing. Usually the
            designated crypto owner’s Bubble AES. Vault decrypt still uses each owner’s personal
            key.
          </p>
          <label className="field-label" htmlFor="shared-aes">
            AES hex (32 chars)
          </label>
          <input
            id="shared-aes"
            className="field-input mb-3 mono text-xs"
            placeholder="paste or set from connected account"
            value={sharedAes}
            onChange={(e) => setSharedAes(e.target.value)}
          />
          <div className="flex flex-wrap gap-2">
            <button type="button" className="btn btn-primary btn-sm" onClick={onSaveSharedAes}>
              Save
            </button>
            <button
              type="button"
              className="btn btn-ghost btn-sm"
              disabled={!isConnected || busy}
              onClick={onUseMyKeyAsShared}
            >
              Use my Bubble key
            </button>
          </div>
        </div>
      )}

      {safe && (safe.threshold || 1) > 1 && (
        <div className="panel p-6">
          <h2 className="mb-2 text-lg font-semibold text-[var(--wallet-text-strong)]">
            Demo co-owners (local)
          </h2>
          <p className="mb-4 text-sm text-[var(--wallet-text-muted)]">
            Private keys stored in this browser so one MetaMask can complete threshold txs. For a
            real multi-device flow, paste external EIP-712 signatures instead (coming next).
          </p>
          {demoCoOwners.length === 0 ? (
            <p className="text-sm text-[var(--wallet-text-muted)]">
              No local demo co-owners. Deploy 2-of-3 without pasting addresses to auto-generate two.
            </p>
          ) : (
            <ul className="mb-3 space-y-1">
              {demoCoOwners.map((o) => (
                <li key={o.address} className="mono text-xs">
                  {o.label}: {o.address}
                </li>
              ))}
            </ul>
          )}
          {demoCoOwners.length > 0 && (
            <button type="button" className="btn btn-ghost btn-sm" onClick={onClearDemo}>
              Clear demo co-owners
            </button>
          )}
        </div>
      )}

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
        <h2 className="mb-2 text-lg font-semibold text-[var(--wallet-text-strong)]">Deploy 1-of-1</h2>
        <p className="mb-4 text-sm text-[var(--wallet-text-muted)]">
          Connected MetaMask becomes the sole owner.
        </p>
        <button
          type="button"
          className="btn btn-primary"
          disabled={!isConnected || busy}
          onClick={onDeployOneOfOne}
        >
          {busy ? "Deploying…" : "Deploy 1-of-1 Safe"}
        </button>
      </div>

      <div className="panel p-6">
        <h2 className="mb-2 text-lg font-semibold text-[var(--wallet-text-strong)]">
          Deploy multisig (k-of-n)
        </h2>
        <p className="mb-4 text-sm text-[var(--wallet-text-muted)]">
          Leave extra owners empty to auto-generate two local demo co-owners (2-of-3 in one
          browser). Or paste additional owner addresses (one per line).
        </p>
        <label className="field-label" htmlFor="extra-owners">
          Extra owners (optional)
        </label>
        <textarea
          id="extra-owners"
          className="field-input mb-3 min-h-[88px] mono text-xs"
          placeholder={"0xabc…\n0xdef…"}
          value={extraOwnersText}
          onChange={(e) => setExtraOwnersText(e.target.value)}
        />
        <label className="field-label" htmlFor="threshold">
          Threshold
        </label>
        <input
          id="threshold"
          type="number"
          min={1}
          className="field-input mb-4 w-28"
          value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value) || 1)}
        />
        <button
          type="button"
          className="btn btn-primary"
          disabled={!isConnected || busy}
          onClick={onDeployMultisig}
        >
          {busy ? "Deploying…" : "Deploy multisig Safe"}
        </button>
      </div>
    </div>
  );
}
