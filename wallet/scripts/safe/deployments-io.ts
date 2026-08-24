import * as fs from "fs";
import * as path from "path";
import type { SafeInfrastructureDeployment, SafeWalletDeployment } from "./types";

const SAFE_DEPLOYMENTS_DIR = path.join(__dirname, "..", "deployments", "safe");

function ensureDir(): void {
  fs.mkdirSync(SAFE_DEPLOYMENTS_DIR, { recursive: true });
}

function safeNetworkName(networkName: string): string {
  return networkName.replace(/[^a-zA-Z0-9_-]/g, "-");
}

export function getSafeInfrastructurePath(networkName: string): string {
  ensureDir();
  return path.join(SAFE_DEPLOYMENTS_DIR, `${safeNetworkName(networkName)}-infrastructure.json`);
}

export function getSafeWalletPath(networkName: string, label = "default"): string {
  ensureDir();
  return path.join(SAFE_DEPLOYMENTS_DIR, `${safeNetworkName(networkName)}-wallet-${label}.json`);
}

export function saveSafeInfrastructure(
  deployment: SafeInfrastructureDeployment,
  networkName: string
): string {
  const targetPath = getSafeInfrastructurePath(networkName);
  fs.writeFileSync(targetPath, `${JSON.stringify(deployment, null, 2)}\n`, "utf-8");
  return targetPath;
}

export function loadSafeInfrastructure(networkName: string): SafeInfrastructureDeployment | undefined {
  const targetPath = getSafeInfrastructurePath(networkName);
  if (!fs.existsSync(targetPath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(targetPath, "utf-8")) as SafeInfrastructureDeployment;
}

export function saveSafeWallet(
  deployment: SafeWalletDeployment,
  networkName: string,
  label = "default"
): string {
  const targetPath = getSafeWalletPath(networkName, label);
  fs.writeFileSync(targetPath, `${JSON.stringify(deployment, null, 2)}\n`, "utf-8");
  return targetPath;
}

export function loadSafeWallet(networkName: string, label = "default"): SafeWalletDeployment | undefined {
  const targetPath = getSafeWalletPath(networkName, label);
  if (!fs.existsSync(targetPath)) {
    return undefined;
  }
  return JSON.parse(fs.readFileSync(targetPath, "utf-8")) as SafeWalletDeployment;
}
