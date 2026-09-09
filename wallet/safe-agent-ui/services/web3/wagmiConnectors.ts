import { connectorsForWallets } from "@rainbow-me/rainbowkit";
import { injectedWallet, metaMaskWallet, safeWallet } from "@rainbow-me/rainbowkit/wallets";
import scaffoldConfig from "~~/scaffold.config";

let wagmiConnectorsInstance: ReturnType<typeof connectorsForWallets> | undefined;

export const getWagmiConnectors = () => {
  if (wagmiConnectorsInstance) return wagmiConnectorsInstance;

  wagmiConnectorsInstance = connectorsForWallets(
    [
      {
        groupName: "Supported Wallets",
        wallets: [metaMaskWallet, injectedWallet, safeWallet],
      },
    ],
    {
      appName: "Safe Agent UI",
      projectId: scaffoldConfig.walletConnectProjectId,
    }
  );

  return wagmiConnectorsInstance;
};
