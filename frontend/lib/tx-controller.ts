import type { TxStatus } from "./near-rpc";
import type { Outcome } from "./tx-outcome";
import { classifySubmittedTx, type SubmittedCall } from "./tx-binding";

export type TxPhase = "idle" | "awaiting_signature" | "submitted" | "pending" | "confirmed" | "rejected" | "failed";
export type TxState = {
  phase: TxPhase; method?: string; hash?: string; signerId?: string;
  message?: string; outcome?: Outcome;
};
type Call = { method: string; args: object };
type Saved = { state: TxState; expected?: SubmittedCall };
type Options = {
  lookup: (hash: string, signer: string) => Promise<TxStatus>;
  rejected: (error: unknown) => boolean;
  refresh: () => void;
  storage: { read: () => string | null; write: (value: string) => void; clear: () => void };
  now?: () => number; sleep?: () => Promise<void>; deadlineMs?: number;
};
export const IDLE: TxState = { phase: "idle" };
export const isUnresolved = (s: TxState) => ["awaiting_signature", "submitted", "pending"].includes(s.phase);

// Shared across all buttons and navigation. Only a bound terminal RPC result or
// explicit wallet rejection permits another submission. Reloads retain the lock.
export function createTxController(options: Options) {
  let state = IDLE, expected: SubmittedCall | undefined, active = false, restored = false;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach(fn => fn());
  const save = (next: TxState) => {
    if (isUnresolved(next)) options.storage.write(JSON.stringify({ state: next, expected }));
    else options.storage.clear();
  };
  const set = (next: TxState) => { save(next); state = next; emit(); };
  const restore = () => {
    if (restored) return;
    restored = true;
    try {
      const raw = options.storage.read();
      if (!raw) return;
      const saved: Saved = JSON.parse(raw);
      if (!saved?.state || !isUnresolved(saved.state)) throw new Error("Invalid saved submission");
      expected = saved.expected;
      state = { ...saved.state, phase: "pending", message: "An unresolved submission is saved. Verify its outcome before submitting again." };
    } catch {
      state = { phase: "pending", message: "Submission storage is unavailable or invalid. New submissions are blocked." };
    }
    emit();
  };
  const now = options.now ?? Date.now;
  const sleep = options.sleep ?? (() => new Promise(resolve => setTimeout(resolve, 3_000)));
  const verify = async () => {
    if (!expected) return state;
    const deadline = now() + (options.deadlineMs ?? 120_000);
    let last = "still executing";
    while (now() < deadline) {
      try {
        const { outcome, why } = classifySubmittedTx(await options.lookup(expected.hash, expected.signerId), expected);
        if (outcome.status !== "pending") {
          set({ ...state, phase: outcome.status, outcome, message: outcome.failure?.message });
          options.refresh();
          return state;
        }
        last = why ?? "still executing";
      } catch { last = "RPC verification unavailable"; }
      await sleep();
    }
    set({ ...state, phase: "pending", message: `Outcome remains unresolved (${last}). Retry verification; do not resend.` });
    return state;
  };
  return {
    restore,
    getSnapshot: () => state,
    subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener); }; },
    async run(call: Call, signerId: string, receiverId: string, sign: (call: Call) => Promise<{ hash: string | null; signerId: string }>) {
      restore();
      if (active || isUnresolved(state)) return state;
      active = true;
      expected = undefined;
      try {
        // Snapshot before the first await, keeping expected args separate from wallet mutations.
        const snapshot: Call = JSON.parse(JSON.stringify(call));
        set({ phase: "awaiting_signature", method: snapshot.method, signerId });
        let sent;
        try { sent = await sign(JSON.parse(JSON.stringify(snapshot))); }
        catch (error) {
          if (options.rejected(error)) set({ ...state, phase: "rejected", message: "You rejected the request in your wallet. Nothing was sent." });
          else set({ ...state, phase: "pending", message: "The wallet outcome is unknown. Check wallet activity; new submissions remain blocked." });
          return state;
        }
        if (!sent.hash || sent.signerId !== signerId) {
          set({ ...state, phase: "pending", message: "The wallet returned no usable transaction identity. Check wallet activity; new submissions remain blocked." });
          return state;
        }
        expected = { ...snapshot, hash: sent.hash, signerId, receiverId, deposit: "0" };
        set({ ...state, phase: "submitted", hash: sent.hash });
        set({ ...state, phase: "pending" });
        return await verify();
      } catch {
        state = { ...state, phase: "pending", message: "Submission tracking failed. New submissions remain blocked." };
        emit();
        return state;
      } finally { active = false; }
    },
    async retry() {
      restore();
      if (active || !isUnresolved(state) || !expected) return state;
      active = true;
      try { return await verify(); }
      catch { return state; }
      finally { active = false; }
    },
    reset() { if (!active && !isUnresolved(state)) { expected = undefined; set(IDLE); } },
  };
}
