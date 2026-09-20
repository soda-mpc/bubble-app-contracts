"use client";

import { useCallback, useEffect, useState } from "react";
import { formatEther, formatUnits, parseUnits, isAddress } from "viem";
import toast from "react-hot-toast";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { useActiveSafe } from "~~/hooks/useActiveSafe";
import { ERC20_ABI, getAppContractsConfig } from "~~/config/contracts";
import { ensureUserKey, decryptHandleByOwner } from "~~/services/bubble/proxy";
import {
  readPrivateBalanceHandle,
  ensureSafeViewerAccess,
  shieldAndGrantViewToOwners,
  encryptedTransferFromSafe,
  isSafeContractViewPermitted,
} from "~~/services/safe/safeBubbleOps";
import { getSharedAesKey, setSharedAesKey } from "~~/services/safe/multisigKeys";
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
  const [privateSymbol, setPrivateSymbol] = useState<string>("pTUSDC");
  const [privateHandle, setPrivateHandle] = useState<bigint | null>(null);
  const [privateBalance, setPrivateBalance] = useState<string>("—");
  const [shieldAmount, setShieldAmount] = useState("");
  const [transferAmount, setTransferAmount] = useState("");
  const [transferTo, setTransferTo] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [hasContractView, setHasContractView] = useState<boolean | null>(null);

  const isMultisig = (safe?.threshold || 1) > 1;

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

    if (config.privateErc20) {
      try {
        const symbol = (await publicClient.readContract({
          address: config.privateErc20,
          abi: ERC20_ABI,
          functionName: "symbol",
        })) as string;
        setPrivateSymbol(symbol);
      } catch {
        // keep default
      }
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
        if (address) {
          const ok = await isSafeContractViewPermitted({
            provider: signer,
            safeAddress: safe.address,
            viewer: address,
            privateToken: config.privateErc20,
          });
          setHasContractView(ok);
        }
      } catch {
        setPrivateHandle(null);
        setPrivateBalance("error reading handle");
      }
    }
  }, [publicClient, safe?.address, config.underlying, config.privateErc20, walletClient, address]);

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

      const aesKeyHex = await ensureUserKey(signer, config.chainId, config.bubbleProxyUrl);

      // Prefer Safe contract view → decrypt with owner=Safe (works for all multisig owners).
      const contractOk = await isSafeContractViewPermitted({
        provider: signer,
        safeAddress: safe.address,
        viewer: address,
        privateToken: config.privateErc20,
      });

      if (!contractOk) {
        const access = await ensureSafeViewerAccess({
          safeAddress: safe.address,
          signer,
          viewer: address,
          privateToken: config.privateErc20,
          preferContractView: true,
        });
        if (access.granted && access.txHash) {
          toast("Granting Safe → owner contract view…");
          recordActivity({
            kind: "permit_view",
            summary: "Safe permitted owner contract view on private token",
            txHash: access.txHash,
            safeAddress: safe.address,
          });
        }
      }

      const value = await decryptHandleByOwner({
        handle,
        ownerAddress: safe.address,
        aesKeyHex,
        chainId: config.chainId,
      });
      const decimals = tokenMeta?.decimals ?? 18;
      setPrivateBalance(formatUnits(value, decimals));
      setHasContractView(true);
      toast.success("Private balance decrypted (owner = Safe)");
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
      // Ensure shared AES for later transfers: use connected key if not set.
      if (!getSharedAesKey(safe.address)) {
        const aes = await ensureUserKey(signer, config.chainId, config.bubbleProxyUrl);
        setSharedAesKey(safe.address, aes);
      }

      toast(
        isMultisig
          ? "One MultiSend: approve + shield + view for all owners (needs threshold sigs)…"
          : "Approving + shielding + granting view…"
      );
      const result = await shieldAndGrantViewToOwners({
        safeAddress: safe.address,
        signer,
        underlying: config.underlying,
        privateToken: config.privateErc20,
        amount,
        owners: safe.owners?.length ? safe.owners : address ? [address] : [],
      });
      recordActivity({
        kind: "shield",
        summary: `Shielded ${shieldAmount} ${tokenMeta.symbol} + view grants (${safe.owners?.length || 1} owners)`,
        txHash: result.hash,
        safeAddress: safe.address,
        amount: `${shieldAmount} ${tokenMeta.symbol}`,
      });
      toast.success("Shield + view grants submitted — wait a few seconds for MPC sync");
      setShieldAmount("");
      setTimeout(() => {
        refreshBalances().catch(() => undefined);
      }, 8000);
    } catch (err: any) {
      toast.error(err?.error?.message || err?.message || "Shield failed");
    } finally {
      setBusy(null);
    }
  };

  const onEncryptedTransfer = async () => {
    if (!walletClient || !address || !safe || !config.privateErc20 || !tokenMeta) {
      toast.error("Missing wallet / Safe / token config");
      return;
    }
    if (!isAddress(transferTo)) {
      toast.error("Enter a valid recipient address");
      return;
    }
    const amount = parseUnits(transferAmount || "0", tokenMeta.decimals);
    if (amount <= 0n) {
      toast.error("Enter a positive amount");
      return;
    }

    const sharedAes = getSharedAesKey(safe.address);
    if (!sharedAes) {
      toast.error("Set shared AES on the Safe page (Use my Bubble key)");
      return;
    }

    setBusy("transfer");
    try {
      const signer = await walletClientToSigner(walletClient);
      toast("Inspecting IT + submitting encrypted transfer via Safe…");
      const result = await encryptedTransferFromSafe({
        safeAddress: safe.address,
        signer,
        ownerAddress: address,
        privateToken: config.privateErc20,
        recipient: transferTo,
        amount,
        sharedAesKeyHex: sharedAes,
      });
      recordActivity({
        kind: "transfer",
        summary: `Private transfer ${transferAmount} ${tokenMeta.symbol} → ${transferTo.slice(0, 10)}…`,
        txHash: result.hash,
        safeAddress: safe.address,
        amount: `${transferAmount} ${tokenMeta.symbol}`,
      });
      toast.success("Transfer submitted — wait for MPC, then decrypt vault");
      setTransferAmount("");
      setTimeout(() => {
        refreshBalances().catch(() => undefined);
        setPrivateBalance("encrypted (decrypt to view)");
      }, 8000);
    } catch (err: any) {
      toast.error(err?.error?.message || err?.message || "Transfer failed");
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className="mx-auto flex max-w-3xl flex-col gap-6">
      <div>
        <h1 className="page-title">Treasury</h1>
        <p className="page-subtitle">
          Clear ↔ private on the Safe.
          {isMultisig
            ? ` Multisig ${safe?.threshold}-of-${safe?.owners?.length}: one MultiSend for shield+view; threshold sigs via demo co-owners.`
            : " Shield converts clear into private balance."}
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
          <div className="text-xs font-semibold uppercase text-[var(--wallet-text-muted)]">
            Private balance
          </div>
          <div className="mt-2 text-2xl font-semibold text-[var(--wallet-text-strong)]">
            {privateBalance === "—" || privateBalance.startsWith("encrypted") || privateBalance.startsWith("error")
              ? privateBalance
              : `${privateBalance} ${privateSymbol}`}
          </div>
          <p className="mt-2 text-xs leading-relaxed text-[var(--wallet-text-muted)]">
            Personal Bubble key stays in this browser. Decrypt uses unsigned encrypt-to-user with{" "}
            <span className="font-medium text-[var(--wallet-text-strong)]">owner = Safe</span> after{" "}
            <span className="font-medium text-[var(--wallet-text-strong)]">permitContractViewAccess</span>
            {isMultisig
              ? ` (granted to all ${safe?.owners?.length || "n"} owners in the shield MultiSend).`
              : " (granted on shield, or on first decrypt)."}
          </p>
          <p className="mt-1 text-xs leading-relaxed text-[var(--wallet-text-muted)]">
            {isMultisig
              ? `Safe txs need ${safe?.threshold}-of-${safe?.owners?.length} signatures (submitter + demo co-owners or pasted EIP-712 sigs).`
              : "1-of-1 Safe: connected owner executes with a prevalidated signature."}
          </p>
          <div className="mt-1 text-xs text-[var(--wallet-text-muted)]">
            View ACL:{" "}
            {hasContractView == null ? "—" : hasContractView ? "contract view OK" : "not granted yet"}
          </div>
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
          One Safe MultiSend: approve + shield + <span className="font-medium">permitContractViewAccess</span>{" "}
          for every owner. One threshold signature round.
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
            {busy === "shield" ? "Shielding…" : "Shield + grant views"}
          </button>
        </div>
        <div className="mono mt-4 text-xs text-[var(--wallet-text-muted)]">
          Underlying: {config.underlying || "—"}
          <br />
          Private ERC20: {config.privateErc20 || "—"}
        </div>
      </div>

      <div className="panel p-6">
        <h2 className="mb-2 text-lg font-semibold text-[var(--wallet-text-strong)]">
          Private encrypted transfer
        </h2>
        <p className="mb-4 text-sm text-[var(--wallet-text-muted)]">
          Amount is encrypted under the shared AES with <span className="font-medium">userAddress = you</span>{" "}
          (submitter). Co-signers open the IT locally before signing. You must broadcast.
        </p>
        <label className="field-label" htmlFor="transfer-to">
          Recipient
        </label>
        <input
          id="transfer-to"
          className="field-input mb-3 mono text-xs"
          placeholder="0x…"
          value={transferTo}
          onChange={(e) => setTransferTo(e.target.value)}
        />
        <label className="field-label" htmlFor="transfer-amount">
          Amount ({tokenMeta?.symbol || "TUSDC"})
        </label>
        <div className="flex flex-col gap-3 sm:flex-row">
          <input
            id="transfer-amount"
            className="field-input"
            placeholder="1"
            value={transferAmount}
            onChange={(e) => setTransferAmount(e.target.value)}
          />
          <button
            type="button"
            className="btn btn-primary shrink-0"
            disabled={!isConnected || !safe || !!busy || !transferAmount || !transferTo}
            onClick={onEncryptedTransfer}
          >
            {busy === "transfer" ? "Transferring…" : "Transfer via Safe"}
          </button>
        </div>
        {!safe || getSharedAesKey(safe.address) ? null : (
          <p className="mt-3 text-sm text-[var(--wallet-warning)]">
            Shared AES not set — open Safe page and click “Use my Bubble key”.
          </p>
        )}
      </div>

      <button type="button" className="btn btn-ghost btn-sm self-start" onClick={() => refreshBalances()}>
        Refresh balances
      </button>
    </div>
  );
}
