"use client";

import { useEffect, useState } from "react";
import { RainbowKitProvider, darkTheme, lightTheme } from "@rainbow-me/rainbowkit";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useTheme } from "next-themes";
import { Toaster } from "react-hot-toast";
import { WagmiProvider } from "wagmi";
import { getWagmiConfig } from "~~/services/web3/wagmiConfig";
import { AppShell } from "./AppShell";

const queryClient = new QueryClient();

function RainbowKitTheme({ children }: { children: React.ReactNode }) {
  const { resolvedTheme } = useTheme();
  return (
    <RainbowKitProvider theme={resolvedTheme === "dark" ? darkTheme() : lightTheme()}>
      {children}
    </RainbowKitProvider>
  );
}

export function AppProviders({ children }: { children: React.ReactNode }) {
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  if (!mounted) {
    return (
      <div className="flex min-h-screen items-center justify-center bg-[var(--wallet-bg)] text-[var(--wallet-text-muted)]">
        Loading…
      </div>
    );
  }

  return (
    <WagmiProvider config={getWagmiConfig()} reconnectOnMount>
      <QueryClientProvider client={queryClient}>
        <RainbowKitTheme>
          <AppShell>{children}</AppShell>
          <Toaster position="top-right" />
        </RainbowKitTheme>
      </QueryClientProvider>
    </WagmiProvider>
  );
}
