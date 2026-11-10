// Payguard view-call client.
// Shapes mirror contract/guard.ts @view methods 1:1 (ScapeXYZ/Payguard main).
// Defaults to the live testnet guard.myvirusmy.testnet. NEXT_PUBLIC_GUARD_CONTRACT=mock
// gives clearly labelled mock data (never mixed with live reads). Every live view is a
// real NEAR RPC call_function query. Write calls are signed in lib/wallet.tsx.
import { NETWORK, view } from "./near-rpc";

export type Config = { owner_id: string; agent_id: string; guardian_id: string; exit_id: string };
export type TokenPolicy = { max_per_payment: string; daily_limit: string; recipients: string[] };
export type PendingPolicy = { proposal_id: string; token_id: string; policy: TokenPolicy; activate_after: string };
export type PendingIdentity = { proposal_id: string; account_id: string; activate_after: string; owner_proposed?: boolean; cold_key_proposed?: boolean };
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

// ---------- mock client (same shapes, opt-in only, always badged "mock data") ----------
const H = 3_600_000_000_000n;
const t0 = nowNs();
const mock = {
  config: { owner_id: "owner.mock.testnet", agent_id: "agent.mock.testnet", guardian_id: "guardian.mock.testnet", exit_id: "exit.mock.testnet" },
  policies: { "usdc.fakes.testnet": { max_per_payment: "5000000", daily_limit: "20000000", recipients: ["merchant.mock.testnet"] } } as Record<string, TokenPolicy>,
  pendingPolicy: { proposal_id: "4", token_id: "usdc.fakes.testnet",
    policy: { max_per_payment: "5000000", daily_limit: "30000000", recipients: ["merchant.mock.testnet", "gpu.mock.testnet"] },
    activate_after: (t0 + 17n * H).toString() } as PendingPolicy | null,
};
const mockClient: GuardClient = {
  mode: "mock", contractId: "guard.mock.testnet",
  get_config: async () => mock.config,
  get_policy: async (t) => mock.policies[t.toLowerCase()] ?? null,
  get_spending: async (t, day) => ({ token_id: t.toLowerCase(), day: day ?? (nowNs() / DAY_NS).toString(), spent: "0" }),
  get_pending_policy: async () => mock.pendingPolicy,
  get_pending_guardian_change: async () => null,
  get_pending_owner_recovery: async () => null,
  get_recovery_cooldown: async () => "0",
};

// Live testnet guard. NEXT_PUBLIC_GUARD_CONTRACT overrides it; "mock" forces mock data.
export const GUARD_CONTRACT_ID = process.env.NEXT_PUBLIC_GUARD_CONTRACT ?? "guard.myvirusmy.testnet";
export const guard: GuardClient = GUARD_CONTRACT_ID && GUARD_CONTRACT_ID !== "mock" ? rpcClient(GUARD_CONTRACT_ID) : mockClient;
export const IS_MOCK = guard.mode === "mock";

// Circle native USDC on NEAR testnet (the live guard's policy token).
export const CIRCLE_USDC_TESTNET = "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af";
// Tokens the UI offers (the contract has no token list view). Symbol and decimals are
// NOT taken from here: they are read from each token's own ft_metadata (lib/use-token.ts).
export const TOKENS = (process.env.NEXT_PUBLIC_GUARD_TOKENS ?? (IS_MOCK ? "usdc.fakes.testnet" : CIRCLE_USDC_TESTNET)).split(",").map((s) => s.trim()).filter(Boolean);
// Known-good metadata, used only to flag a mismatch with what the chain returns.
export const EXPECTED_META: Record<string, { symbol: string; decimals: number }> = {
  "usdc.fakes.testnet": { symbol: "USDC", decimals: 6 },
  [CIRCLE_USDC_TESTNET]: { symbol: "USDC", decimals: 6 },
};

// ---------- roles ----------
export type Role = "owner" | "guardian" | "agent" | "exit";
export function rolesOf(account: string | null | undefined, config: Config | undefined): Role[] {
  if (!account || !config) return [];
  const a = account.toLowerCase();
  const r: Role[] = [];
  if (a === config.owner_id) r.push("owner");
  if (a === config.guardian_id) r.push("guardian");
  if (a === config.agent_id) r.push("agent");
  if (a === config.exit_id) r.push("exit");
  return r;
}

// near-sdk-js requireInit: views on an uninitialised contract fail with this panic.
export const isUninitialised = (err?: string) => !!err && /must be initialized|not initialized|requireInit|Contract must be init/i.test(err);
export const isMissingContract = (err?: string) => !!err && /CodeDoesNotExist|does not exist|UNKNOWN_ACCOUNT|AccountDoesNotExist/i.test(err);
