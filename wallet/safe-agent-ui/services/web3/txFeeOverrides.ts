import type { Provider } from "ethers";

export type TxFeeOverrides = {
  maxFeePerGas?: bigint;
  maxPriorityFeePerGas?: bigint;
  gasPrice?: bigint;
};

const FEE_BUFFER_PERCENT = 125n;
const BASE_FEE_MULTIPLIER = 2n;
const MIN_PRIORITY_FEE_WEI = 100_000_000n; // 0.1 gwei

/**
 * EIP-1559 fee overrides with a buffer over the current base fee.
 *
 * On Arbitrum Sepolia the base fee can move between estimation and inclusion,
 * causing "max fee per gas less than block base fee". Unused max fee is refunded.
 */
export async function resolveTxFeeOverrides(provider: Provider): Promise<TxFeeOverrides> {
  try {
    const [feeData, block] = await Promise.all([provider.getFeeData(), provider.getBlock("latest")]);
    const baseFee = block?.baseFeePerGas ?? 0n;

    if (baseFee > 0n) {
      const priorityFee =
        feeData.maxPriorityFeePerGas && feeData.maxPriorityFeePerGas > 0n
          ? (feeData.maxPriorityFeePerGas * FEE_BUFFER_PERCENT) / 100n
          : MIN_PRIORITY_FEE_WEI;
      const bufferedMaxFee = baseFee * BASE_FEE_MULTIPLIER + priorityFee;
      const maxFeePerGas =
        feeData.maxFeePerGas && feeData.maxFeePerGas > bufferedMaxFee
          ? (feeData.maxFeePerGas * FEE_BUFFER_PERCENT) / 100n
          : bufferedMaxFee;

      return { maxFeePerGas, maxPriorityFeePerGas: priorityFee };
    }

    if (feeData.maxFeePerGas != null && feeData.maxFeePerGas > 0n) {
      return {
        maxFeePerGas: (feeData.maxFeePerGas * FEE_BUFFER_PERCENT) / 100n,
        maxPriorityFeePerGas: ((feeData.maxPriorityFeePerGas ?? MIN_PRIORITY_FEE_WEI) * FEE_BUFFER_PERCENT) / 100n,
      };
    }

    if (feeData.gasPrice && feeData.gasPrice > 0n) {
      return { gasPrice: (feeData.gasPrice * FEE_BUFFER_PERCENT) / 100n };
    }
  } catch {
    // fall through
  }
  return {};
}
