"use client";

import { ConnectButton } from "@rainbow-me/rainbowkit";
import { useAccount, useChainId, useSwitchChain } from "wagmi";
import { ARBITRUM_SEPOLIA_CHAIN_ID } from "~~/config/contracts";
import { useActiveSafe } from "~~/hooks/useActiveSafe";

function truncate(address?: string) {
  if (!address) return "";
  return `${address.slice(0, 6)}…${address.slice(-4)}`;
}

export function Header() {
  const { isConnected } = useAccount();
  const chainId = useChainId();
  const { switchChain } = useSwitchChain();
  const { safe } = useActiveSafe();
  const wrongNetwork = isConnected && chainId !== ARBITRUM_SEPOLIA_CHAIN_ID;

  return (
    <header className="sticky top-0 z-30 flex items-center justify-between gap-4 border-b border-[var(--wallet-border)] bg-[var(--wallet-surface)]/95 px-4 py-3 backdrop-blur md:px-8">
      <div className="min-w-0">
        <div className="text-xs font-semibold uppercase tracking-wide text-[var(--wallet-text-muted)]">
          Active Safe
        </div>
        <div className="mono truncate text-[var(--wallet-text-strong)]">
          {safe ? truncate(safe.address) : "Not set — import or deploy"}
        </div>
      </div>

      <div className="flex flex-wrap items-center justify-end gap-2">
        {wrongNetwork && (
          <button
            type="button"
            className="btn btn-sm border-0 bg-[var(--wallet-warning-soft)] text-[var(--wallet-warning)]"
            onClick={() => switchChain?.({ chainId: ARBITRUM_SEPOLIA_CHAIN_ID })}
          >
            Switch to Arb Sepolia
          </button>
        )}
        <ConnectButton showBalance={false} chainStatus="icon" accountStatus="address" />
      </div>
    </header>
  );
}
