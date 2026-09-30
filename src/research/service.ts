import type { PublicEvidence } from "../collection/types.js";
import { DatasetSchema, type Dataset } from "../domain/schema.js";
import { seoulToday } from "../domain/time.js";
import { relaxDataset } from "../domain/relax.js";
import { classifySecurity, describeRejections } from "../domain/security.js";
import { AppError } from "../errors.js";
import type { AnalysisResult, EvidenceInput } from "../intelligence/types.js";
import { sanitize } from "../intelligence/runner.js";
import { analyze } from "../model/model.js";
import { buildReport } from "./report.js";
import { buildDocuments, kstDate, summarizeEvidence, type BuiltDocuments } from "./evidence.js";
import { JobManager, type Job, type JobKind, type JobLimits, type JobOutcome, type Work } from "./jobs.js";
import { evaluateAutoStrategy } from "../strategy/auto.js";
import { deriveFundingPlan } from "../strategy/funding-derive.js";

export type Collector = (input: { ticker: string; asOf: string; competitors?: string[] }, opts: { signal: AbortSignal }) => Promise<PublicEvidence>;
/** `signal` aborts running CLI children (job timeout / server close). */
export type Intelligence = (input: EvidenceInput, opts: { signal: AbortSignal }) => Promise<AnalysisResult>;

export type ResearchDeps = {
  collect: Collector;
  intelligence: Intelligence;
  now: () => Date;
  /** Values that must never appear in a response (API keys). Read at call time. */
  secrets?: () => string[];
  /** earnings-gap-auto/v1 automatic path (strategy/auto.ts): a portfolio assumption, never invented; undefined means
   * the funding-gap check uses 0 and says so explicitly (see AutoStrategyResult.notes). */
  strategyMinimumCashBufferKRW?: number;
};

/** blocking: no valuation is produced. warning: the valuation is still produced, but reported as provisional. */
type Severity = "blocking" | "warning";
type Reason = { code: string; severity: Severity; message: string; details?: unknown };
type MissingInput = { source: "collector" | "intelligence" | "gate"; field: string; status?: string; detail?: string };

const ROUTES: Record<JobKind, string> = { analysis: "/v1/analyses", research: "/v1/research" };

export class ResearchService {
  readonly jobs: JobManager;

  constructor(
    private deps: ResearchDeps,
    limits: JobLimits,
    private resolveAsOf: (asOf?: string) => string,
  ) {
    this.jobs = new JobManager(limits, () => deps.now().getTime());
  }

  // ---- submit / poll ------------------------------------------------------------------------------------------

  /** Common stocks only: a preferred-share ticker is refused before any job or network call. */
  private requireCommonStock(ticker: string) {
    const r = classifySecurity({ ticker });
    if (r.length) throw new AppError(422, "NOT_COMMON_STOCK", `Ticker ${ticker} is not a KOSPI common stock: ${describeRejections(r)}`, r, "Only common shares of operating companies are analysed (no preferred shares, ETF/ETN, REITs, infrastructure funds or SPACs).");
  }

  startAnalysis(req: { ticker: string; asOf?: string; competitors?: string[] }) {
    this.requireCommonStock(req.ticker);
    const asOf = this.resolveAsOf(req.asOf);
    const competitors = req.competitors ?? [];
    return this.submit("analysis", req.ticker, asOf, competitors, (ticker, a) => this.analysisWork(ticker, a, competitors));
  }

  startResearch(req: { ticker: string; asOf?: string; competitors?: string[] }) {
    this.requireCommonStock(req.ticker);
    const asOf = this.resolveAsOf(req.asOf);
    const competitors = req.competitors ?? [];
    return this.submit("research", req.ticker, asOf, competitors, (ticker, a) => this.researchWork(ticker, a, competitors));
  }

  getJob(id: string, kind: JobKind): ReturnType<ResearchService["view"]> {
    const job = this.jobs.get(id, kind);
    if (!job) throw new AppError(404, "JOB_NOT_FOUND", `No ${kind} job ${id} (unknown or expired; jobs are in-memory and lost on restart)`);
    return this.view(job);
  }

  /** Long-poll: waits up to `waitMs` for a queued/running job to finish, then returns its current view. */
  async waitJob(id: string, kind: JobKind, waitMs: number): Promise<ReturnType<ResearchService["view"]>> {
    const job = this.jobs.get(id, kind);
    if (job && (job.status === "queued" || job.status === "running")) await this.jobs.waitFor(id, waitMs);
    return this.getJob(id, kind);
  }

  close(): Promise<void> {
    return this.jobs.close();
  }

  private submit(kind: JobKind, ticker: string, asOf: string, competitors: string[], work: (ticker: string, asOf: string) => Work) {
    const cmp = [...competitors].sort();
    const { job, deduplicated } = this.jobs.submit(
      kind,
      `${kind}:${ticker}:${asOf}${cmp.length ? `:${cmp.join(",")}` : ""}`,
      { ticker, asOf, ...(kind === "analysis" && { mode: "public" }), ...(cmp.length && { competitors: cmp }) },
      work(ticker, asOf),
    );
    return { id: job.id, status: job.status, statusUrl: `${ROUTES[kind]}/${job.id}`, deduplicated };
  }

  private view(job: Job) {
    const iso = (t?: number) => (t === undefined ? undefined : new Date(t).toISOString());
    const body = {
      id: job.id,
      kind: job.kind,
      status: job.status,
      request: job.request,
      statusUrl: `${ROUTES[job.kind]}/${job.id}`,
      createdAt: iso(job.createdAt),
      startedAt: iso(job.startedAt),
      finishedAt: iso(job.finishedAt),
      expiresAt: iso(this.jobs.expiresAt(job)),
      ...(job.outcome?.result !== undefined && { result: job.outcome.result }),
      ...(job.outcome?.error && { error: job.outcome.error }),
    };
    return body;
  }

  // ---- helpers ------------------------------------------------------------------------------------------------

  /** Deep-scrub configured secrets out of anything that is about to be stored/returned; also drops NaN/Infinity. */
  private clean<T>(value: T): T {
    let text = JSON.stringify(value);
    for (const s of this.deps.secrets?.() ?? []) if (s.length >= 6) text = text.split(s).join("[redacted]");
    return JSON.parse(text) as T;
  }

  private msg(e: unknown): string {
    // first line only: never surface stack-like continuation lines
    let m = sanitize((e instanceof Error ? e.message : String(e)).split(/\r?\n/)[0] ?? "", undefined, 300);
    for (const s of this.deps.secrets?.() ?? []) if (s.length >= 6) m = m.split(s).join("[redacted]");
    return m;
  }

  private async collectEvidence(ticker: string, asOf: string, competitors: string[], signal: AbortSignal): Promise<{ ev: PublicEvidence } | { outcome: JobOutcome }> {
    try {
      const ev = await this.deps.collect({ ticker, asOf, ...(competitors.length && { competitors }) }, { signal });
      const notCommon = ev.issues?.find((i) => i.code === "not_common_stock");
      if (notCommon)
        return { outcome: { status: "failed", error: { code: "NOT_COMMON_STOCK", message: this.msg(notCommon.message) }, result: this.clean({ ticker, asOf, evidence: summarizeEvidence(ev, buildDocuments(ev)) }) } };
      if (ev.issues?.some((i) => i.code === "not_kospi"))
        return { outcome: { status: "failed", error: { code: "NOT_KOSPI", message: `Ticker ${ticker} is not a KOSPI listing; only KOSPI companies are supported` }, result: this.clean({ ticker, asOf, evidence: summarizeEvidence(ev, buildDocuments(ev)) }) } };
      return { ev };
    } catch (e) {
      if (signal.aborted) throw e; // job manager reports timeout / shutdown
      const input = (e as Error)?.name === "CollectionInputError";
      return { outcome: { status: "failed", error: { code: input ? "COLLECTION_INPUT_INVALID" : "COLLECTION_FAILED", message: this.msg(e) } } };
    }
  }

  // ---- evidence-only job (no LLM) -----------------------------------------------------------------------------

  private researchWork(ticker: string, asOf: string, competitors: string[]): Work {
    return async ({ signal }) => {
      const got = await this.collectEvidence(ticker, asOf, competitors, signal);
      if ("outcome" in got) return got.outcome;
      const built = buildDocuments(got.ev);
      const status = got.ev.status === "ok" ? "completed" : got.ev.status === "partial" ? "partial" : "failed";
      return {
        status,
        result: this.clean({
          ticker,
          asOf,
          llmInvoked: false,
          note: "Evidence only: no Claude/agy call was made and no valuation is produced. Use POST /v1/analyses for dual-model research.",
          evidence: got.ev,
          documents: { sentToModelsIfAnalysed: built.refs, omitted: built.omitted },
          missingInputs: got.ev.requiredInputs.map((r) => ({ source: "collector", field: r.field, status: r.status, detail: r.detail })),
        }),
        ...(status === "failed" && { error: { code: "COLLECTION_FAILED", message: "No provider returned usable evidence; see result.evidence.issues" } }),
      };
    };
  }

  // ---- full public analysis job -------------------------------------------------------------------------------

  private analysisWork(ticker: string, asOf: string, competitors: string[]): Work {
    return async ({ signal }) => {
      const got = await this.collectEvidence(ticker, asOf, competitors, signal);
      if ("outcome" in got) return got.outcome;
      const ev = got.ev;
      const built = buildDocuments(ev);
      const reasons: Reason[] = [];
      const notes: string[] = [];
      const today = seoulToday(this.deps.now());

      // Gate policy: a price is produced whenever the proposed dataset is usable by construction (parsed, right company,
      // nothing dated after asOf, no double counting or unit/currency mix-up). Every weaker concern -- unverified
      // exchange/quote, a provider failure, an unconfirmed or uncited number, a stale input, a repaired field -- is kept
      // as a "warning" reason next to the price, and the valuation is graded "provisional" instead of "verified".
      const block = (code: string, message: string, details?: unknown) => reasons.push({ code, severity: "blocking", message, ...(details !== undefined && { details }) });
      const warn = (code: string, message: string, details?: unknown) => reasons.push({ code, severity: "warning", message, ...(details !== undefined && { details }) });

      if (ev.company.exchange !== "KOSPI") warn("EXCHANGE_UNVERIFIED", "KOSPI listing could not be verified by Naver or DART; the valuation relies on the dataset's own KOSPI claim");
      if (!ev.market.quote)
        asOf < today
          ? warn("HISTORICAL_QUOTE_UNAVAILABLE", `asOf ${asOf} is before today (${today}); Naver only serves the latest quote snapshot, so no dated quote exists for that date. The dataset's quote (from the documents) is used unverified; use today's date or a manual dataset for a verified quote.`)
          : warn("QUOTE_MISSING", "No usable Naver quote was collected; the dataset's quote (from the documents) is used unverified");
      else if (asOf < today) notes.push(`Quote is Naver's latest snapshot traded ${ev.market.quote.tradedAt}, retrieved after asOf ${asOf}; it is used only because no later trade preceded the cutoff.`);

      let research: AnalysisResult | null = null;
      if (built.documents.length === 0) block("NO_EVIDENCE_DOCUMENTS", "No attributable evidence documents were collected; models were not invoked");
      else {
        try {
          research = await this.deps.intelligence({ ticker, asOf, documents: built.documents }, { signal });
        } catch (e) {
          if (signal.aborted) throw e;
          block("INTELLIGENCE_ERROR", this.msg(e));
        }
      }

      let analysis: ReturnType<typeof analyze> | null = null;
      if (research) {
        // An expired provider (login/quota) is skipped, not a failure: a single-model dataset that passed every
        // deterministic check is still used, and the missing cross-check is reported prominently.
        const singleModel = research.status === "single_model";
        const expired = new Set(research.unavailable.map((u) => u.provider));
        for (const p of Object.values(research.providers)) if (p.status !== "ok" && !expired.has(p.provider)) warn(`PROVIDER_${p.status.toUpperCase()}`, `${p.provider}: ${p.code} - ${p.message}`);
        for (const u of research.unavailable)
          notes.push(`${u.provider} 사용 불가(${u.code}) — ${u.skippedWithoutCall ? "만료가 확인되어 호출하지 않고 건너뛰었습니다" : "호출했으나 만료되어 사용하지 않았습니다"}${singleModel ? ` (교차검증 없이 ${u.provider === "claude" ? "agy" : "claude"} 단일 모델 결과)` : ""}. 재사용 가능 시각(추정): ${u.retryAfter}`);
        const reviewed = (research.status === "accepted" || singleModel) && research.dataset ? research.dataset : null;
        const proposed = reviewed ?? research.provisionalDataset ?? null;
        if (!proposed) block("RESEARCH_NOT_ACCEPTED", "Model review did not produce a usable dataset", research.audit.issues.map((i) => i.code));
        else {
          if (!reviewed)
            warn("RESEARCH_PROVISIONAL", "The model review did not accept the dataset; it is valued provisionally because it passed the hard checks (right company, nothing after asOf, schema). See details and research.audit.issues.", research.audit.issues.map((i) => ({ code: i.code, path: i.path })));
          const checked = this.checkDataset(proposed, ticker, asOf, ev);
          reasons.push(...checked.reasons);
          if (checked.dataset && !reasons.some((r) => r.severity === "blocking")) {
            try {
              analysis = analyze(checked.dataset, asOf);
            } catch (e) {
              block(e instanceof AppError ? e.code : "MODEL_FAILED", this.msg(e));
            }
          }
        }
      }
      if (reasons.some((r) => r.severity === "blocking")) analysis = null; // never a valuation next to a blocking problem
      const provisional = reasons.some((r) => r.severity === "warning");

      // Top-level valuation status mirrors the real scenario valuations (non-positive common earnings => unavailable).
      const scenarioStatus = analysis ? Object.fromEntries(analysis.scenarios.map((s) => [s.scenario, s.valuation.status])) : null;
      const availableCount = analysis ? analysis.scenarios.filter((s) => s.valuation.status === "available").length : 0;
      const valuation = {
        status: !analysis ? "unavailable" : availableCount === analysis.scenarios.length ? "available" : availableCount > 0 ? "partial" : "unavailable",
        scenarios: scenarioStatus,
        grade: analysis ? (provisional ? "provisional" : "verified") : null,
      };
      if (analysis && valuation.status !== "available")
        reasons.push({ code: "VALUATION_UNAVAILABLE", severity: "warning", message: "One or more scenarios have non-positive common-share earnings, so their P/E valuation is unavailable (see analysis.scenarios[].valuation)", details: scenarioStatus });

      // A fully resolved analysis does not advertise the collector's pre-extraction gaps as still missing
      // (they stay visible in evidence.requiredInputs).
      const missingInputs: MissingInput[] = reasons.length
        ? [
            ...ev.requiredInputs.map((r) => ({ source: "collector" as const, field: r.field, status: r.status, detail: r.detail })),
            ...(research?.missingFields ?? []).map((f) => ({ source: "intelligence" as const, field: f })),
            ...reasons.map((r) => ({ source: "gate" as const, field: r.code, detail: r.message })),
          ]
        : [];

      // Automatic earnings-gap-auto/v1 signals (docs/STRATEGY.md "Automatic connection"): additive to the
      // product-market analysis above, computed from the SAME collected evidence/model draft, independent of
      // whether the Dataset itself was accepted. Never affects `reasons`/job status: a missing/partial strategy
      // extraction must never mask or downgrade the existing valuation. ALWAYS present (never null) so the result
      // never silently drops the section when no draft was produced -- it explicitly reports itself unavailable.
      //
      // decisionAt is never a mix of "evidence frozen at an old asOf" and "evaluated as if decided today": a live
      // (asOf === today) request is evaluated at the actual current instant; a historical asOf is evaluated AT that
      // date's end-of-day (KST) instead, so a retrospective run is never displayed as a live current judgement.
      const live = asOf === today;
      const decisionAt = live ? this.deps.now().toISOString() : `${asOf}T23:59:59+09:00`;
      // Funding risk used to exist only when the model's own funding plan survived its strict schema/source checks,
      // so one rejected reply left risk=null although the consolidated BS/CF behind it had been collected. When no
      // verified model plan exists, derive one deterministically from those statements (strategy/funding-derive.ts):
      // the model's failure reasons are kept as notes, and a derivation that is impossible is reported explicitly.
      let strategyForecast = research?.strategy.forecast ?? null;
      let strategyUnavailable = research?.strategy.unavailable ?? [{ field: "all", code: "NO_MODEL_DRAFT", message: "no model draft was produced for this analysis (see partialReasons)" }];
      let fundingOrigin: "model" | "derived_from_filings" = "model";
      let noRefinancing: { currentDebtKRW: number; assumedPrincipalDueKRW: number } | undefined;
      const strategyNotes: string[] = [];
      if (strategyForecast && !strategyForecast.funding && strategyForecast.quarters.length === 1) {
        const derived = deriveFundingPlan(ev.filings.statements, built.documents, strategyForecast.quarters[0]!.quarter, [...ev.filings.excerpts, ...ev.filings.tables]);
        const isFunding = (u: { field: string; code: string }) => u.field === "funding" || u.code.startsWith("FUNDING_") || u.code === "INVALID_DEBT_SCHEDULE";
        if (derived.status === "derived") {
          strategyForecast = { ...strategyForecast, funding: derived.plan };
          fundingOrigin = "derived_from_filings";
          noRefinancing = derived.noRefinancing;
          const modelReasons = strategyUnavailable.filter(isFunding);
          strategyUnavailable = strategyUnavailable.filter((u) => !isFunding(u));
          strategyNotes.push(`자금 계획은 모델 초안이 아니라 ${derived.statement.period} 연결 재무제표(기말 ${derived.statement.periodEnd}, 접수번호 ${derived.statement.rceptNo})에서 결정론적으로 파생했습니다. ${derived.limitations.join(" ")}`);
          if (modelReasons.length) strategyNotes.push(`모델 자금 계획을 쓰지 않은 이유: ${modelReasons.map((u) => `[${u.code}] ${u.message}`).join(" / ")}`);
        } else {
          strategyUnavailable = [...strategyUnavailable, { field: "funding", code: derived.code, message: derived.message }];
        }
      }
      const strategyAuto = evaluateAutoStrategy({
        ticker,
        decisionAt,
        mode: live ? "live" : "retrospective_research",
        forecast: strategyForecast,
        fundingOrigin,
        noRefinancing,
        notes: strategyNotes,
        currentConsensus: research?.strategy.currentConsensus ?? null,
        quarterlyConsensus: ev.market.quarterlyConsensus ?? [],
        quarterlyActuals: ev.market.quarterlyActuals ?? [],
        dailyCloses: ev.market.dailyCloses ?? [],
        priorConsensus: research?.strategy.priorConsensus ?? null,
        catalyst: research?.strategy.catalyst ?? null,
        unavailable: strategyUnavailable,
        minimumCashBufferKRW: this.deps.strategyMinimumCashBufferKRW ?? 0,
        cashBufferConfigured: this.deps.strategyMinimumCashBufferKRW !== undefined,
      });

      const result = {
        mode: "public",
        ticker,
        asOf,
        evidence: summarizeEvidence(ev, built),
        strategyAuto,
        research: research && {
          status: research.status,
          providers: research.providers,
          narrative: research.narrative,
          citations: research.citations,
          assumptions: research.assumptions,
          disagreements: research.disagreements,
          missingFields: research.missingFields,
          audit: research.audit,
          generatedAt: research.generatedAt,
          narrativeReviewed: research.status === "accepted",
          crossChecked: research.crossChecked,
          estimates: research.estimates,
          unavailable: research.unavailable,
        },
        analysis,
        report: analysis && research ? buildReport(analysis, research) : null,
        valuation,
        partialReasons: reasons,
        missingInputs,
        notes,
      };
      return { status: reasons.length === 0 ? "completed" : "partial", result: this.clean(result) };
    };
  }

  /**
   * Deterministic gates on a dataset proposed by the models. Never persists it. Repairs what is repairable (quote
   * replaced by the collected one, series order, unfinished quarters, share bounds, residual assumptions) and returns
   * the dataset to value, with blocking reasons (no valuation) and warnings (provisional valuation).
   */
  private checkDataset(raw: Dataset, ticker: string, asOf: string, ev: PublicEvidence): { dataset: Dataset | null; reasons: Reason[] } {
    const reasons: Reason[] = [];
    const parsed = DatasetSchema.safeParse(raw);
    if (!parsed.success) return { dataset: null, reasons: [{ code: "DATASET_SCHEMA_INVALID", severity: "blocking", message: "Proposed dataset failed schema validation", details: parsed.error.issues.slice(0, 20).map((i) => ({ path: i.path.join("."), message: i.message })) }] };
    let ds = parsed.data;
    if (ds.company.ticker !== ticker) reasons.push({ code: "DATASET_TICKER_MISMATCH", severity: "blocking", message: `Dataset is for ${ds.company.ticker}, request was ${ticker}` });
    if (ds.synthetic) reasons.push({ code: "DATASET_SYNTHETIC", severity: "blocking", message: "Synthetic datasets are never valid for public analysis" });
    const quote = ev.market.quote;
    if (quote && (ds.quote.priceKRW !== quote.close || ds.quote.asOf !== kstDate(quote.tradedAt))) {
      const tradedOn = kstDate(quote.tradedAt);
      reasons.push({ code: "DATASET_QUOTE_REPLACED", severity: "warning", message: `Dataset quote ${ds.quote.priceKRW} @ ${ds.quote.asOf} differed from the collected Naver quote ${quote.close} traded ${tradedOn} (KST); the collected quote is used` });
      ds = { ...ds, quote: { priceKRW: quote.close, asOf: tradedOn, source: { title: "Naver 증권 시세", url: quote.sourceUrl, publishedAt: tradedOn } } };
    }
    const relaxed = relaxDataset(ds, asOf);
    if (relaxed.repairs.length) reasons.push({ code: "DATASET_REPAIRED", severity: "warning", message: `${relaxed.repairs.length} field(s) of the proposed dataset were repaired by the server`, details: relaxed.repairs });
    if (relaxed.hard.length) reasons.push({ code: "DATA_VALIDATION_FAILED", severity: "blocking", message: `${relaxed.hard.length} blocking validation issue(s) in the proposed dataset`, details: [...relaxed.hard, ...relaxed.soft].slice(0, 50) });
    else if (relaxed.soft.length) reasons.push({ code: "DATA_VALIDATION_WARNINGS", severity: "warning", message: `${relaxed.soft.length} non-blocking validation issue(s); the valuation is provisional`, details: relaxed.soft.slice(0, 50) });
    return { dataset: relaxed.dataset, reasons };
  }
}

export type { BuiltDocuments };
