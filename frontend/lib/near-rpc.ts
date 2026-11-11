// Minimal NEAR JSON-RPC client: view calls, tx status, token metadata.
// Read-only. Signing never happens here (see lib/wallet.tsx).

export const NETWORK = (process.env.NEXT_PUBLIC_NEAR_NETWORK ?? "testnet") as "testnet" | "mainnet";
export const RPC_URL = process.env.NEXT_PUBLIC_NEAR_RPC ?? (NETWORK === "mainnet" ? "https://rpc.mainnet.fastnear.com" : "https://test.rpc.fastnear.com");
// Historical evidence lookups default to the archival node; deployments may override it.
export const ARCHIVAL_RPC_URL = process.env.NEXT_PUBLIC_NEAR_ARCHIVAL_RPC ?? "https://archival-rpc.testnet.fastnear.com";
export const EXPLORER = NETWORK === "mainnet" ? "https://nearblocks.io" : "https://testnet.nearblocks.io";

export const txUrl = (hash: string) => `${EXPLORER}/txns/${hash}`;
export const accountUrl = (id: string) => `${EXPLORER}/address/${id}`;

export class RpcError extends Error {
  constructor(message: string, readonly kind: "network" | "rpc" | "contract", readonly data?: unknown) { super(message); }
}

function b64(s: string) {
  return typeof window === "undefined" ? Buffer.from(s).toString("base64") : btoa(s);
}

export async function rpc<T>(method: string, params: unknown, url = RPC_URL, timeoutMs = 15_000): Promise<T> {
  const ctl = new AbortController();
  const t = setTimeout(() => ctl.abort(), timeoutMs);
  const timedOut = () => new RpcError(`RPC timed out after ${timeoutMs / 1000}s (${url})`, "network");
  // The timer stays armed until the body is parsed: a stalled body is a timeout too.
  let json: { result?: unknown; error?: { data?: string; message?: string } };
  try {
    let res: Response;
    try {
      res = await fetch(url, {
        method: "POST", signal: ctl.signal, headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ jsonrpc: "2.0", id: "payguard-ui", method, params }),
      });
    } catch (e) {
      throw ctl.signal.aborted ? timedOut() : new RpcError(`RPC unreachable (${url})`, "network", e);
    }
    if (!res.ok) throw new RpcError(`RPC returned HTTP ${res.status} (${url})`, "network");
    const aborted = new Promise<never>((_, rej) => {
      if (ctl.signal.aborted) rej(timedOut());
      ctl.signal.addEventListener("abort", () => rej(timedOut()), { once: true });
    });
    json = await Promise.race([res.json().catch(() => { throw ctl.signal.aborted ? timedOut() : new RpcError("RPC returned invalid JSON", "network"); }), aborted]);
  } finally { clearTimeout(t); }
  if (json.error) throw new RpcError(json.error.data ?? json.error.message ?? "RPC error", "rpc", json.error);
  return json.result as T;
}

export async function view<T>(contractId: string, method: string, args: object = {}): Promise<T> {
  const r = await rpc<{ result?: number[]; error?: string }>("query", {
    request_type: "call_function", finality: "final", account_id: contractId, method_name: method,
    args_base64: b64(JSON.stringify(args)),
  });
  if (r.error) throw new RpcError(r.error, "contract");
  return JSON.parse(new TextDecoder().decode(new Uint8Array(r.result ?? []))) as T;
}

// NEP-148 metadata read from the token contract itself.
export type FtMetadata = { spec: string; name: string; symbol: string; decimals: number; icon?: string | null };
export async function ftMetadata(tokenId: string): Promise<FtMetadata> {
  const m = await view<FtMetadata>(tokenId, "ft_metadata");
  if (typeof m?.decimals !== "number" || !Number.isInteger(m.decimals) || m.decimals < 0 || m.decimals > 38 || typeof m.symbol !== "string")
    throw new RpcError(`token ${tokenId} returned malformed ft_metadata`, "contract");
  return m;
}

export async function ftBalance(tokenId: string, accountId: string): Promise<string> {
  return view<string>(tokenId, "ft_balance_of", { account_id: accountId });
}

// Final status of a transaction, including every receipt outcome.
// Tries the regular node, then the archival node if one is configured.
export async function txStatus(hash: string, signerId: string, waitUntil: "FINAL" | "EXECUTED" = "FINAL"): Promise<TxStatus> {
  const params = { tx_hash: hash, sender_account_id: signerId, wait_until: waitUntil };
  try {
    return await rpc<TxStatus>("EXPERIMENTAL_tx_status", params, RPC_URL, 30_000);
  } catch (e) {
    if (ARCHIVAL_RPC_URL && e instanceof RpcError && e.kind === "rpc") return rpc<TxStatus>("EXPERIMENTAL_tx_status", params, ARCHIVAL_RPC_URL, 30_000);
    throw e;
  }
}

export type ExecStatus =
  | { SuccessValue: string }
  | { SuccessReceiptId: string }
  | { Failure: unknown }
  | "Unknown" | { Unknown?: unknown };

export type ReceiptOutcome = {
  id: string;
  block_hash: string;
  outcome: { executor_id: string; logs: string[]; status: ExecStatus; receipt_ids: string[]; gas_burnt: number };
};

export type TxStatus = {
  final_execution_status?: string;
  status: ExecStatus;
  transaction: { hash: string; signer_id: string; receiver_id: string; actions: unknown[] };
  transaction_outcome: ReceiptOutcome;
  receipts_outcome: ReceiptOutcome[];
  // EXPERIMENTAL_tx_status only: the receipts themselves (who sent what to whom).
  receipts?: TxReceipt[];
};

export type TxReceipt = {
  receipt_id: string;
  predecessor_id: string;
  receiver_id: string;
  receipt: { Action?: { actions: ({ FunctionCall?: { method_name: string; args: string; deposit: string } } | string | Record<string, unknown>)[] } } | Record<string, unknown>;
};

export async function blockTimestampNs(blockHash: string): Promise<string> {
  const b = await rpc<{ header: { timestamp_nanosec: string } }>("block", { block_id: blockHash });
  return b.header.timestamp_nanosec;
}
