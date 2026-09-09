"use client";

import { useCallback, useEffect, useState } from "react";
import { getAppContractsConfig } from "~~/config/contracts";
import {
  type ActiveSafe,
  getStoredSafe,
  setStoredSafe,
} from "~~/services/safe/safeService";

export function useActiveSafe() {
  const [safe, setSafe] = useState<ActiveSafe | null>(null);
  const [ready, setReady] = useState(false);

  const refresh = useCallback(() => {
    const stored = getStoredSafe();
    if (stored) {
      setSafe(stored);
      setReady(true);
      return;
    }
    const envSafe = getAppContractsConfig().safeAddress;
    if (envSafe) {
      const fromEnv: ActiveSafe = {
        address: envSafe,
        source: "env",
        owners: [],
        threshold: 0,
      };
      setStoredSafe(fromEnv);
      setSafe(fromEnv);
    } else {
      setSafe(null);
    }
    setReady(true);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const clearSafe = useCallback(() => {
    setStoredSafe(null);
    setSafe(null);
  }, []);

  return { safe, ready, refresh, setSafe, clearSafe };
}
