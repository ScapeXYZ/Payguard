// Payguard view-call client.
// Shapes mirror contract/guard.ts @view methods 1:1 (ScapeXYZ/Payguard main).
// Mock mode until NEXT_PUBLIC_GUARD_CONTRACT is set; then every view is a real
// NEAR RPC `call_function` query. Write calls (set_policy, pay, cancel_*,
// propose_*, activate_*, emergency_sweep) are NOT here: they are wired by the
// contract author through NEAR Wallet Selector (see lib/wallet.ts).

export type Config = { owner_id: string; agent_id: string; guardian_id: string; exit_id: string };
export type TokenPolicy = { max_per_payment: string; daily_limit: string; recipients: string[] };
export type PendingPolicy = { proposal_id: string; token_id: string; policy: TokenPolicy; activate_after: string };
export type PendingIdentity = { proposal_id: string; account_id: string; activate_after: string; owner_proposed?: boolean };
export type Spending = { token_id: string; day: string; spent: string };

export interface GuardClient {
  mode: "mock" | "testnet" | "mainnet";
  contractId: string;
  get_config(): Promise<Config>;
  get_policy(token_id: string): Promise<TokenPolicy | null>;
  get_spending(token_id: string, day?: string): Promise<Spending>;
  get_pending_policy(): Promise<PendingPolicy | null>;
  get_pending_guardian_change(): Promise<PendingIdentity | null>;
  get_pending_owner_recovery(): Promise<PendingIdentity | null>;
  get_recovery_cooldown(): Promise<string>; // ns timestamp, "0" when none
}

export const DAY_NS = 86_400_000_000_000n;
export const nowNs = () => BigInt(Date.now()) * 1_000_000n;

// ---------- real RPC client ----------
const NETWORK = (process.env.NEXT_PUBLIC_NEAR_NETWORK ?? "testnet") as "testnet" | "mainnet";
const RPC = process.env.NEXT_PUBLIC_NEAR_RPC ?? (NETWORK === "mainnet" ? "https://rpc.mainnet.near.org" : "https://rpc.testnet.near.org");

function b64(s: string) {
  return typeof window === "undefined" ? Buffer.from(s).toString("base64") : btoa(s);
}

async function view<T>(contractId: string, method: string, args: object = {}): Promise<T> {
  const res = await fetch(RPC, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      jsonrpc: "2.0", id: "payguard-ui", method: "query",
      params: { request_type: "call_function", finality: "final", account_id: contractId, method_name: method, args_base64: b64(JSON.stringify(args)) },
    }),
  });
  const json = await res.json();
  if (json.error || json.result?.error) throw new Error(json.error?.message ?? json.result.error);
  const bytes: number[] = json.result.result;
  return JSON.parse(new TextDecoder().decode(new Uint8Array(bytes))) as T;
}

function rpcClient(contractId: string): GuardClient {
  return {
    mode: NETWORK, contractId,
    get_config: () => view(contractId, "get_config"),
    get_policy: (token_id) => view(contractId, "get_policy", { token_id }),
    get_spending: (token_id, day) => view(contractId, "get_spending", day ? { token_id, day } : { token_id }),
    get_pending_policy: () => view(contractId, "get_pending_policy"),
    get_pending_guardian_change: () => view(contractId, "get_pending_guardian_change"),
    get_pending_owner_recovery: () => view(contractId, "get_pending_owner_recovery"),
    get_recovery_cooldown: () => view(contractId, "get_recovery_cooldown"),
  };
}

// ---------- mock client (same shapes) ----------
const H = 3_600_000_000_000n;
const t0 = nowNs();
const mock = {
  config: { owner_id: "temi.testnet", agent_id: "agent.temi.testnet", guardian_id: "guardian.temi.testnet", exit_id: "cold-vault.testnet" },
  policies: {
    "usdc.fakes.testnet": { max_per_payment: "50000000", daily_limit: "120000000", recipients: ["openai-credits.testnet", "vercel-billing.testnet", "akash-gpu.testnet"] },
  } as Record<string, TokenPolicy>,
  spent: { "usdc.fakes.testnet": "80000000" } as Record<string, string>,
  pendingPolicy: {
    proposal_id: "4", token_id: "usdc.fakes.testnet",
    policy: { max_per_payment: "50000000", daily_limit: "200000000", recipients: ["openai-credits.testnet", "vercel-billing.testnet", "akash-gpu.testnet", "replicate.testnet"] },
    activate_after: (t0 + 17n * H).toString(),
  } as PendingPolicy | null,
  pendingGuardian: { proposal_id: "7", account_id: "new-guardian.testnet", activate_after: (t0 + 9n * H).toString(), owner_proposed: true } as PendingIdentity | null,
  pendingRecovery: null as PendingIdentity | null,
};

const mockClient: GuardClient = {
  mode: "mock", contractId: "payguard.temi.testnet (mock)",
  get_config: async () => mock.config,
  get_policy: async (t) => mock.policies[t.toLowerCase()] ?? null,
  get_spending: async (t, day) => ({ token_id: t.toLowerCase(), day: day ?? (nowNs() / DAY_NS).toString(), spent: mock.spent[t.toLowerCase()] ?? "0" }),
  get_pending_policy: async () => mock.pendingPolicy,
  get_pending_guardian_change: async () => mock.pendingGuardian,
  get_pending_owner_recovery: async () => mock.pendingRecovery,
  get_recovery_cooldown: async () => "0",
};

const CONTRACT = process.env.NEXT_PUBLIC_GUARD_CONTRACT;
export const guard: GuardClient = CONTRACT ? rpcClient(CONTRACT) : mockClient;

// Tokens the UI tracks (the contract has no token list view).
export const TOKENS = (process.env.NEXT_PUBLIC_GUARD_TOKENS ?? "usdc.fakes.testnet").split(",").map((s) => s.trim());
export const TOKEN_META: Record<string, { symbol: string; decimals: number }> = {
  "usdc.fakes.testnet": { symbol: "USDC", decimals: 6 },
};

// Simulated activity for the payments screen. The contract emits no payment
// history view; real history comes from an indexer (NearBlocks) later.
export const MOCK_PAYMENTS = [
  { request_id: "req-1043", recipient_id: "openai-credits.testnet", amount: "40000000", at: Date.now() - 42 * 60_000, status: "paid" },
  { request_id: "req-1042", recipient_id: "akash-gpu.testnet", amount: "40000000", at: Date.now() - 3 * 3_600_000, status: "paid" },
  { request_id: "req-1041", recipient_id: "unknown-wallet.testnet", amount: "10000000", at: Date.now() - 4 * 3_600_000, status: "blocked: recipient_not_allowed" },
  { request_id: "req-1040", recipient_id: "vercel-billing.testnet", amount: "75000000", at: Date.now() - 6 * 3_600_000, status: "blocked: max_per_payment" },
];
