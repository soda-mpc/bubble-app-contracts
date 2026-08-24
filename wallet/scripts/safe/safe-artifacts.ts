import * as fs from "fs";
import * as path from "path";

const SAFE_ARTIFACTS_ROOT = path.join(
  __dirname,
  "../../node_modules/@safe-global/safe-contracts/build/artifacts/contracts"
);

function loadArtifact(relativeArtifactPath: string): {
  abi: unknown;
  bytecode: string;
  deployedBytecode?: string;
  contractName: string;
} {
  const artifactPath = path.join(SAFE_ARTIFACTS_ROOT, relativeArtifactPath);
  if (!fs.existsSync(artifactPath)) {
    throw new Error(
      `Safe artifact not found at ${artifactPath}. Run npm install and ensure @safe-global/safe-contracts is installed.`
    );
  }
  const artifact = JSON.parse(fs.readFileSync(artifactPath, "utf-8"));
  return {
    abi: artifact.abi,
    bytecode: artifact.bytecode,
    deployedBytecode: artifact.deployedBytecode,
    contractName: artifact.contractName,
  };
}

export async function getSafeL2Factory(hre: { ethers: { getContractFactory: (...args: unknown[]) => Promise<unknown> } }) {
  const artifact = loadArtifact("SafeL2.sol/SafeL2.json");
  return hre.ethers.getContractFactory(artifact.abi, artifact.bytecode);
}

export async function getSafeProxyFactoryFactory(
  hre: { ethers: { getContractFactory: (...args: unknown[]) => Promise<unknown> } }
) {
  const artifact = loadArtifact("proxies/SafeProxyFactory.sol/SafeProxyFactory.json");
  return hre.ethers.getContractFactory(artifact.abi, artifact.bytecode);
}
