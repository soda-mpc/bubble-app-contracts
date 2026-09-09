import { createClient, http } from "viem";
import { createConfig, createStorage, type Config } from "wagmi";
import scaffoldConfig from "~~/scaffold.config";
import { getWagmiConnectors } from "./wagmiConnectors";

const { targetNetworks } = scaffoldConfig;

export const enabledChains = targetNetworks;

let wagmiConfigInstance: Config | undefined;

export const getWagmiConfig = (): Config => {
  if (wagmiConfigInstance) return wagmiConfigInstance;

  wagmiConfigInstance = createConfig({
    chains: enabledChains,
    connectors: getWagmiConnectors(),
    // Providers mount client-side only — persist to localStorage for reconnect-on-refresh.
    ssr: false,
    storage: createStorage({
      key: "safe-agent-ui.wagmi",
      storage: window.localStorage,
    }),
    client({ chain }) {
      return createClient({
        chain,
        transport: http(chain.rpcUrls.default.http[0]),
        pollingInterval: scaffoldConfig.pollingInterval,
      });
    },
  });

  return wagmiConfigInstance;
};
