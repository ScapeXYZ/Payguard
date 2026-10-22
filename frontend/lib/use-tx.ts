"use client";
import { useCallback, useRef, useState } from "react";
import { useWallet, type WriteCall } from "./wallet";
import { RpcError, txStatus } from "./near-rpc";
import { classifyTx, type Outcome } from "./tx-outcome";
import { describeFailure, isUserRejection } from "./errors";
import { GUARD_CONTRACT_ID } from "./guard";
import { refreshAllViews } from "./use-guard";

export type TxPhase = "idle" | "awaiting_signature" | "submitted" | "pending" | "confirmed" | "rejected" | "failed";

export type TxState = {
  phase: TxPhase;
  method?: string;
  hash?: string;
  signerId?: string;
  message?: string;      // human explanation for rejected / failed / unverifiable
  outcome?: Outcome;     // the RPC-verified result (confirmed or failed on chain)
};

const VERIFY_DEADLINE_MS = 120_000;

// One transaction at a time per hook instance. `busy` covers the whole life of a tx
// (signature through final RPC verification), so a second click can't send twice.
export function useTx() {
  const { signAndSend } = useWallet();
  const [state, setState] = useState<TxState>({ phase: "idle" });
  const lock = useRef(false);

  const run = useCallback(async (call: WriteCall): Promise<TxState> => {
    if (lock.current) return state;
    lock.current = true;
    let s: TxState = { phase: "awaiting_signature", method: call.method };
    const set = (next: TxState) => { s = next; setState(next); };
    set(s);
    try {
      let sent: { hash: string | null; signerId: string };
      try {
        sent = await signAndSend(call);
      } catch (e) {
        if (isUserRejection(e)) { set({ ...s, phase: "rejected", message: "You rejected the request in your wallet. Nothing was sent." }); return s; }
        set({ ...s, phase: "failed", message: describeFailure(e) }); return s;
      }
      if (!sent.hash) {
        set({ ...s, phase: "failed", signerId: sent.signerId, message: "The wallet returned no transaction hash, so the result can't be verified here. Check your wallet's activity before retrying." });
        return s;
      }
      set({ ...s, phase: "submitted", hash: sent.hash, signerId: sent.signerId });
      set({ ...s, phase: "pending" });

      // Never trust the wallet's own result: read the final outcome from RPC.
      const deadline = Date.now() + VERIFY_DEADLINE_MS;
      let lastErr = "";
      while (Date.now() < deadline) {
        try {
          const tx = await txStatus(sent.hash, sent.signerId, "FINAL");
          const outcome = classifyTx(tx, GUARD_CONTRACT_ID);
          if (outcome.status === "confirmed") { set({ ...s, phase: "confirmed", outcome }); refreshAllViews(); return s; }
          if (outcome.status === "failed") { set({ ...s, phase: "failed", outcome, message: outcome.failure?.message }); refreshAllViews(); return s; }
        } catch (e) {
          lastErr = e instanceof RpcError ? e.message : String(e);
        }
        await new Promise((r) => setTimeout(r, 3_000));
      }
      set({ ...s, phase: "pending", message: `Submitted, but the final outcome isn't confirmed yet (${lastErr || "still executing"}). Check the explorer link; don't resend.` });
      return s;
    } finally {
      lock.current = false;
    }
  }, [signAndSend, state]);

  const reset = useCallback(() => { if (!lock.current) setState({ phase: "idle" }); }, []);
  const busy = state.phase === "awaiting_signature" || state.phase === "submitted" || (state.phase === "pending" && !state.message);
  return { state, run, reset, busy };
}
