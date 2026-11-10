"use client";
import { useCallback, useEffect, useSyncExternalStore } from "react";
import { useWallet, type WriteCall } from "./wallet";
import { NETWORK, txStatus } from "./near-rpc";
import { isUserRejection } from "./errors";
import { GUARD_CONTRACT_ID } from "./guard";
import { refreshAllViews } from "./use-guard";
import { createTxController, IDLE, isUnresolved } from "./tx-controller";
export type { TxPhase, TxState } from "./tx-controller";

const STORAGE_KEY = `payguard.submission.v1/${NETWORK}/${GUARD_CONTRACT_ID}`;
const controller = createTxController({
  lookup: (hash, signer) => txStatus(hash, signer, "FINAL"),
  rejected: isUserRejection,
  refresh: refreshAllViews,
  storage: {
    read: () => sessionStorage.getItem(STORAGE_KEY),
    write: value => sessionStorage.setItem(STORAGE_KEY, value),
    clear: () => sessionStorage.removeItem(STORAGE_KEY),
  },
});

export function useTx() {
  const { signAndSend, accountId } = useWallet();
  const state = useSyncExternalStore(controller.subscribe, controller.getSnapshot, () => IDLE);
  useEffect(() => controller.restore(), []);
  const run = useCallback((call: WriteCall) => {
    if (!accountId) return Promise.resolve(controller.getSnapshot());
    return controller.run(call, accountId, GUARD_CONTRACT_ID, c => signAndSend(c as WriteCall));
  }, [signAndSend, accountId]);
  return { state, run, reset: controller.reset, retry: controller.retry, busy: isUnresolved(state) };
}
