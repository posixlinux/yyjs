import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import { isValidDate } from "../domain/time.js";
import { AppError, type Issue } from "../errors.js";
import { Availability, isExpiredCode } from "./availability.js";
import { abortedStatus, AGY_DEFAULT_MODEL, callProvider, skipped, validateClaudeEffort, type ProviderConfig, type ProviderOutcome } from "./providers.js";
import { auditPrompt, draftPrompt, strategyPrompt } from "./prompts.js";
import { buildEnv, sanitize, Semaphore, spawnRunner } from "./runner.js";
import {
  AuditSchema,
  DEFAULT_CALL_TIMEOUT_MS,
  EvidenceInputSchema,
  JOB_MAX_SEQUENTIAL_CALLS,
  JOB_OVERHEAD_MS,
  LIMITS,
  ProposalSchema,
  StrategyProposalSchema,
  type AnalysisResult,
  type EvidenceInput,
  type IntelligenceOptions,
  type ProviderName,
  type ProviderUnavailable,
  type Readiness,
  type Runner,
} from "./types.js";
import { listEstimates } from "../domain/market-structure.js";
import { verifyProposal } from "./verify.js";
import { verifyStrategyDraft } from "./strategyVerify.js";

export * from "./types.js";
export { claudeArgs, agyArgs, AGY_DEFAULT_MODEL, MAX_ARGV_PROMPT_BYTES } from "./providers.js";
export { Availability, isExpiredCode, parseResetMs } from "./availability.js";
export { verifyProposal, observedNumericPaths, MODEL_ASSUMPTION_PREFIX } from "./verify.js";
export { verifyStrategyDraft } from "./strategyVerify.js";

const CACHE_MAX = 50;

const LIMITATIONS = [
  "Exact matching proves a quote exists in a supplied document and a number is derivable from it; it cannot prove the number means what the model claims. Semantic truth rests on the independent audit by the second model and on human review.",
  "Compound Korean amounts (e.g. '1조 2,345억') are not parsed; a citation must quote one number with one unit.",
  "Both providers are LLMs reading the same supplied documents; agreement is not proof. Forecast fields are assumptions, not facts.",
  "Claude and agy (Antigravity CLI, Gemini models) use the operator's own logins and quotas. A provider whose login/quota has expired is skipped; with only one provider the dataset is NOT cross-checked (status single_model).",
];

// ---- shared state: bounded CLI concurrency, result cache, in-flight de-duplication ----------------------------

const semaphore = new Semaphore();
/** Which providers are currently expired (quota/login/CLI missing) and must not be called. */
const availability = new Availability();
export const clearProviderAvailability = (provider?: ProviderName) => availability.clear(provider);
const cache = new Map<string, { at: number; result: AnalysisResult }>();
// refs = callers still waiting; the shared run is aborted only when every one of them has aborted.
type Inflight = { promise: Promise<AnalysisResult>; controller: AbortController; refs: number };
const inflight = new Map<string, Inflight>();
const runnerIds = new WeakMap<Runner, number>();
let nextRunnerId = 1;

export const clearIntelligenceCache = () => cache.clear();

/** Server configuration from env (paths are never request-controlled). */
export const intelligenceOptionsFromEnv = (env: NodeJS.ProcessEnv = process.env): IntelligenceOptions => ({
  claudePath: env.INTELLIGENCE_CLAUDE_PATH || undefined,
  agyPath: env.INTELLIGENCE_AGY_PATH || undefined,
  claudeModel: env.INTELLIGENCE_CLAUDE_MODEL || undefined,
  agyModel: env.INTELLIGENCE_AGY_MODEL || undefined,
  claudeEffort: env.INTELLIGENCE_CLAUDE_EFFORT || undefined,
  timeoutMs: env.INTELLIGENCE_TIMEOUT_MS ? Number(env.INTELLIGENCE_TIMEOUT_MS) : undefined,
  maxConcurrent: env.INTELLIGENCE_MAX_CONCURRENT ? Number(env.INTELLIGENCE_MAX_CONCURRENT) : undefined,
  jobTimeoutMs: env.RESEARCH_JOB_TIMEOUT_MS ? Number(env.RESEARCH_JOB_TIMEOUT_MS) : undefined,
});

/** The installer puts `agy` in ~/.local/bin, which a server started from npm/launchd often does not have on PATH. */
const defaultAgyPath = (env: NodeJS.ProcessEnv): string => {
  const home = env.HOME || env.USERPROFILE;
  const p = home ? resolve(home, ".local/bin/agy") : "";
  return p && existsSync(p) ? p : "agy";
};

const resolveOptions = (o: IntelligenceOptions) => {
  const perCall = Number.isFinite(o.timeoutMs) && o.timeoutMs! > 0 ? o.timeoutMs! : DEFAULT_CALL_TIMEOUT_MS;

  // jobTimeoutMs is the actual effective whole-job deadline (see src/config.ts: explicit RESEARCH_JOB_TIMEOUT_MS, or
  // a default derived from the SAME per-call default so an unset job timeout never fights an unset per-call timeout).
  // A full sequential run is up to JOB_MAX_SEQUENTIAL_CALLS calls (claude-draft, then on a claude draft TIMEOUT an
  // agy-draft fallback, then one audit call) plus JOB_OVERHEAD_MS of non-LLM headroom (collection, queue, cleanup).
  // The configured per-call timeout is NEVER silently shortened here: a caller-set INTELLIGENCE_TIMEOUT_MS is
  // honored as-is. A budget that does not fit is only diagnosed (logged); the actual hard stop, if any, is the
  // job's own AbortController (see research/jobs.ts JOB_TIMEOUT), which is a separate, explicit mechanism.
  if (Number.isFinite(o.jobTimeoutMs)) {
    const jobBudget = o.jobTimeoutMs!;
    const neededMs = perCall * JOB_MAX_SEQUENTIAL_CALLS + JOB_OVERHEAD_MS;
    if (neededMs > jobBudget)
      console.warn(
        `[intel] DIAGNOSTIC: per-call timeout ${perCall}ms x ${JOB_MAX_SEQUENTIAL_CALLS} sequential calls + ` +
        `${JOB_OVERHEAD_MS}ms overhead = ${neededMs}ms, which exceeds the effective job timeout ${jobBudget}ms. ` +
        `A worst-case fallback run may be aborted (JOB_TIMEOUT) before it finishes. The per-call timeout is NOT ` +
        `being shortened to compensate; increase RESEARCH_JOB_TIMEOUT_MS or decrease INTELLIGENCE_TIMEOUT_MS to avoid this.`,
      );
  }

  const timeoutMs = perCall;
  const env = o.env ?? process.env;
  const claude: ProviderConfig = {
    command: o.claudePath || "claude",
    model: o.claudeModel,
    effort: validateClaudeEffort(o.claudeEffort),
    timeoutMs,
    runner: o.runner ?? spawnRunner,
    env,
    signal: o.signal,
  };
  const agy: ProviderConfig = {
    ...claude,
    command: o.agyPath || defaultAgyPath(env),
    model: o.agyModel || AGY_DEFAULT_MODEL,
    effort: undefined, // agy does not support --effort
  };
  return { claude, agy, maxConcurrent: Number.isFinite(o.maxConcurrent) && o.maxConcurrent! >= 1 ? Math.floor(o.maxConcurrent!) : 2 };
};

const invalid = (message: string, details?: unknown) => new AppError(400, "INTELLIGENCE_INPUT_INVALID", message, details);

function prepare(raw: unknown): { input: EvidenceInput; excluded: string[] } {
  const parsed = EvidenceInputSchema.safeParse(raw);
  if (!parsed.success)
    throw invalid("Evidence input failed validation", parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })));
  const { ticker, asOf, documents } = parsed.data;
  if (!isValidDate(asOf)) throw invalid("asOf must be a real YYYY-MM-DD date");
  const ids = new Set<string>();
  for (const d of documents) {
    if (!isValidDate(d.publishedAt)) throw invalid(`document ${d.id}: publishedAt must be a real YYYY-MM-DD date`);
    if (ids.has(d.id)) throw invalid(`duplicate document id ${d.id}`);
    ids.add(d.id);
  }
  if (documents.reduce((n, d) => n + d.text.length, 0) > LIMITS.maxTotalChars)
    throw new AppError(413, "INTELLIGENCE_INPUT_TOO_LARGE", `Total document text exceeds ${LIMITS.maxTotalChars} characters`);
  // Future documents never reach the models: they cannot legitimately support an as-of analysis.
  const eligible = documents.filter((d) => d.publishedAt <= asOf);
  return { input: { ticker, asOf, documents: eligible }, excluded: documents.filter((d) => d.publishedAt > asOf).map((d) => d.id) };
}

type Role = { provider: ProviderName; cfg: ProviderConfig };

async function run(input: EvidenceInput, excluded: string[], o: IntelligenceOptions, signal: AbortSignal): Promise<AnalysisResult> {
  const cfg = resolveOptions({ ...o, signal });
  const clock = () => (o.now?.() ?? new Date()).getTime();
  const limited = async <T>(provider: ProviderName, fn: () => Promise<ProviderOutcome<T>>): Promise<ProviderOutcome<T>> => {
    try {
      return await semaphore.run(cfg.maxConcurrent, fn, signal);
    } catch (e) {
      if (signal.aborted) return { status: abortedStatus(provider) }; // cancelled while queued: no child was started
      throw e;
    }
  };
  const generatedAt = new Date(clock()).toISOString();
  const issues: Issue[] = [];
  const unavailable: ProviderUnavailable[] = [];
  const result: AnalysisResult = {
    status: "unavailable",
    dataset: null,
    missingFields: [],
    narrative: null,
    citations: [],
    assumptions: [],
    disagreements: [],
    providers: { claude: skipped("claude", "not run"), agy: skipped("agy", "not run") },
    crossChecked: false,
    estimates: [],
    unavailable,
    strategy: { forecast: null, currentConsensus: null, priorConsensus: null, catalyst: null, unavailable: [{ field: "all", code: "NOT_DRAFTED", message: "no draft was produced, so the separate strategy call was not made" }] },
    audit: { issues, excludedDocuments: excluded, auditSummary: null, auditedBy: null, independentAudit: false, limitations: [...LIMITATIONS] },
    generatedAt,
  };

  if (!input.documents.length) {
    issues.push({ code: "NO_ELIGIBLE_DOCUMENTS", path: "documents", message: "no supplied document is dated on or before asOf" });
    return result;
  }

  // An expired provider is never called: it is recorded (with when to retry) and the analysis goes on without it.
  const expire = (provider: ProviderName, code: string, message: string, cooldownMs: number | undefined, skippedWithoutCall: boolean) => {
    const c = availability.mark(provider, code, message, clock(), cooldownMs);
    unavailable.push({ provider, code, message, retryAfter: new Date(c.until).toISOString(), skippedWithoutCall });
  };
  // A one-off TIMEOUT is NOT an expiry: it starts no cooldown (the provider may work fine on the very next request),
  // but it IS recorded as unavailable for the rest of THIS run so the timed-out provider is never called again as
  // auditor here (see the `unavailable.some(...)` filter below when picking audit candidates).
  const failTransient = (provider: ProviderName, code: string, message: string) => {
    unavailable.push({ provider, code, message, retryAfter: generatedAt, skippedWithoutCall: false });
  };
  const usable = (provider: ProviderName): boolean => {
    const c = availability.active(provider, clock());
    if (!c) return true;
    result.providers[provider] = skipped(provider, `not used: ${c.code} - ${c.message} (retry after ${new Date(c.until).toISOString()})`);
    result.providers[provider].code = c.code;
    unavailable.push({ provider, code: c.code, message: c.message, retryAfter: new Date(c.until).toISOString(), skippedWithoutCall: true });
    return false;
  };

  const roles = ([{ provider: "claude", cfg: cfg.claude }, { provider: "agy", cfg: cfg.agy }] as Role[]).filter((r) => usable(r.provider));
  const other = (p: ProviderName): ProviderName => (p === "claude" ? "agy" : "claude");
  const cfgOf = (p: ProviderName) => (p === "claude" ? cfg.claude : cfg.agy);

  // 1. Draft: Claude first, agy when Claude is expired OR when Claude's draft call TIMEOUT (bounded: at most one
  //    fallback, since `roles` has at most 2 entries). Any other non-expiry failure (bad JSON, schema, ...) is not
  //    retried elsewhere -- only TIMEOUT gets a fallback, to avoid a blind retry loop on a likely-recurring error.
  //    A provider that times out here is recorded unavailable (code TIMEOUT) for the rest of this run: see the
  //    audit-candidate filter below, which then never calls it again as auditor in this run.
  let drafter: ProviderName | null = null;
  let draft: import("./types.js").Proposal | null = null;
  for (const role of roles) {
    const out = await limited(role.provider, () => callProvider(role.provider, role.cfg, draftPrompt(input), ProposalSchema, "draft"));
    result.providers[role.provider] = out.status;
    if (out.value) {
      drafter = role.provider;
      draft = out.value;
      break;
    }
    if (out.status.status === "error" && isExpiredCode(out.status.code)) {
      expire(role.provider, out.status.code, out.status.message, out.cooldownMs, false);
      continue;
    }
    if (out.status.status === "error" && out.status.code === "TIMEOUT") {
      failTransient(role.provider, "TIMEOUT", out.status.message);
      continue;
    }
    issues.push({ code: "PROVIDER_UNAVAILABLE", path: role.provider, message: out.status.message });
    return result;
  }
  if (!drafter || !draft) {
    issues.push({ code: "PROVIDER_UNAVAILABLE", path: "all", message: unavailable.length ? `every provider is unavailable: ${unavailable.map((u) => `${u.provider} ${u.code}`).join(", ")}` : "no provider is available" });
    return result;
  }

  const verified = verifyProposal(input.asOf, input.ticker, input.documents, draft);
  issues.push(...verified.issues);
  result.citations = verified.citations;

  // 1b. Strategy: a SEPARATE call (strategyPrompt / StrategyProposalSchema), started now and run alongside the audit
  //     below, so the earnings-gap-auto/v1 extraction is never an optional afterthought of the long Dataset draft.
  //     It is additive and independent of the Dataset's accept/reject path: a failed strategy call only fills
  //     result.strategy.unavailable (never issues/providers/status), and a strategy field can be usable even when
  //     the product-market dataset is rejected (and vice versa). Tried on the drafter first (known to work in this
  //     run); the other provider is tried only when the drafter expires or times out on this call.
  //     With INTELLIGENCE_MAX_CONCURRENT=1 the semaphore serializes it after the audit (one extra call's time).
  result.narrative = draft.narrative;
  result.assumptions = draft.assumptions;
  result.missingFields = [...draft.missingFields];
  result.audit.limitations.push(...draft.limitations);
  result.status = "partial";

  await Promise.all([auditAndAccept(drafter, draft), extractStrategy(drafter)]);
  return result;

  async function extractStrategy(first: ProviderName): Promise<void> {
    const order = [first, ...roles.map((r) => r.provider).filter((p) => p !== first)];
    const failures: string[] = [];
    for (const provider of order) {
      if (provider !== first && unavailable.some((u) => u.provider === provider)) continue;
      const out = await limited(provider, () => callProvider(provider, cfgOf(provider), strategyPrompt(input), StrategyProposalSchema, "strategy"));
      if (out.value) {
        // Strategy citations are this call's own; strategyVerify.ts re-validates every one via checkCitation.
        result.strategy = verifyStrategyDraft(input.asOf, input.documents, out.value.citations, out.value.strategy);
        // generatedAt is server-owned, never the model's own claim: the model cannot backdate/postdate when its
        // forecast was produced (docs/STRATEGY.md "no backdating new LLM forecasts into old decisions").
        if (result.strategy.forecast) result.strategy.forecast = { ...result.strategy.forecast, generatedAt };
        return;
      }
      failures.push(`${provider} ${out.status.code}: ${out.status.message}`);
      if (out.status.status === "error" && isExpiredCode(out.status.code)) {
        expire(provider, out.status.code, out.status.message, out.cooldownMs, false);
        continue;
      }
      if (out.status.status === "error" && out.status.code === "TIMEOUT") continue;
      break; // bad JSON/schema etc.: not retried elsewhere (same rule as the draft)
    }
    result.strategy = { forecast: null, currentConsensus: null, priorConsensus: null, catalyst: null, unavailable: [{ field: "all", code: "STRATEGY_CALL_FAILED", message: `the separate strategy call failed: ${failures.join("; ") || "no provider is available"}` }] };
  }

  // 2. Audit. Preferred: the OTHER provider (independent). If it is expired, the drafting provider audits its own draft in a
  //    fresh call with an adversarial prompt, so every check still runs (weaker: not independent, status single_model).
  //    Only when no provider can audit at all does the draft rest on the deterministic checks alone.
  async function auditAndAccept(drafter: ProviderName, draft: import("./types.js").Proposal): Promise<void> {
    const otherProvider = other(drafter);
    const candidates: { provider: ProviderName; independent: boolean }[] = [];
    if (roles.some((r) => r.provider === otherProvider) && !unavailable.some((u) => u.provider === otherProvider)) candidates.push({ provider: otherProvider, independent: true });
    candidates.push({ provider: drafter, independent: false });

    let audit: import("./types.js").Audit | null = null;
    let auditor: { provider: ProviderName; independent: boolean } | null = null;
    for (const cand of candidates) {
      const out = await limited(cand.provider, () => callProvider(cand.provider, cfgOf(cand.provider), auditPrompt(input, draft, { selfAudit: !cand.independent }), AuditSchema, "audit"));
      if (cand.independent || out.status.status === "error") result.providers[cand.provider] = out.status; // a successful self-audit keeps the draft's status
      if (out.value) {
        audit = out.value;
        auditor = cand;
        break;
      }
      if (out.status.status === "error" && isExpiredCode(out.status.code)) {
        expire(cand.provider, out.status.code, out.status.message, out.cooldownMs, false);
        continue;
      }
      issues.push({ code: "PROVIDER_UNAVAILABLE", path: cand.provider, message: `${out.status.message} (the audit failed for a reason other than an expired login/quota, so the draft is not accepted)` });
      return;
    }

    const finalDataset = (kind: "accepted" | "single_model") => {
      result.dataset = verified.dataset;
      result.status = kind;
      result.estimates = verified.dataset ? listEstimates(verified.dataset).map((e) => ({ path: e.path, kind: e.kind, quarter: e.quarter, value: e.value, currency: e.currency, method: e.estimate.method, basedOn: e.estimate.basedOn, rationale: e.estimate.rationale })) : [];
    };

    if (!audit || !auditor) {
      // Nobody could audit. Every deterministic check (citations, units, dates, schema, estimate rules) still applies.
      result.audit.limitations.push(`Not audited by a model: ${unavailable.map((u) => `${u.provider} ${u.code}`).join(", ") || "no auditor available"}; the draft by ${drafter} rests on the deterministic citation/number/estimate checks only.`);
      if (verified.dataset && !issues.length) finalDataset("single_model");
      return;
    }

    result.audit.auditedBy = auditor.provider;
    result.audit.independentAudit = auditor.independent;
    result.crossChecked = auditor.independent;
    if (!auditor.independent) result.audit.limitations.push(`Not cross-checked: ${otherProvider} was unavailable, so ${drafter} audited its own draft in a separate call (not independent).`);
    result.audit.auditSummary = audit.summary;
    result.missingFields = [...new Set([...result.missingFields, ...audit.missingFields])];
    result.disagreements = [
      ...audit.disagreements,
      ...audit.claims.filter((c) => c.verdict !== "confirmed").map((c) => `${c.fieldPath}: ${c.verdict}${c.note ? ` - ${sanitize(c.note, undefined, 200)}` : ""}`),
    ];
    if (verified.dataset) {
      const confirmed = new Set(audit.claims.filter((c) => c.verdict === "confirmed").map((c) => c.fieldPath));
      if (!audit.approved) issues.push({ code: "AUDIT_NOT_APPROVED", path: auditor.provider, message: `${auditor.provider} did not approve the draft` });
      if (result.disagreements.length) issues.push({ code: "PROVIDER_DISAGREEMENT", path: auditor.provider, message: `${result.disagreements.length} disagreement(s) between providers` });
      if (audit.missingFields.length) issues.push({ code: "AUDIT_MISSING_FIELDS", path: auditor.provider, message: `${auditor.provider} reports missing required data` });
      for (const p of verified.observedPaths)
        if (!confirmed.has(p)) issues.push({ code: "AUDIT_UNCONFIRMED", path: p, message: `${auditor.provider} did not confirm this observed number` });
      // Estimates are judged for plausibility: an explicitly unreasonable one blocks the dataset.
      const verdicts = new Map(audit.estimateReviews.map((r) => [r.fieldPath, r]));
      for (const p of verified.estimatedPaths) {
        const v = verdicts.get(p);
        if (v?.verdict === "unreasonable") issues.push({ code: "AUDIT_ESTIMATE_REJECTED", path: p, message: `${auditor.provider} judged this estimate unreasonable${v.note ? `: ${sanitize(v.note, undefined, 200)}` : ""}` });
      }
      if (!issues.length) {
        finalDataset(auditor.independent ? "accepted" : "single_model");
        result.estimates = result.estimates.map((e) => ({ ...e, review: verdicts.get(e.path)?.verdict ?? "not_reviewed" }));
      }
    }
  }
}

/**
 * One provider drafts and the other independently audits the same supplied documents (Claude drafts / agy audits;
 * roles swap when one is expired, and a lone provider yields status "single_model"). Never throws for provider problems: they are reported in
 * `providers` / `audit.issues`. Throws AppError(400|413) only for invalid input.
 */
export async function analyzeEvidence(raw: unknown, options: IntelligenceOptions = {}): Promise<AnalysisResult> {
  const { input, excluded } = prepare(raw);
  const o = { ...intelligenceOptionsFromEnv(), ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) } as IntelligenceOptions;
  const cfg = resolveOptions(o);
  const runner = cfg.claude.runner;
  if (!runnerIds.has(runner)) runnerIds.set(runner, nextRunnerId++);
  const key = createHash("sha256")
    .update(JSON.stringify([input, excluded, cfg.claude.command, cfg.agy.command, cfg.claude.model, cfg.agy.model, cfg.claude.timeoutMs, runnerIds.get(runner)]))
    .digest("hex");

  const signal = o.signal;
  signal?.throwIfAborted();
  const ttl = options.cache === false ? 0 : (o.cacheTtlMs ?? 900_000);
  const hit = cache.get(key);
  if (ttl > 0 && hit && Date.now() - hit.at < ttl) return structuredClone(hit.result);

  let shared = inflight.get(key);
  if (!shared) {
    const controller = new AbortController();
    const fresh: Inflight = {
      controller,
      refs: 0,
      promise: run(input, excluded, o, controller.signal).then((result) => {
        // Provider failures (timeout, quota, missing CLI, abort) and skipped-because-expired providers are transient: never cached.
        if (ttl > 0 && !result.unavailable.length && !Object.values(result.providers).some((s) => s.status === "error") && !result.strategy.unavailable.some((u) => u.code === "STRATEGY_CALL_FAILED")) {
          if (cache.size >= CACHE_MAX) cache.delete(cache.keys().next().value!);
          cache.set(key, { at: Date.now(), result });
        }
        return result;
      }),
    };
    fresh.promise.then(() => undefined, () => undefined).finally(() => inflight.get(key) === fresh && inflight.delete(key));
    inflight.set(key, fresh);
    shared = fresh;
  }

  const entry = shared;
  entry.refs++;
  return new Promise<AnalysisResult>((resolvePromise, reject) => {
    let done = false;
    const onAbort = () => {
      if (done) return;
      done = true;
      if (--entry.refs === 0) {
        if (inflight.get(key) === entry) inflight.delete(key); // later callers must not join a cancelled run
        entry.controller.abort(signal!.reason);
      }
      reject(signal!.reason);
    };
    signal?.addEventListener("abort", onAbort, { once: true });
    entry.promise.then(
      (r) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", onAbort);
        resolvePromise(structuredClone(r));
      },
      (e) => {
        if (done) return;
        done = true;
        signal?.removeEventListener("abort", onAbort);
        reject(e);
      },
    );
  });
}

/** Cheap readiness probe: runs `<cli> --version` only. It does NOT verify login or quota (that would spend quota). */
export async function checkReadiness(options: IntelligenceOptions = {}): Promise<Readiness> {
  const o = { ...intelligenceOptionsFromEnv(), ...Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined)) } as IntelligenceOptions;
  const cfg = resolveOptions(o);
  const probe = async (c: ProviderConfig) => {
    try {
      const r = await c.runner({ command: c.command, args: ["--version"], stdin: "", env: buildEnv(c.env), cwd: tmpdir(), timeoutMs: Math.min(c.timeoutMs, 15_000), maxStdoutBytes: 10_000, signal: c.signal });
      if (r.aborted) return { command: c.command, available: false, error: "cancelled" };
      if (r.spawnError) return { command: c.command, available: false, error: `cannot run (${r.spawnError})` };
      if (r.timedOut) return { command: c.command, available: false, error: "timed out" };
      if (r.exitCode !== 0) return { command: c.command, available: false, error: sanitize(r.stderr || `exit ${r.exitCode}`) };
      return { command: c.command, available: true, version: sanitize(r.stdout, undefined, 80) };
    } catch (e) {
      return { command: c.command, available: false, error: sanitize(String((e as Error)?.message ?? e)) };
    }
  };
  const [claude, agy] = await Promise.all([probe(cfg.claude), probe(cfg.agy)]);
  return {
    ready: claude.available || agy.available,
    dual: claude.available && agy.available,
    claude,
    agy,
    notes: [
      "Only binary presence is checked; logins and quotas are verified by a real analysis. An expired provider is skipped at run time (single-model result, not cross-checked).",
      "agy has no login command: sign in once by starting it interactively (npm run agy:login).",
    ],
  };
}
