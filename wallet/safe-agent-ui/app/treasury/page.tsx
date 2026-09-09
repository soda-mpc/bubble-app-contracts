"use client";

import { useCallback, useEffect, useState } from "react";
import { formatEther, formatUnits, parseUnits } from "viem";
import toast from "react-hot-toast";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { useActiveSafe } from "~~/hooks/useActiveSafe";
import { ERC20_ABI, getAppContractsConfig } from "~~/config/contracts";
import { ensureUserKey, decryptHandleByOwner } from "~~/services/bubble/proxy";
import {
  readPrivateBalanceHandle,
  ensureSafeViewerAccess,
  shieldFromSafe,
} from "~~/services/safe/safeBubbleOps";
import { walletClientToSigner } from "~~/utils/ethers";
import { recordActivity } from "~~/services/activity/activityStore";

export default function TreasuryPage() {
  const { isConnected, address } = useAccount();
  const { safe } = useActiveSafe();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const config = getAppContractsConfig();

  const [ethBalance, setEthBalance] = useState<string>("—");
  const [clearBalanceRaw, setClearBalanceRaw] = useState<bigint>(0n);
  const [clearBalance, setClearBalance] = useState<string>("—");
  const [tokenMeta, setTokenMeta] = useState<{ symbol: string; decimals: number } | null>(null);
  const [privateHandle, setPrivateHandle] = useState<bigint | null>(null);
  const [privateBalance, setPrivateBalance] = useState<string>("—");
  const [shieldAmount, setShieldAmount] = useState("");
  const [busy, setBusy] = useState<string | null>(null);

  const refreshBalances = useCallback(async () => {
    if (!publicClient || !safe?.address) return;

    const eth = await publicClient.getBalance({ address: safe.address });
    setEthBalance(formatEther(eth));

    if (config.underlying) {
      const [symbol, decimals, balance] = await Promise.all([
        publicClient.readContract({
          address: config.underlying,
          abi: ERC20_ABI,
          functionName: "symbol",
        }) as Promise<string>,
        publicClient.readContract({
          address: config.underlying,
          abi: ERC20_ABI,
          functionName: "decimals",
        }) as Promise<number>,
        publicClient.readContract({
          address: config.underlying,
          abi: ERC20_ABI,
          functionName: "balanceOf",
          args: [safe.address],
        }) as Promise<bigint>,
      ]);
      setTokenMeta({ symbol, decimals: Number(decimals) });
      setClearBalanceRaw(balance);
      setClearBalance(formatUnits(balance, Number(decimals)));
    }

    if (config.privateErc20 && walletClient) {
      try {
        const signer = await walletClientToSigner(walletClient);
        const handle = await readPrivateBalanceHandle(signer.provider!, config.privateErc20, safe.address);
        setPrivateHandle(handle);
        if (handle === 0n) {
          setPrivateBalance("0");
        } else {
          setPrivateBalance((prev) => (prev === "—" || prev === "0" ? "encrypted (decrypt to view)" : prev));
        }
      } catch {
        setPrivateHandle(null);
        setPrivateBalance("error reading handle");
      }
    }
  }, [publicClient, safe?.address, config.underlying, config.privateErc20, walletClient]);

  useEffect(() => {
    refreshBalances().catch(() => setClearBalance("error"));
  }, [refreshBalances]);

  const onDecryptPrivate = async () => {
    if (!walletClient || !address || !safe || !config.privateErc20) {
      toast.error("Connect wallet, set Safe, and configure private token");
      return;
    }
    setBusy("decrypt");
    try {
      const signer = await walletClientToSigner(walletClient);
      const handle =
        privateHandle ??
        (await readPrivateBalanceHandle(signer.provider!, config.privateErc20, safe.address));
      setPrivateHandle(handle);
      if (handle === 0n) {
        setPrivateBalance("0");
        toast.success("Private balance is zero");
        return;
      }

      // AES key from localStorage after one-time onboard (same as sodawallet)
      const aesKeyHex = await ensureUserKey(signer, config.chainId, config.bubbleProxyUrl);

      // Safe tx only if this balance handle is not yet permitted to the EOA
      const access = await ensureSafeViewerAccess({
        safeAddress: safe.address,
        signer,
        viewer: address,
        privateToken: config.privateErc20,
        handle,
      });
      if (access.granted && access.txHash) {
        toast("Granting Safe → owner view on balance handle…");
        recordActivity({
          kind: "permit_view",
          summary: "Safe permitted owner to view private balance",
          txHash: access.txHash,
          safeAddress: safe.address,
        });
      }

      // Unsigned owner decrypt — no MetaMask signMessage (sodawallet path)
      const value = await decryptHandleByOwner({
        handle,
        ownerAddress: address,
        aesKeyHex,
        chainId: config.chainId,
      });
      const decimals = tokenMeta?.decimals ?? 18;
      setPrivateBalance(formatUnits(value, decimals));
      toast.success("Private balance decrypted");
    } catch (err: any) {
      toast.error(err?.error?.message || err?.message || "Decrypt failed");
    } finally {
      setBusy(null);
    }
  };

  const onShield = async () => {
    if (!walletClient || !safe || !config.underlying || !config.privateErc20 || !tokenMeta) {
      toast.error("Missing wallet / Safe / token config");
      return;
    }
    const amount = parseUnits(shieldAmount || "0", tokenMeta.decimals);
    if (amount <= 0n) {
      toast.error("Enter a positive amount");
      return;
    }
    if (amount > clearBalanceRaw) {
      toast.error("Amount exceeds clear Safe balance");
      return;
    }

    setBusy("shield");
    try {
      const signer = await walletClientToSigner(walletClient);
      toast("Approving + shielding via Safe…");
      const result = await shieldFromSafe({
        safeAddress: safe.address,
        signer,
        underlying: config.underlying,
        privateToken: config.privateErc20,
        amount,
      });
      recordActivity({
        kind: "shield",
        summary: `Shielded ${shieldAmount} ${tokenMeta.symbol} → private`,
        txHash: result.hash,
        safeAddress: safe.address,
        amount: `${shieldAmount} ${tokenMeta.symbol}`,
      });
      toast.success("Shield submitted — wait a few seconds for MPC sync");
      setShieldAmount("");
      setTimeout(() => {
        refreshBalances().catch(() => undefined);
      }, 5000);
    } catch (err: any) {
      toast.error(err?.error?.message || err?.message || "Shield failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="page-title">Treasury</h1>
        <p className="page-subtitle">
          Clear and private balances on the Safe. Shield converts clear TUSDC into private balance.
        </p>
      </div>

      {!isConnected && (
        <div className="panel p-4 text-[var(--wallet-warning)]">Connect MetaMask to continue.</div>
      )}
      {!safe && (
        <div className="panel p-4 text-[var(--wallet-warning)]">Set an active Safe first.</div>
      )}

      <div className="grid gap-4 md:grid-cols-3">
        <div className="panel p-5">
          <div className="text-xs font-semibold uppercase text-[var(--wallet-text-muted)]">ETH</div>
          <div className="mt-2 text-2xl font-semibold text-[var(--wallet-text-strong)]">{ethBalance}</div>
        </div>
        <div className="panel p-5">
          <div className="text-xs font-semibold uppercase text-[var(--wallet-text-muted)]">
            Clear {tokenMeta?.symbol || "TUSDC"}
          </div>
          <div className="mt-2 text-2xl font-semibold text-[var(--wallet-text-strong)]">{clearBalance}</div>
        </div>
        <div className="panel p-5">
          <div className="text-xs font-semibold uppercase text-[var(--wallet-text-muted)]">Private</div>
          <div className="mt-2 text-2xl font-semibold text-[var(--wallet-text-strong)]">{privateBalance}</div>
          <button
            type="button"
            className="btn btn-ghost btn-sm mt-3"
            disabled={!isConnected || !safe || !!busy || !config.privateErc20}
            onClick={onDecryptPrivate}
          >
            {busy === "decrypt" ? "Decrypting…" : "Decrypt private balance"}
          </button>
        </div>
      </div>

      <div className="panel p-6">
        <h2 className="mb-2 text-lg font-semibold text-[var(--wallet-text-strong)]">
          Shield clear → private
        </h2>
        <p className="mb-4 text-sm text-[var(--wallet-text-muted)]">
          Safe approves the private token, then calls <span className="font-medium">shield</span>. Two
          Safe transactions (approve + shield).
        </p>
        <label className="field-label" htmlFor="shield-amount">
          Amount ({tokenMeta?.symbol || "TUSDC"})
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="shield-amount"
            className="field-input"
            placeholder="10"
            value={shieldAmount}
            onChange={(e) => setShieldAmount(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-ghost shrink-0"
            disabled={clearBalanceRaw === 0n}
            onClick={() =>
              tokenMeta && setShieldAmount(formatUnits(clearBalanceRaw, tokenMeta.decimals))
            }
          >
            Max
          </button>
          <button
            type="button"
            className="btn btn-primary shrink-0"
            disabled={!isConnected || !safe || !!busy || !shieldAmount}
            onClick={onShield}
          >
            {busy === "shield" ? "Shielding…" : "Shield via Safe"}
          </button>
        </div>
        <div className="mono mt-4 text-xs text-[var(--wallet-text-muted)]">
          Underlying: {config.underlying || "—"}
          <br />
          Private ERC20: {config.privateErc20 || "—"}
        </div>
      </div>

      <button type="button" className="btn btn-ghost btn-sm self-start" onClick={() => refreshBalances()}>
        Refresh balances
      </button>
    </div>
  );
}
