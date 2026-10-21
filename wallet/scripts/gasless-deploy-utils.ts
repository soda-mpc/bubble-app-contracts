/**
 * Deployment building blocks for the gasless token, shared by the deploy scripts and the test helpers.
 * Takes the Hardhat runtime as a parameter and imports nothing from `test/`.
 */
export const PRIVATE_ERC20_256_GASLESS_FQN =
  "contracts/PrivateERC20Contract256Gasless.sol:PrivateERC20Contract256Gasless";
export const PRIVATE_OPRF_NOTES_FQN = "contracts/libraries/PrivateOPRFNotes.sol:PrivateOPRFNotes";
export const PRIVATE_ERC20_GASLESS_FORWARDER_FQN =
  "contracts/PrivateERC20GaslessForwarder.sol:PrivateERC20GaslessForwarder";
export const ERC1967_PROXY_FQN = "@openzeppelin/contracts/proxy/ERC1967/ERC1967Proxy.sol:ERC1967Proxy";

/** The part of the Hardhat runtime these helpers use; the real `hre` and the test harness type both fit. */
type Runtime = {
  ethers: {
    provider: { getCode: (address: string) => Promise<string> };
    getContractFactory: (...args: any[]) => Promise<any>;
  };
};

export async function waitForContractCode(
  address: string,
  hre: Runtime,
  timeoutMs = 5000,
  pollIntervalMs = 500
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const code = await hre.ethers.provider.getCode(address);
    if (code && code !== "0x") {
      return code;
    }
    await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Contract at ${address} still has no code after ${timeoutMs}ms`);
}

/**
 * After deployment, wait for the deployment tx (if present), then poll until `getCode` is non-empty
 * (helps with RPC propagation). Same pattern as restriction-list integration tests.
 */
export async function waitForDeploymentConfirmation(
  contract: {
    deploymentTransaction?: () => { wait?: () => Promise<unknown> } | null | undefined;
    getAddress: () => Promise<string>;
  },
  hre: Runtime,
  options?: { pollIntervalMs?: number; maxAttempts?: number }
): Promise<void> {
  const tx = typeof contract.deploymentTransaction === "function" ? contract.deploymentTransaction() : null;
  if (tx && typeof tx.wait === "function") {
    await tx.wait();
  }
  const address = await contract.getAddress();
  const { pollIntervalMs = 2000, maxAttempts = 10 } = options ?? {};
  await waitForContractCode(address, hre, maxAttempts * pollIntervalMs, pollIntervalMs);
}

/** Deploys the PrivateOPRFNotes library linked by PrivateERC20Contract256Gasless. Returns its address. */
export async function deployPrivateOPRFNotesLibrary(hre: Runtime, signer: any): Promise<string> {
  const factory = await hre.ethers.getContractFactory(PRIVATE_OPRF_NOTES_FQN, signer);
  const library = await factory.deploy();
  await library.waitForDeployment();
  await waitForDeploymentConfirmation(library, hre);
  return library.getAddress();
}
