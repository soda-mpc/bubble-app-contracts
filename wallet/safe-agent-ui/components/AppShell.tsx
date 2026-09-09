"use client";

import { useState } from "react";
import { Bars3Icon } from "@heroicons/react/24/outline";
import { Header } from "./Header";
import { Sidebar } from "./Sidebar";

export function AppShell({ children }: { children: React.ReactNode }) {
  const [mobileOpen, setMobileOpen] = useState(false);

  return (
    <div className="flex min-h-screen bg-[var(--wallet-bg)] text-[var(--wallet-text-default)]">
      <Sidebar mobileOpen={mobileOpen} onMobileClose={() => setMobileOpen(false)} />
      <div className="flex min-w-0 flex-1 flex-col">
        <div className="flex items-center gap-2 border-b border-[var(--wallet-border)] bg-[var(--wallet-surface)] px-4 py-3 md:hidden">
          <button
            type="button"
            aria-label="Open navigation"
            className="rounded-lg p-2 text-[var(--wallet-text-muted)] hover:bg-[var(--wallet-surface-muted)]"
            onClick={() => setMobileOpen(true)}
          >
            <Bars3Icon className="h-6 w-6" />
          </button>
          <span className="font-semibold text-[var(--wallet-text-strong)]">Safe Agent</span>
        </div>
        <Header />
        <main className="relative flex-1 p-4 md:p-8">{children}</main>
      </div>
    </div>
  );
}
