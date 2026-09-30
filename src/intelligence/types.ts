import { z } from "zod";
import type { Dataset } from "../domain/schema.js";
import type { Issue } from "../errors.js";
import { type Catalyst, type ConsensusSnapshot, type EarningsForecastSnapshot } from "../strategy/schema.js";
import { StrategyDraftSchema } from "./strategyVerify.js";

// ---- input ----------------------------------------------------------------

export const LIMITS = {
  maxDocuments: 30,
  maxDocumentChars: 100_000,
  maxTotalChars: 300_000,
  maxPromptChars: 450_000,
  maxStdoutBytes: 2_000_000,
  maxStderrBytes: 16_000,
} as const;

// ---- job/call timeout budget (shared with src/config.ts, the single source of truth for the numbers) -------------

/** Default per-CLI-call timeout (draft or audit), used whenever INTELLIGENCE_TIMEOUT_MS is unset. Generous on purpose:
 *  a full dataset draft with estimates/competitors/strategy fields is a long generation. */
export const DEFAULT_CALL_TIMEOUT_MS = 600_000;
/** Conservative bound even at concurrency=1: draft + fallback, audit + fallback, strategy + fallback, funding. */
export const JOB_MAX_SEQUENTIAL_CALLS = 7;
/** Default process-wide CLI concurrency: the audit and the separate strategy call of one analysis run in parallel
 * (2 calls), times the default number of concurrently running research jobs (RESEARCH_MAX_RUNNING=2). */
export const DEFAULT_MAX_CONCURRENT = 4;
/** Non-LLM headroom reserved in the outer job budget: evidence collection, queue wait, cleanup. */
export const JOB_OVERHEAD_MS = 300_000;

// ---- Claude --effort -------------------------------------------------------------------------------------------

export const CLAUDE_EFFORT_LEVELS = ["low", "medium", "high", "xhigh", "max"] as const;
export type ClaudeEffort = (typeof CLAUDE_EFFORT_LEVELS)[number];
/** "medium" is enough for this structured extraction task and materially faster than "high"; override with INTELLIGENCE_CLAUDE_EFFORT. */
export const DEFAULT_CLAUDE_EFFORT: ClaudeEffort = "medium";

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export const EvidenceDocumentSchema = z
  .object({
    id: z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/),
    title: z.string().trim().min(1).max(300),
    url: z.url({ protocol: /^https?$/ }).max(500),
    publishedAt: isoDate,
    text: z.string().min(1).max(LIMITS.maxDocumentChars),
  })
  .strict();

export const EvidenceInputSchema = z
  .object({
    ticker: z.string().regex(/^\d{6}$/, "six-digit KOSPI ticker"),
    asOf: isoDate,
    documents: z.array(EvidenceDocumentSchema).min(1).max(LIMITS.maxDocuments),
  })
  .strict();

export type EvidenceDocument = z.infer<typeof EvidenceDocumentSchema>;
export type EvidenceInput = z.infer<typeof EvidenceInputSchema>;

// ---- model outputs (strip unknown keys; models are chatty) -------------------

export const CitationSchema = z.object({
  fieldPath: z.string().min(1).max(200), // e.g. quote.priceKRW, markets[0].observations[1].revenue
  documentId: z.string().max(64),
  url: z.string().max(500),
  publishedAt: z.string().max(10),
  evidenceQuote: z.string().min(1).max(1000), // must occur verbatim in the document text
  quotedNumber: z.string().max(40).optional(), // number exactly as written inside evidenceQuote
  multiplier: z.number().positive().optional(), // documented transform: value = quotedNumber * multiplier
});
export type Citation = z.infer<typeof CitationSchema>;

// Free prose from a model (notes, disagreements, summaries) is display text: an over-long entry or list is truncated,
// never a reason to reject the whole reply (a 501-character disagreement used to fail the audit as SCHEMA_INVALID).
// Fields that are matched verbatim (fieldPath, evidenceQuote, quotedNumber) keep their strict limits.
export const clip = (s: string, max: number): string => (s.length > max ? `${s.slice(0, max - 1)}…` : s);
const prose = (max: number) => z.string().transform((s) => clip(s, max));
const proseList = (maxItem: number, maxItems: number) => z.array(prose(maxItem)).transform((a) => a.slice(0, maxItems));
const shortList = proseList(500, 50);

export const ProposalSchema = z.object({
  dataset: z.unknown().nullable(), // validated separately with DatasetSchema for precise issues
  missingFields: shortList,
  narrative: z.object({
    product: prose(4000),
    industry: prose(4000),
    marketSizing: prose(4000).optional(), // how the market size was obtained / inferred
    competition: prose(4000).optional(), // main competitors and how their sizes add up to the market
  }),
  citations: z.array(CitationSchema).max(300),
  assumptions: z
    .array(z.object({ fieldPath: z.string().max(200), statement: prose(500), rationale: prose(500) }))
    .transform((a) => a.slice(0, 60)),
  limitations: shortList,
});
export type Proposal = z.infer<typeof ProposalSchema>;

/** Reply of the SEPARATE strategy call (strategyPrompt), made independently of the Dataset draft so the
 * earnings-gap-auto/v1 extraction (docs/STRATEGY_SPEC.md) gets the model's full attention instead of being an
 * afterthought appended to a long Dataset generation. `strategy` is required: only its outer shape is enforced here
 * (an object with all four keys, each possibly null; see StrategyDraftSchema), because the strategy sub-schemas
 * (SingleQuarterForecastSchema etc.) are strict and exacting -- verifyStrategyDraft (strategyVerify.ts) parses
 * each piece independently and drops (with a reason) whatever does not validate or cite real evidence. `citations`
 * are this call's own strategy citations (fieldPaths like "currentConsensus.epsPerShare"). */
export const StrategyProposalSchema = z.object({
  strategy: StrategyDraftSchema,
  citations: z.array(CitationSchema).max(300),
});
export type StrategyProposal = z.infer<typeof StrategyProposalSchema>;

// `funding` is parsed by verifyStrategyDraft (strategyVerify.ts), not here: a strict-schema miss in one field used to
// reject the WHOLE reply as FUNDING_CALL_FAILED, hiding which field was wrong. It is now reported field by field.
export const FundingProposalSchema = z.object({
  funding: z.unknown().nullable().transform((v) => v ?? null),
  missingFields: z.array(z.string().trim().min(1).transform((s) => clip(s, 500))).transform((a) => a.slice(0, 30)),
}).refine((r) => r.funding !== null || r.missingFields.length > 0, "explain missing funding inputs when funding is null");

export const AuditSchema = z.object({
  approved: z.boolean(),
  claims: z
    .array(
      z.object({
        fieldPath: z.string().max(200),
        verdict: z.enum(["confirmed", "rejected", "unverifiable"]),
        note: prose(500).optional(),
      }),
    )
    .max(400),
  // Verdicts on ESTIMATED inputs (market size, product/competitor revenue inferred instead of read from a source).
  estimateReviews: z
    .array(z.object({ fieldPath: z.string().max(200), verdict: z.enum(["reasonable", "unreasonable", "unverifiable"]), note: prose(500).optional() }))
    .max(100)
    .default([]),
  disagreements: shortList,
  missingFields: shortList,
  summary: prose(4000),
});
export type Audit = z.infer<typeof AuditSchema>;

// ---- runner ----------------------------------------------------------------

export type RunRequest = {
  command: string;
  args: string[];
  stdin: string;
  env: Record<string, string>;
  cwd: string;
  timeoutMs: number;
  maxStdoutBytes: number;
  signal?: AbortSignal; // abort => the child (process group) is killed and the result has aborted: true
};
export type RunResult = {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  timedOut: boolean;
  outputLimitExceeded: boolean;
  aborted?: boolean;
  spawnError?: string; // errno code such as ENOENT / EACCES
};
export type Runner = (req: RunRequest) => Promise<RunResult>;

// ---- options / results -------------------------------------------------------

export type IntelligenceOptions = {
  claudePath?: string; // server config only
  agyPath?: string; // Antigravity CLI (`agy`), server config only
  claudeModel?: string;
  agyModel?: string; // model for the agy provider (default: an independent Gemini model)
  /** Claude Code --effort level (low/medium/high/xhigh/max). Default "medium" for this structured extraction task;
   *  an unrecognised value is diagnosed (logged) and falls back to the default. Override with INTELLIGENCE_CLAUDE_EFFORT env. */
  claudeEffort?: string;
  timeoutMs?: number; // per CLI call, default DEFAULT_CALL_TIMEOUT_MS (300_000)
  maxConcurrent?: number; // simultaneous CLI processes across all analyses, default DEFAULT_MAX_CONCURRENT (4)
  cacheTtlMs?: number; // default 900_000; 0 disables
  cache?: boolean; // default true
  runner?: Runner; // injectable for tests
  env?: NodeJS.ProcessEnv; // source for the env allowlist, default process.env
  now?: () => Date;
  signal?: AbortSignal; // e.g. HTTP shutdown / client disconnect: kills CLI children, analyzeEvidence rejects with signal.reason
  /** Full job timeout (outer deadline from JobManager). Used ONLY to emit a diagnostic warning when per-call
   * timeoutMs is too large to leave room for sequential draft/audit calls within the job budget. */
  jobTimeoutMs?: number;
};

/** "agy" = Google Antigravity CLI (runs Gemini models). */
export type ProviderName = "claude" | "agy";
export type ProviderStatus = {
  provider: ProviderName;
  status: "ok" | "error" | "skipped";
  code: string; // OK | CLI_NOT_FOUND | TIMEOUT | OUTPUT_LIMIT | AUTH_REQUIRED | QUOTA | UNAVAILABLE | CONFIG_ERROR | ABORTED | EXIT_NONZERO | BAD_ENVELOPE | BAD_JSON | SCHEMA_INVALID | TOOL_USE_DETECTED | SKIPPED
  message: string; // sanitized, bounded
  durationMs: number;
};

/**
 * accepted      both providers ran and approved the dataset;
 * single_model  the dataset passed every deterministic check but only ONE provider was usable (the other's login/quota
 *               had expired), so it is not cross-checked (see `crossChecked`/`unavailable`);
 * partial / unavailable  no dataset may be used.
 */
export type EstimateSummary = { path: string; kind: "market" | "product" | "competitor"; quarter: string; value: number; currency: string; method: string; basedOn: string[]; rationale: string; review?: "reasonable" | "unreasonable" | "unverifiable" | "not_reviewed" };

export type AnalysisStatus = "accepted" | "single_model" | "partial" | "unavailable";

/** A provider that was not used because its login/quota is expired (or its CLI is missing). */
export type ProviderUnavailable = { provider: ProviderName; code: string; message: string; retryAfter: string; skippedWithoutCall: boolean };

/** Why one piece of the strategy extraction was dropped (never silently absent without a reason). */
export type StrategyDropReason = { field: string; code: string; message: string };

/**
 * earnings-gap-auto/v1 signals extracted from the SAME evidence/draft as the Dataset above, deterministically
 * verified (real citations/source provenance; see strategyVerify.ts). Never audited by the second model the way
 * Dataset fields are (see docs/STRATEGY_HANDOFF.md limitations) -- acceptance rests on citation/source checks only.
 * Any piece that failed validation or provenance is null, with the reason recorded in `unavailable`, never fabricated.
 */
export type StrategyExtraction = {
  forecast: EarningsForecastSnapshot | null;
  currentConsensus: ConsensusSnapshot | null;
  priorConsensus: ConsensusSnapshot | null;
  catalyst: Catalyst | null;
  unavailable: StrategyDropReason[];
};

export type AnalysisResult = {
  status: AnalysisStatus; // accepted => dataset non-null and approved by both providers; single_model => see AnalysisStatus
  dataset: Dataset | null; // never synthetic; null means no verified valuation may be produced
  /**
   * The draft's dataset when it only failed SOFT checks (unconfirmed/uncited numbers, audit disagreement, audit not
   * approved or failed, ...). Parsed, never synthetic, right ticker, nothing dated after asOf. The server may value it
   * as a PROVISIONAL result with every concern reported (research/service.ts); absent/null when unusable.
   */
  provisionalDataset?: Dataset | null;
  missingFields: string[];
  narrative: Proposal["narrative"] | null; // Korean; unreviewed unless status=accepted
  citations: Citation[]; // only citations that passed verification
  assumptions: Proposal["assumptions"];
  disagreements: string[];
  providers: Record<ProviderName, ProviderStatus>;
  crossChecked: boolean; // true only when both providers ran (draft + independent audit by the OTHER provider)
  estimates: EstimateSummary[]; // inferred (not source-read) revenue inputs of the accepted dataset, for the report
  unavailable: ProviderUnavailable[]; // expired providers that were skipped instead of failing the analysis
  strategy: StrategyExtraction; // additive earnings-gap-auto/v1 signals; independent of dataset/status above
  audit: {
    issues: Issue[]; // every reason the dataset was rejected
    excludedDocuments: string[]; // published after asOf, never shown to the models
    auditSummary: string | null;
    auditedBy: ProviderName | null; // who audited the draft
    independentAudit: boolean; // false when the drafting provider also audited (the other one was unavailable)
    limitations: string[];
  };
  generatedAt: string;
};

export type Readiness = {
  ready: boolean; // at least one provider CLI is runnable
  dual: boolean; // both are runnable (cross-check possible)
  claude: { command: string; available: boolean; version?: string; error?: string };
  agy: { command: string; available: boolean; version?: string; error?: string };
  notes: string[];
};
