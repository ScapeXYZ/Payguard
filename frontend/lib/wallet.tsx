"use client";
// NEAR Wallet Selector integration (v10). Connect / disconnect / active account, and
// signAndSend() for the owner, guardian and exit methods contract/guard.ts exposes.
// `pay` is deliberately NOT here: the agent key never touches the browser; the agent
// payment runner signs payments server-side.
import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import type { WalletSelector } from "@near-wallet-selector/core";
import type { WalletSelectorModal } from "@near-wallet-selector/modal-ui";
import { GUARD_CONTRACT_ID, IS_MOCK } from "./guard";
import { NETWORK, RPC_URL } from "./near-rpc";

export type WriteCall =
  | { method: "init"; args: { owner_id: string; agent_id: string; guardian_id: string; exit_id: string } }
  | { method: "set_policy"; args: { token_id: string; max_per_payment: string; daily_limit: string; recipients: string[] } }
  | { method: "activate_policy"; args: { proposal_id: string } }
  | { method: "cancel_policy"; args: Record<string, never> }
  | { method: "disable_policy"; args: { token_id: string } }
  | { method: "propose_guardian_change"; args: { guardian_id: string } }
  | { method: "propose_cold_key_guardian_change"; args: { guardian_id: string } }
  | { method: "cancel_guardian_change"; args: Record<string, never> }
  | { method: "activate_guardian_change"; args: { proposal_id: string } }
  | { method: "propose_owner_recovery"; args: { owner_id: string } }
  | { method: "cancel_owner_recovery"; args: Record<string, never> }
  | { method: "activate_owner_recovery"; args: { proposal_id: string } }
  | { method: "emergency_sweep"; args: { token_id: string } };

export type Method = WriteCall["method"];

const TGAS = 1_000_000_000_000n;
// emergency_sweep: beginSweep() requires 180-250 Tgas prepaid. Everything else is a
// single-receipt state write; 50 Tgas leaves headroom for the JS VM. Deposit is always 0
// (zeroDeposit() in policy.ts rejects any attached NEAR).
export const gasFor = (m: Method) => (m === "emergency_sweep" ? 200n : 50n) * TGAS;

type WalletCtx = {
  ready: boolean;
  accountId: string | null;
  walletId: string | null;
  connect: () => void;
  disconnect: () => Promise<void>;
  signAndSend: (call: WriteCall) => Promise<{ hash: string | null; signerId: string }>;
  error?: string;
};

const Ctx = createContext<WalletCtx | null>(null);

export function WalletProvider({ children }: { children: React.ReactNode }) {
  const [selector, setSelector] = useState<WalletSelector | null>(null);
  const [modal, setModal] = useState<WalletSelectorModal | null>(null);
  const [accountId, setAccountId] = useState<string | null>(null);
  const [walletId, setWalletId] = useState<string | null>(null);
  const [error, setError] = useState<string>();

  useEffect(() => {
    if (IS_MOCK) return;
    let alive = true;
    let unsub: { unsubscribe(): void } | undefined;
    (async () => {
      try {
        // Browser-only modules: loaded after mount so the static export never touches window.
        const [{ setupWalletSelector }, { setupModal }, { setupMyNearWallet }, { setupMeteorWallet }] = await Promise.all([
          import("@near-wallet-selector/core"), import("@near-wallet-selector/modal-ui"),
          import("@near-wallet-selector/my-near-wallet"), import("@near-wallet-selector/meteor-wallet"),
        ]);
        const sel = await setupWalletSelector({
          network: {
            networkId: NETWORK, nodeUrl: RPC_URL,
            helperUrl: NETWORK === "mainnet" ? "https://helper.mainnet.near.org" : "https://helper.testnet.near.org",
            explorerUrl: NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io",
            indexerUrl: "",
          },
          modules: [setupMyNearWallet(), setupMeteorWallet()],
        });
        if (!alive) return;
        // No contractId: we never ask for a function-call access key. Every action is
        // approved in the wallet.
        const m = setupModal(sel, { theme: "dark", description: "Connect the owner, guardian or exit account of this guard." });
        const apply = () => {
          const st = sel.store.getState();
          setAccountId(st.accounts.find((a) => a.active)?.accountId ?? null);
          setWalletId(st.selectedWalletId);
        };
        apply();
        unsub = sel.store.observable.subscribe(apply);
        setSelector(sel); setModal(m);
      } catch (e) {
        if (alive) setError(`wallet selector failed to load: ${String((e as Error)?.message ?? e)}`);
      }
    })();
    return () => { alive = false; unsub?.unsubscribe(); };
  }, []);

  const connect = useCallback(() => modal?.show(), [modal]);
  const disconnect = useCallback(async () => {
    if (!selector) return;
    const w = await selector.wallet();
    await w.signOut();
  }, [selector]);

  const signAndSend = useCallback(async (call: WriteCall) => {
    if (IS_MOCK) throw new Error("mock mode: signing is disabled");
    if (!selector || !accountId) throw new Error("connect a wallet first");
    const { actionCreators } = await import("@near-wallet-selector/core");
    const w = await selector.wallet();
    const outcome = await w.signAndSendTransaction({
      signerId: accountId,
      receiverId: GUARD_CONTRACT_ID,
      actions: [actionCreators.functionCall(call.method, call.args, gasFor(call.method), 0n)],
    });
    // The wallet's own result is NOT trusted as success. Only the hash is used; the
    // caller re-reads the final outcome from RPC (lib/use-tx.ts).
    const hash = (outcome as { transaction?: { hash?: string }; transaction_outcome?: { id?: string } } | void)?.transaction?.hash
      ?? (outcome as { transaction_outcome?: { id?: string } } | void)?.transaction_outcome?.id ?? null;
    return { hash, signerId: accountId };
  }, [selector, accountId]);

  const value = useMemo<WalletCtx>(() => ({ ready: !!selector, accountId, walletId, connect, disconnect, signAndSend, error }),
    [selector, accountId, walletId, connect, disconnect, signAndSend, error]);
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useWallet(): WalletCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("useWallet outside WalletProvider");
  return c;
}
