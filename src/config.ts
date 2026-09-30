import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DEFAULT_CALL_TIMEOUT_MS, JOB_MAX_SEQUENTIAL_CALLS, JOB_OVERHEAD_MS } from "./intelligence/types.js";
import type { JobLimits } from "./research/jobs.js";

export type Config = {
  port: number;
  host: string;
  dataDir: string;
  demoDir: string;
  apiKey?: string;
  demoEnabled: boolean;
  logLevel: string;
  now: () => Date;
  jobs: JobLimits;
  /** Path of the Antigravity CLI (`agy`; server config only, never request-controlled). */
  agyPath: string;
  /** Secret values that must be scrubbed from any response/log text. */
  secrets: () => string[];
  /** Booleans only: which optional integrations are configured. */
  capabilities: Record<string, boolean>;
  /** earnings-gap-auto/v1 automatic path (see strategy/auto.ts): a portfolio assumption, so it is never invented
   * client-side -- undefined (not set) means the funding-gap check uses 0 (no buffer), explicitly labelled as such. */
  strategyMinimumCashBufferKRW?: number;
};

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
/** The installer puts `agy` in ~/.local/bin, which is often not on the PATH of a server process. */
export const defaultAgyPath = (home = process.env.HOME): string => {
  const p = home ? path.join(home, ".local/bin/agy") : "";
  return p && existsSync(p) ? p : "agy";
};

const int = (env: NodeJS.ProcessEnv, key: string, dflt: number, min: number, max: number): number => {
  const raw = env[key];
  if (raw === undefined || raw === "") return dflt;
  const n = Number(raw);
  if (!Number.isInteger(n) || n < min || n > max) throw new Error(`${key} must be an integer in ${min}..${max}`);
  return n;
};

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const host = env.HOST || "127.0.0.1";
  const apiKey = env.API_KEY || undefined;
  const loopback = ["127.0.0.1", "::1", "localhost"].includes(host);
  if (!loopback && !apiKey) throw new Error(`Refusing to listen on ${host} without API_KEY (mutations and paid/quota-consuming jobs would be unauthenticated)`);
  const secretKeys = ["API_KEY", "DART_API_KEY", "NAVER_CLIENT_ID", "NAVER_CLIENT_SECRET"];
  const cashBufferRaw = env.STRATEGY_MIN_CASH_BUFFER_KRW;
  const strategyMinimumCashBufferKRW = cashBufferRaw !== undefined && cashBufferRaw !== "" ? Number(cashBufferRaw) : undefined;
  if (strategyMinimumCashBufferKRW !== undefined && !(Number.isFinite(strategyMinimumCashBufferKRW) && strategyMinimumCashBufferKRW >= 0))
    throw new Error("STRATEGY_MIN_CASH_BUFFER_KRW must be a non-negative number");

  // The outer job deadline (RESEARCH_JOB_TIMEOUT_MS, enforced by JobManager) is kept coherent with the per-call CLI
  // timeout (INTELLIGENCE_TIMEOUT_MS, enforced by the intelligence module): a full sequential analysis is up to
  // JOB_MAX_SEQUENTIAL_CALLS provider calls (claude-draft, an agy-draft fallback on a claude TIMEOUT, and one audit
  // call) plus JOB_OVERHEAD_MS of non-LLM headroom. When RESEARCH_JOB_TIMEOUT_MS is left unset, its default is
  // DERIVED from the per-call timeout instead of a fixed constant, so an explicit INTELLIGENCE_TIMEOUT_MS is never
  // silently squeezed by an unrelated old default. An explicit RESEARCH_JOB_TIMEOUT_MS is always honored AS SET
  // (never overridden): a budget that looks too small for a worst-case sequential run is only diagnosed (a startup
  // warning), not rejected -- the operator may have good reason to accept a partial/timed-out result rather than
  // waiting the full worst case.
  const MAX_JOB_TIMEOUT_MS = 7_200_000; // 2h: generous headroom above the (also generous) default budget
  const claudeTimeoutRaw = env.INTELLIGENCE_TIMEOUT_MS;
  const perCallTimeoutMs = claudeTimeoutRaw !== undefined && claudeTimeoutRaw !== "" ? Number(claudeTimeoutRaw) : DEFAULT_CALL_TIMEOUT_MS;
  if (!(Number.isFinite(perCallTimeoutMs) && perCallTimeoutMs > 0)) throw new Error("INTELLIGENCE_TIMEOUT_MS must be a positive number of milliseconds");
  const requiredJobBudgetMs = perCallTimeoutMs * JOB_MAX_SEQUENTIAL_CALLS + JOB_OVERHEAD_MS;
  const jobTimeoutRaw = env.RESEARCH_JOB_TIMEOUT_MS;
  const jobTimeoutExplicit = jobTimeoutRaw !== undefined && jobTimeoutRaw !== "";
  if (jobTimeoutExplicit && Number.isFinite(Number(jobTimeoutRaw)) && Number(jobTimeoutRaw) < requiredJobBudgetMs)
    console.warn(
      `[config] DIAGNOSTIC: RESEARCH_JOB_TIMEOUT_MS=${jobTimeoutRaw} is smaller than the ${requiredJobBudgetMs}ms a worst-case ` +
      `sequential run needs (INTELLIGENCE_TIMEOUT_MS=${perCallTimeoutMs} x ${JOB_MAX_SEQUENTIAL_CALLS} calls + ${JOB_OVERHEAD_MS}ms overhead). ` +
      `RESEARCH_JOB_TIMEOUT_MS is honored as configured; a fallback run may be abandoned as JOB_TIMEOUT before it finishes.`,
    );
  if (!jobTimeoutExplicit && requiredJobBudgetMs > MAX_JOB_TIMEOUT_MS)
    console.warn(
      `[config] DIAGNOSTIC: INTELLIGENCE_TIMEOUT_MS=${perCallTimeoutMs} implies a ${requiredJobBudgetMs}ms job budget for ` +
      `${JOB_MAX_SEQUENTIAL_CALLS} sequential calls, but the derived RESEARCH_JOB_TIMEOUT_MS default is capped at ${MAX_JOB_TIMEOUT_MS}ms. ` +
      `A full sequential fallback run may not fit; set RESEARCH_JOB_TIMEOUT_MS explicitly (max ${MAX_JOB_TIMEOUT_MS}) or lower INTELLIGENCE_TIMEOUT_MS.`,
    );
  const jobTimeoutMs = int(env, "RESEARCH_JOB_TIMEOUT_MS", Math.min(MAX_JOB_TIMEOUT_MS, requiredJobBudgetMs), 1000, MAX_JOB_TIMEOUT_MS);

  return {
    port: int(env, "PORT", 3000, 0, 65535),
    host,
    dataDir: path.resolve(env.DATA_DIR || path.join(root, "data/manual")),
    demoDir: path.join(root, "data/demo"),
    apiKey,
    demoEnabled: env.DEMO_MODE_ENABLED ? env.DEMO_MODE_ENABLED === "true" : env.NODE_ENV !== "production",
    logLevel: env.LOG_LEVEL || "info",
    now: () => new Date(),
    jobs: {
      maxRunning: int(env, "RESEARCH_MAX_RUNNING", 2, 1, 8),
      maxPending: int(env, "RESEARCH_MAX_PENDING", 10, 0, 100),
      maxRetained: int(env, "RESEARCH_MAX_RETAINED", 100, 1, 1000),
      ttlMs: int(env, "RESEARCH_JOB_TTL_MS", 3_600_000, 1000, 86_400_000),
      jobTimeoutMs,
    },
    agyPath: env.INTELLIGENCE_AGY_PATH || defaultAgyPath(env.HOME),
    secrets: () => secretKeys.map((k) => (env[k] ?? "").trim()).filter(Boolean),
    capabilities: {
      dartConfigured: !!(env.DART_API_KEY ?? "").trim(),
      naverSearchConfigured: !!((env.NAVER_CLIENT_ID ?? "").trim() && (env.NAVER_CLIENT_SECRET ?? "").trim()),
    },
    strategyMinimumCashBufferKRW,
  };
}
