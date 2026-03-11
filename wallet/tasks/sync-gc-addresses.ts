import { task } from "hardhat/config";
import * as fs from "fs";
import * as path from "path";

/**
 * Maps Hardhat network name to the chain folder under contracts/bubble/<chain>/.
 * Per-chain address files (GCDecryptionVerifierAddress.sol, GCACLAddress.sol, GCHandlerAddress.sol)
 * live in those folders and are copied to contracts/bubble/ by this task so compile uses the right addresses.
 */
const NETWORK_TO_CHAIN_FOLDER: Record<string, string> = {
  "sepolia-base": "BASE-SEPOLIA",
  ethereum: "ETHEREUM",
  sepolia: "SEPOLIA",
  "sepolia-arbitrum": "SEPOLIA-ARBITRUM",
  arbitrum: "ARBITRUM",
  polygon: "POLYGON",
  "world-mobile-testnet": "WORLD-MOBILE-TESTNET",
  "sepolia-world": "SEPOLIA-WORLD",
  "arc-testnet": "ARC-TESTNET",
  kurtosis: "KURTOSIS",
};

const CONTRACTS_BUBBLE = "contracts/bubble";

const ADDRESS_FILES = {
  GCDecryptionVerifierAddress: "GCDecryptionVerifierAddress.sol",
  GCACLAddress: "GCACLAddress.sol",
  GCHandlerAddress: "GCHandlerAddress.sol",
} as const;

const PLACEHOLDER_DECRYPTION_VERIFIER = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
// Placeholder when no chain file or env; overwritten by sync-gc-addresses for live networks
address constant GCDecryptionVerifierAddress = address(0);
`;

function getChainFolder(networkName: string): string {
  const mapped = NETWORK_TO_CHAIN_FOLDER[networkName];
  if (mapped) return mapped;
  return networkName.toUpperCase();
}

function syncOneAddressFile(
  root: string,
  chainFolder: string,
  filename: string,
  envVar: string | undefined,
  placeholderContent: string | null,
  options: { ensureGCHandlerAddress?: boolean } = {}
): void {
  const targetPath = path.join(root, CONTRACTS_BUBBLE, filename);
  const chainPath = path.join(root, CONTRACTS_BUBBLE, chainFolder, filename);

  if (envVar) {
    const constantName = path.basename(filename, ".sol");
    const content =
      filename === ADDRESS_FILES.GCHandlerAddress && options.ensureGCHandlerAddress
        ? `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
address constant GCHandlerAddress = ${envVar};
address constant GCExtendedOperationsAddress = ${envVar};
`
        : `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
address constant ${constantName} = ${envVar};
`;
    fs.mkdirSync(path.dirname(targetPath), { recursive: true });
    fs.writeFileSync(targetPath, content, "utf8");
    console.log(`  ${filename}: from env -> ${targetPath}`);
    return;
  }

  if (fs.existsSync(chainPath)) {
    let content = fs.readFileSync(chainPath, "utf8");
    // GCHandlerAddress.sol in chain folders sometimes only has GCExtendedOperationsAddress; MpcCore needs both
    if (filename === ADDRESS_FILES.GCHandlerAddress) {
      const hasGCHandler = /address\s+constant\s+GCHandlerAddress\s*=/.test(content);
      const matchGCExt = content.match(/address\s+constant\s+GCExtendedOperationsAddress\s*=\s*([^;]+);/);
      if (!hasGCHandler && matchGCExt) {
        const addr = matchGCExt[1].trim();
        // Write a single file with one SPDX/pragma and both constants (no duplicate headers)
        content = `// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;
address constant GCHandlerAddress = ${addr};
address constant GCExtendedOperationsAddress = ${addr};
`;
      }
    }
    fs.writeFileSync(targetPath, content, "utf8");
    console.log(`  ${filename}: ${chainFolder}/ -> ${targetPath}`);
  } else {
    if (placeholderContent !== null) {
      fs.writeFileSync(targetPath, placeholderContent, "utf8");
      console.log(`  ${filename}: placeholder (no chain file)`);
    } else {
      console.log(`  ${filename}: skip (no chain file, no placeholder)`);
    }
  }
}

task(
  "sync-gc-addresses",
  "Sync GC address files from contracts/bubble/<chain>/ to contracts/bubble/ so compile uses the right addresses for the selected network. Use Hardhat's --network (e.g. npx hardhat sync-gc-addresses --network sepolia)."
).setAction(async (_, hre) => {
    const networkName = hre.network.name;
    const root = path.resolve(hre.config.paths.root || process.cwd());
    const chainFolder = getChainFolder(networkName);

    console.log(`Syncing GC addresses for network "${networkName}" -> chain folder "${chainFolder}"`);

    syncOneAddressFile(
      root,
      chainFolder,
      ADDRESS_FILES.GCDecryptionVerifierAddress,
      process.env.GCDECRYPTION_VERIFIER_ADDRESS,
      PLACEHOLDER_DECRYPTION_VERIFIER
    );

    syncOneAddressFile(
      root,
      chainFolder,
      ADDRESS_FILES.GCACLAddress,
      process.env.GCACL_ADDRESS,
      null
    );

    syncOneAddressFile(
      root,
      chainFolder,
      ADDRESS_FILES.GCHandlerAddress,
      process.env.GCHANDLER_ADDRESS,
      null,
      { ensureGCHandlerAddress: true }
    );
  });

task(
  "compile-for-network",
  "Sync GC addresses for the given network, then compile. Use before tests/deploy on a live network (e.g. npx hardhat compile-for-network --network sepolia-base)."
).setAction(async (_, hre) => {
  await hre.run("sync-gc-addresses");
  await hre.run("compile");
});
