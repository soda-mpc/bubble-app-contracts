import * as fs from "fs";
import * as path from "path";
import { DeploymentRecord, DeploymentResult } from "./deployment-types";

const DEPLOYMENTS_DIR = path.join(__dirname, "deployments");

export function getDeploymentFilePath(networkName: string): string {
  const safeNetwork = networkName.replace(/[^a-zA-Z0-9_-]/g, "-");
  return path.join(DEPLOYMENTS_DIR, `${safeNetwork}.json`);
}

export function resolveDeploymentPath(explicitPath?: string, networkName?: string): string {
  if (explicitPath) {
    return path.isAbsolute(explicitPath) ? explicitPath : path.resolve(process.cwd(), explicitPath);
  }

  if (process.env.DEPLOYMENT_JSON) {
    const envPath = process.env.DEPLOYMENT_JSON;
    return path.isAbsolute(envPath) ? envPath : path.resolve(process.cwd(), envPath);
  }

  const network = networkName ?? process.env.HARDHAT_NETWORK;
  if (network && network !== "hardhat") {
    const networkPath = getDeploymentFilePath(network);
    if (fs.existsSync(networkPath)) {
      return networkPath;
    }
  }

  const legacyPaths = [
    path.join(__dirname, "deployment.json"),
    path.join(process.cwd(), "deployment.json"),
  ];
  for (const legacyPath of legacyPaths) {
    if (fs.existsSync(legacyPath)) {
      return legacyPath;
    }
  }

  if (network && network !== "hardhat") {
    return getDeploymentFilePath(network);
  }

  return path.join(process.cwd(), "deployment.json");
}

/**
 * Writes `result` into the network's deployment file. Sections other scripts recorded (for example `gaslessFactory`)
 * are kept, so re-running one script does not drop another's entries.
 */
export function saveDeploymentResult(
  result: DeploymentResult,
  networkName: string,
  outputPath?: string
): string {
  return saveDeploymentRecord(result, networkName, outputPath);
}

/** Merges `sections` into the network's deployment file (creating it if missing) and returns its path. */
export function saveDeploymentRecord(
  sections: Partial<DeploymentRecord>,
  networkName: string,
  outputPath?: string
): string {
  const targetPath = outputPath ?? getDeploymentFilePath(networkName);
  const existing = fs.existsSync(targetPath) ? loadDeploymentResult(targetPath) : {};
  fs.mkdirSync(path.dirname(targetPath), { recursive: true });
  fs.writeFileSync(targetPath, `${JSON.stringify({ ...existing, ...sections }, null, 2)}\n`, "utf-8");
  return targetPath;
}

export function loadDeploymentResult(filePath: string): DeploymentRecord {
  const raw = fs.readFileSync(filePath, "utf-8");
  return JSON.parse(raw) as DeploymentRecord;
}
