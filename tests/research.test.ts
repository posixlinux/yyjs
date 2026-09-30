import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { FilingEvidence, PublicEvidence, StatementSet } from "../src/collection/types.js";
import { loadConfig } from "../src/config.js";
import type { Dataset } from "../src/domain/schema.js";
import { analyzeEvidence } from "../src/intelligence/index.js";
import { EvidenceDocumentSchema, LIMITS, type AnalysisResult, type EvidenceInput } from "../src/intelligence/types.js";
import type { RunRequest, RunResult, Runner } from "../src/intelligence/types.js";
import { formatDoctor, runDoctor } from "../src/research/doctor.js";
import { buildDocuments, kstDate, truncateStatement } from "../src/research/evidence.js";
import { AS_OF, makeDataset, NOW, tmpDir } from "../test/fixture.js";
import { setup, type TestApp } from "../test/app.js";
import { writeFile, mkdir } from "node:fs/promises";
import { makeSingleQuarterCandidate } from "../test/strategy/fixture.js";

// ---- fakes -----------------------------------------------------------------------------------------------------

const RECEIPT = (n: string) => `https://dart.fss.or.kr/dsaf001/main.do?rcpNo=${n}`;

const filing = (rceptNo: string, received: string, type: FilingEvidence["period"]["type"], end: string, over: Partial<FilingEvidence> = {}): FilingEvidence => ({
  rceptNo,
  receiptUrl: RECEIPT(rceptNo),
  reportName: `분기보고서 (${end.slice(0, 7).replace("-", ".")})`,
  receivedDate: received,
  period: { type, end, fiscalYear: Number(end.slice(0, 4)) },
  isCorrection: false,
  ...over,
});

const statement = (rceptNo: string, over: Partial<StatementSet> = {}): StatementSet => ({
  fiscalYear: 2025,
  period: "Q3",
  periodEnd: "2025-09-30",
  reportCode: "11014",
  fsDiv: "CFS",
  rceptNo,
  receiptUrl: RECEIPT(rceptNo),
  thisTermCovers: "3_months",
  cumulativeCovers: "9_months",
  amountsInCurrencyUnits: true,
  rowsTruncated: false,
  rows: [
    { statement: "IS", accountId: "ifrs-full_Revenue", accountName: "매출액", currency: "KRW", thisTermLabel: "제 57 기 3분기", thisTermAmount: 74068313000000, thisTermCumulativeAmount: 200000000000000, priorTermLabel: null, priorTermAmount: null, priorQuarterLabel: null, priorQuarterAmount: null, priorCumulativeAmount: null },
    { statement: "IS", accountId: "ifrs-full_BasicEarningsLossPerShare", accountName: "기본주당이익", currency: "KRW", thisTermLabel: null, thisTermAmount: 1234.56, thisTermCumulativeAmount: null, priorTermLabel: null, priorTermAmount: null, priorQuarterLabel: null, priorQuarterAmount: null, priorCumulativeAmount: null },
    { statement: "BS", accountId: "ifrs-full_Assets", accountName: "자산총계", currency: "USD", thisTermLabel: "제 57 기 3분기말", thisTermAmount: 5000000.25, thisTermCumulativeAmount: null, priorTermLabel: null, priorTermAmount: null, priorQuarterLabel: null, priorQuarterAmount: null, priorCumulativeAmount: null },
    { statement: "CF", accountId: "ifrs-full_CashFlowsFromUsedInOperatingActivities", accountName: "영업활동현금흐름", currency: null, thisTermLabel: null, thisTermAmount: 42, thisTermCumulativeAmount: null, priorTermLabel: null, priorTermAmount: null, priorQuarterLabel: null, priorQuarterAmount: null, priorCumulativeAmount: null },
  ],
  ...over,
});

const providerOk = { status: "ok", requests: 1, issues: [] };

function evidence(over: Record<string, any> = {}): PublicEvidence {
  const base: any = {
    schemaVersion: "collection-evidence/1",
    ticker: "111110",
    asOf: { input: AS_OF, cutoff: `${AS_OF}T14:59:59.999Z`, dateKst: AS_OF },
    collectedAt: NOW.toISOString(),
    requestsUsed: 3,
    status: "ok",
    modelReady: false,
    untrustedContentNotice: "untrusted",
    providers: { naver: providerOk, naverSearch: { status: "not_configured", requests: 0, issues: [] }, dart: providerOk },
    issues: [],
    company: { name: "Test Co", corpCode: "00123456", exchange: "KOSPI", exchangeVerifiedBy: ["naver", "dart"] },
    market: {
      quote: { ticker: "111110", name: "Test Co", exchange: { code: "KS", name: "코스피", nameEng: "KOSPI" }, close: 50000, currency: "KRW", tradedAt: "2026-01-10T15:30:00+09:00", retrievedAt: NOW.toISOString(), kind: "latest_snapshot", tradedOnAsOfDate: false, sourceUrl: "https://m.stock.naver.com/api/stock/111110/basic" },
      referenceMetrics: [],
      news: [
        { id: "n1", title: "생성형 시장 점유율 확대", snippet: "제품 시장 성장", publishedAt: "2026-01-12T09:00:00+09:00", officeName: "A", url: "https://n.news.naver.com/mnews/article/001/0000000001", originalUrl: null, origin: "naver-stock-news" },
      ],
      searchNews: [],
    },
    filings: {
      list: [filing("20251114000001", "2025-11-14", "Q3", "2025-09-30")],
      statements: [statement("20251114000001")],
      derivedQuarters: [],
      excerpts: [],
      tables: [],
      metricCandidates: [],
      productCandidates: [],
    },
    requiredInputs: [{ field: "marketRevenueQuarterly", status: "missing", detail: "no quarterly market revenue" }],
  };
  return { ...base, ...over, market: { ...base.market, ...(over.market ?? {}) }, filings: { ...base.filings, ...(over.filings ?? {}) } };
}

const ok = (provider: "claude" | "agy") => ({ provider, status: "ok" as const, code: "OK", message: "ok", durationMs: 1 });
const err = (provider: "claude" | "agy", code: string) => ({ provider, status: "error" as const, code, message: `${provider} ${code}`, durationMs: 1 });

function accepted(dataset: Dataset | null = makeDataset(), over: Partial<AnalysisResult> = {}): AnalysisResult {
  return {
    status: dataset ? "accepted" : "partial",
    dataset,
    missingFields: [],
    narrative: { product: "제품 서술", industry: "산업 서술" },
    citations: [],
    assumptions: [],
    disagreements: [],
    providers: { claude: ok("claude"), agy: ok("agy") },
    crossChecked: true,
    estimates: [],
    unavailable: [],
    strategy: { forecast: null, currentConsensus: null, priorConsensus: null, catalyst: null, unavailable: [{ field: "all", code: "NOT_PROVIDED", message: "the model did not provide the required strategy object" }] },
    audit: { issues: [], excludedDocuments: [], auditSummary: "ok", auditedBy: "agy", independentAudit: true, limitations: [] },
    generatedAt: NOW.toISOString(),
    ...over,
  };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function poll(app: TestApp, url: string, headers: Record<string, string> = {}) {
  for (let i = 0; i < 200; i++) {
    const res = await app.inject({ url, headers });
    const body = res.json();
    if (res.statusCode !== 200 || !["queued", "running"].includes(body.status)) return { res, body };
    await sleep(5);
  }
  throw new Error(`job at ${url} did not finish`);
}
const submit = (app: TestApp, payload: Record<string, unknown> = { ticker: "111110", asOf: AS_OF }, headers: Record<string, string> = {}, url = "/v1/analyses") =>
  app.inject({ method: "POST", url, payload, headers });
const gate = () => {
  let release!: () => void;
  const opened = new Promise<void>((r) => (release = r));
  return { opened, release };
};

// Unhandled rejections fail the vitest run on their own, which is exactly the "no unhandled rejection" requirement.

// ---- public analysis: 202 -> complete ---------------------------------------------------------------------------

describe("POST /v1/analyses (public default)", () => {
  it("accepts with 202, polls queued/running -> completed and returns deterministic model output + dual research", async () => {
    const g = gate();
    const collect = vi.fn(async () => {
      await g.opened;
      return evidence();
    });
    const intelligence = vi.fn(async (_i: EvidenceInput) => accepted());
    const { app, dataDir } = await setup({}, NOW, { collect, intelligence });

    const res = await submit(app);
    expect(res.statusCode).toBe(202);
    const job = res.json();
    expect(job).toMatchObject({ status: expect.stringMatching(/queued|running/), deduplicated: false });
    expect(job.statusUrl).toBe(`/v1/analyses/${job.id}`);
    expect(res.headers.location).toBe(job.statusUrl);

    const early = (await app.inject({ url: job.statusUrl })).json();
    expect(["queued", "running"]).toContain(early.status);
    expect(early.request).toEqual({ ticker: "111110", asOf: AS_OF, mode: "public" });
    expect(early.result).toBeUndefined();

    g.release();
    const { body } = await poll(app, job.statusUrl);
    expect(body.status).toBe("completed");
    expect(body.finishedAt).toBeDefined();
    expect(body.expiresAt).toBeDefined();
    const r = body.result;
    expect(r.partialReasons).toEqual([]);
    expect(r.missingInputs).toEqual([]); // resolved: collector gaps stay visible under evidence.requiredInputs
    expect(r.evidence.requiredInputs).toHaveLength(1);
    expect(r.valuation.status).toBe("available");
    expect(r.analysis.targetQuarter).toBe("2026Q1");
    expect(r.analysis.scenarios.map((s: any) => s.scenario)).toEqual(["bear", "base", "bull"]);
    expect(r.analysis.scenarios[1].valuation.targetPriceKRW).toBeGreaterThan(0);
    expect(r.research).toMatchObject({ status: "accepted", providers: { claude: { status: "ok" }, agy: { status: "ok" } }, narrativeReviewed: true, crossChecked: true });
    expect(r.evidence.providers.dart.status).toBe("ok");

    // collector saw the requested date; the model input carries attributable documents only
    expect(collect).toHaveBeenCalledWith({ ticker: "111110", asOf: AS_OF }, expect.objectContaining({ signal: expect.any(AbortSignal) }));
    const docs = intelligence.mock.calls[0]![0].documents;
    const quote = docs.find((d) => d.id === "naver-quote")!;
    expect(quote).toMatchObject({ url: "https://m.stock.naver.com/api/stock/111110/basic", publishedAt: "2026-01-10" });
    const stmt = docs.find((d) => d.id.startsWith("stmt-"))!;
    expect(stmt).toMatchObject({ url: RECEIPT("20251114000001"), publishedAt: "2025-11-14" });
    docs.forEach((d) => expect(EvidenceDocumentSchema.safeParse(d).success).toBe(true));

    // the draft dataset is returned with the result, but never persisted
    expect(r.research.draftDataset).toMatchObject({ status: "reviewed", serverRepaired: false, dataset: { company: { ticker: "111110" } } });
    expect(r.research.draftDataset.dataset).toEqual(makeDataset());
    expect((await app.inject({ url: "/v1/companies/111110" })).statusCode).toBe(404);
    expect(await readFile(path.join(dataDir, "111110.json"), "utf8").catch(() => null)).toBeNull();
    // finite numbers only
    expect(JSON.stringify(r.analysis)).not.toMatch(/NaN|Infinity/);
  });

  it("defaults asOf to the Asia/Seoul calendar date (UTC 20:00 is already the next day in Seoul)", async () => {
    const now = new Date("2026-01-15T20:00:00Z");
    const collect = vi.fn(async () => evidence());
    const { app } = await setup({}, now, { collect, intelligence: async () => accepted(null) });
    const job = (await submit(app, { ticker: "111110" })).json();
    const { body } = await poll(app, job.statusUrl);
    expect(body.request.asOf).toBe("2026-01-16");
    expect(collect.mock.calls[0]![0].asOf).toBe("2026-01-16");
  });

  it("rejects future, malformed or unknown request fields with 400 before any job starts", async () => {
    const collect = vi.fn(async () => evidence());
    const { app } = await setup({}, NOW, { collect });
    const future = await submit(app, { ticker: "111110", asOf: "2026-01-16" });
    expect(future.statusCode).toBe(400);
    expect(future.json().error.code).toBe("INVALID_AS_OF");
    expect((await submit(app, { ticker: "111110", asOf: "2026-01-16" }, {}, "/v1/research")).json().error.code).toBe("INVALID_AS_OF");
    expect((await submit(app, { ticker: "12", asOf: AS_OF })).statusCode).toBe(400);
    expect((await submit(app, { ticker: "111110", asOf: AS_OF, url: "http://evil" })).statusCode).toBe(400);
    expect((await submit(app, { ticker: "111110", asOf: AS_OF, mode: "live" })).statusCode).toBe(400);
    expect(collect).not.toHaveBeenCalled();
  });

  it("keeps explicit demo synchronous while public is the default; there is no manual mode", async () => {
    const demoNow = new Date("2026-09-28T12:00:00Z");
    const { app } = await setup({}, demoNow, { collect: async () => evidence(), intelligence: async () => accepted(null) });
    const demo = await submit(app, { ticker: "005930", asOf: "2026-09-28", mode: "demo" });
    expect(demo.statusCode).toBe(200);
    expect(demo.json()).toMatchObject({ mode: "demo", ticker: "005930" });
    const dflt = await submit(app, { ticker: "005930", asOf: "2026-09-28" });
    expect(dflt.statusCode).toBe(202); // default is the async public job, never demo data
    const manual = await submit(app, { ticker: "005930", asOf: "2026-09-28", mode: "manual" });
    expect(manual.statusCode).toBe(400);
    expect(manual.json().error.code).toBe("VALIDATION_ERROR");
  });

  it("returns 404 for unknown or wrong-kind job ids and 400 for malformed ids", async () => {
    const { app } = await setup({}, NOW, { collect: async () => evidence() });
    expect((await app.inject({ url: "/v1/analyses/00000000-0000-4000-8000-000000000000" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/v1/analyses/not-a-uuid" })).statusCode).toBe(400);
    const r = (await submit(app, { ticker: "111110", asOf: AS_OF }, {}, "/v1/research")).json();
    expect((await app.inject({ url: `/v1/analyses/${r.id}` })).statusCode).toBe(404);
    expect((await poll(app, `/v1/research/${r.id}`)).body.kind).toBe("research");
  });
});

describe("competitors (Korea/US/Japan)", () => {
  it("normalizes ids, passes them to the collector, keys de-duplication on them and rejects other countries", async () => {
    const seen: unknown[] = [];
    const { app } = await setup({}, NOW, { collect: async (input) => (seen.push(input), evidence()) });
    const a = (await submit(app, { ticker: "111110", asOf: AS_OF, competitors: ["us:mu", "US:MU", "jp:8035", "KR:000270"] }, {}, "/v1/research")).json();
    await poll(app, `/v1/research/${a.id}`);
    expect(seen[0]).toEqual({ ticker: "111110", asOf: AS_OF, competitors: ["US:MU", "JP:8035", "KR:000270"] });
    const b = (await submit(app, { ticker: "111110", asOf: AS_OF }, {}, "/v1/research")).json();
    expect(b.id).not.toBe(a.id);
    for (const bad of [["TW:2330"], ["CN:600519"], ["MU"], ["US:A", "US:B", "US:C", "US:D", "US:E", "US:F", "US:G"]])
      expect((await submit(app, { ticker: "111110", asOf: AS_OF, competitors: bad })).statusCode).toBe(400);
    expect((await submit(app, { ticker: "111110", asOf: AS_OF, mode: "demo", competitors: ["US:MU"] })).statusCode).toBe(400);
  });
});

describe("long-poll status", () => {
  it("?wait holds a running job's status until it finishes, returns at once for wait=0, and caps wait at 60s", async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const { app } = await setup({}, NOW, { collect: async () => (await gate, evidence()) });
    const job = (await submit(app, { ticker: "111110", asOf: AS_OF }, {}, "/v1/research")).json();
    const now = await app.inject({ url: `${job.statusUrl}?wait=0` });
    expect(["queued", "running"]).toContain(now.json().status);
    const t0 = Date.now();
    const held = app.inject({ url: `${job.statusUrl}?wait=30` });
    setTimeout(release, 50);
    const done = await held;
    expect(done.json().status).not.toMatch(/queued|running/);
    expect(Date.now() - t0).toBeLessThan(5000); // woke on completion, not after 30s
    expect((await app.inject({ url: `${job.statusUrl}?wait=61` })).statusCode).toBe(400);
  });
});

// ---- partial outcomes -------------------------------------------------------------------------------------------

describe("partial results never carry a valuation", () => {
  const partialCase = async (ev: PublicEvidence, ai: AnalysisResult | (() => Promise<AnalysisResult>), payload: Record<string, unknown> = { ticker: "111110", asOf: AS_OF }, config: object = {}) => {
    const intelligence = vi.fn(typeof ai === "function" ? ai : async () => ai);
    const t = await setup(config, NOW, { collect: async () => ev, intelligence });
    const job = (await submit(t.app, payload)).json();
    const { body } = await poll(t.app, job.statusUrl);
    return { ...t, body, intelligence };
  };
  const noPrices = (body: any) => {
    expect(body.status).toBe("partial");
    expect(body.result.analysis).toBeNull();
    expect(body.result.valuation.status).toBe("unavailable");
    expect(JSON.stringify(body)).not.toMatch(/targetPriceKRW|upsidePct|annualizedEpsKRW/);
  };

  it("missing DART key: Naver quote/news still reported, no valuation, gaps and product/industry findings exposed", async () => {
    const ev = evidence({
      status: "partial",
      providers: { naver: providerOk, naverSearch: { status: "not_configured", issues: [] }, dart: { status: "not_configured", requests: 0, issues: [{ provider: "dart", code: "missing_configuration", severity: "warning", message: "DART_API_KEY is not set" }] } },
      issues: [{ provider: "dart", code: "missing_configuration", severity: "warning", message: "DART_API_KEY is not set" }],
      company: { name: "Test Co", corpCode: null, exchange: "KOSPI", exchangeVerifiedBy: ["naver"] },
      filings: { list: [], statements: [], derivedQuarters: [], excerpts: [], tables: [], metricCandidates: [], productCandidates: [] },
    });
    const partial = accepted(null, {
      missingFields: ["shares.dilutedCommon", "markets[0].observations"],
      narrative: { product: "주력 제품은 반도체", industry: "업황은 회복 국면" },
      audit: { issues: [{ code: "NO_DATASET", path: "dataset", message: "x" }], excludedDocuments: [], auditSummary: null, auditedBy: null, independentAudit: false, limitations: [] },
    });
    const { body, intelligence } = await partialCase(ev, partial);
    noPrices(body);
    const r = body.result;
    expect(r.evidence.quote.close).toBe(50000);
    expect(r.evidence.news).toHaveLength(1);
    expect(r.evidence.providers.dart.status).toBe("not_configured");
    expect(r.research.narrative).toEqual({ product: "주력 제품은 반도체", industry: "업황은 회복 국면" });
    expect(r.research.narrativeReviewed).toBe(false);
    expect(r.missingInputs.map((m: any) => m.field)).toEqual(expect.arrayContaining(["marketRevenueQuarterly", "shares.dilutedCommon", "RESEARCH_NOT_ACCEPTED"]));
    expect(intelligence).toHaveBeenCalledTimes(1); // Naver-only documents still give partial product/industry findings
  });

  it.each([
    ["agy unauthenticated", err("agy", "AUTH_REQUIRED"), "AUTH_REQUIRED"],
    ["agy missing CLI", err("agy", "CLI_NOT_FOUND"), "CLI_NOT_FOUND"],
    ["agy quota", err("agy", "QUOTA"), "QUOTA"],
  ])("%s with no usable dataset: explicit provider status, no valuation", async (_n, agy, code) => {
    const { body } = await partialCase(evidence(), accepted(null, { providers: { claude: ok("claude"), agy } }));
    noPrices(body);
    expect(body.result.research.providers.agy).toMatchObject({ status: "error", code });
    expect(body.result.research.providers.claude.status).toBe("ok");
    expect(body.result.partialReasons.map((r: any) => r.code)).toEqual(expect.arrayContaining(["PROVIDER_ERROR", "RESEARCH_NOT_ACCEPTED"])); // not flagged as expired by the intelligence module: still a failure
  });

  it("an expired agy is skipped: a verified single-model dataset still gets its valuation, flagged as not cross-checked", async () => {
    const unavailable = [{ provider: "agy" as const, code: "QUOTA", message: "agy quota or rate limit reached", retryAfter: "2026-09-29T09:00:00.000Z", skippedWithoutCall: false }];
    const single = accepted(makeDataset(), { status: "single_model", crossChecked: false, providers: { claude: ok("claude"), agy: err("agy", "QUOTA") }, unavailable });
    const { body } = await partialCase(evidence(), single);
    expect(body.status).toBe("completed");
    expect(body.result.analysis.scenarios).toHaveLength(3);
    expect(body.result.partialReasons).toEqual([]);
    expect(body.result.research).toMatchObject({ status: "single_model", crossChecked: false, narrativeReviewed: false, unavailable: [{ provider: "agy", code: "QUOTA" }] });
    expect(body.result.notes.join(" ")).toMatch(/agy 사용 불가\(QUOTA\).*교차검증 없이 claude 단일 모델/);
  });

  it("the report reconciles company + competitors + others with the estimated market and flags what was inferred", async () => {
    const ds = makeDataset();
    const src = { title: "모델 추정", manualReference: "MODEL_ESTIMATE: 점유율 10%로 역산", publishedAt: AS_OF };
    for (const o of ds.markets[0]!.observations) Object.assign(o, { source: src, estimate: { method: "share_implied", basedOn: ["products[0].revenue[3].revenue"], rationale: "회사 점유율 10%" } });
    ds.competitors = [
      { id: "c1", name: "Alpha", marketId: "m1", revenue: ["2025Q1", "2025Q2", "2025Q3", "2025Q4"].map((q) => ({ quarter: q, revenue: 3e8, currency: "USD", basis: "quarterly" as const, source: { ...src, manualReference: "MODEL_ESTIMATE: 지식" }, estimate: { method: "model_knowledge" as const, basedOn: [], rationale: "분석가 지식" } })) },
    ];
    const single = accepted(ds, { status: "single_model", crossChecked: false, audit: { issues: [], excludedDocuments: [], auditSummary: "ok", auditedBy: "claude", independentAudit: false, limitations: [] }, providers: { claude: ok("claude"), agy: err("agy", "QUOTA") }, unavailable: [{ provider: "agy", code: "QUOTA", message: "m", retryAfter: "2026-09-29T09:00:00.000Z", skippedWithoutCall: true }] });
    const { body } = await partialCase(evidence(), single);
    expect(body.status).toBe("completed");
    const r = body.result.report;
    expect(r.reconciliation).toMatchObject({ allPartsSumToMarket: true, competitorsScaledInMarkets: [] });
    const p = r.players[0];
    expect(p.observed.company.share).toBeCloseTo(0.1);
    expect(p.observed.competitors[0]).toMatchObject({ name: "Alpha", estimated: true });
    expect(p.observed.others.share).toBeCloseTo(0.6);
    expect(p.projected.base.company.share + p.projected.base.competitors[0].share + p.projected.base.others.share).toBeCloseTo(1);
    expect(r.markets[0].latestObserved).toMatchObject({ estimated: true, method: "share_implied" });
    expect(r.quality).toMatchObject({ estimatedInputs: 8, totalInputs: 12, crossChecked: false, auditedBy: "claude", independentAudit: false, dataGrounding: "low", knowledgeOnlyEstimates: 4 });
    const text = r.lines.join("\n");
    expect(text).toMatch(/목표가/);
    expect(text).toMatch(/추정 — share_implied/);
    expect(text).toMatch(/합계 = 시장 규모/);
    expect(text).toMatch(/8개\(67%\)가 .*추정치/);
    expect(text).toMatch(/자체 감사/);
    expect(text).toMatch(/데이터 근거 수준: 낮음.*배경지식만으로 만든 추정 4건/);
    expect(body.result.research.estimates).toEqual([]);
  });

  it("an expired provider is a note, not a failure reason: the job is partial only because no dataset was accepted", async () => {
    const { body } = await partialCase(evidence(), accepted(null, { providers: { claude: ok("claude"), agy: err("agy", "QUOTA") }, unavailable: [{ provider: "agy", code: "QUOTA", message: "m", retryAfter: "2026-09-29T09:00:00.000Z", skippedWithoutCall: false }] }));
    noPrices(body);
    expect(body.result.partialReasons.map((r: any) => r.code)).toEqual(["RESEARCH_NOT_ACCEPTED"]);
    expect(body.result.notes.join(" ")).toMatch(/agy 사용 불가\(QUOTA\)/);
    expect(body.result.notes.join(" ")).not.toMatch(/단일 모델 결과/);
  });

  it("gates a dataset from an unapproved review even if the intelligence module returned one", async () => {
    const { body } = await partialCase(evidence(), accepted(makeDataset(), { status: "partial" }));
    noPrices(body);
  });

  it("provider exceptions become partial with a sanitized message (no stack, no secrets)", async () => {
    const secret = "TOPSECRETKEY-123456";
    const { body } = await partialCase(
      evidence(),
      async () => {
        throw new Error(`spawn failed with key ${secret}\n    at secret/stack.ts:1:1`);
      },
      { ticker: "111110", asOf: AS_OF },
      { secrets: () => [secret] },
    );
    noPrices(body);
    expect(body.result.partialReasons[0].code).toBe("INTELLIGENCE_ERROR");
    const text = JSON.stringify(body);
    expect(text).not.toContain(secret);
    expect(text).not.toContain("stack.ts");
  });

  it("collector exceptions fail the job with a sanitized error and keep polling usable", async () => {
    const secret = "DARTKEY-abcdef";
    const t = await setup({ secrets: () => [secret] }, NOW, {
      collect: async () => {
        throw new Error(`upstream https://opendart.fss.or.kr/api/x.json?crtfc_key=${secret} exploded`);
      },
    });
    const job = (await submit(t.app)).json();
    const { body } = await poll(t.app, job.statusUrl);
    expect(body.status).toBe("failed");
    expect(body.error.code).toBe("COLLECTION_FAILED");
    expect(JSON.stringify(body)).not.toContain(secret);
    expect(body.result).toBeUndefined();
  });

  it("invalid collector input maps to COLLECTION_INPUT_INVALID", async () => {
    const t = await setup({}, NOW, {
      collect: async () => {
        const e = new Error("bad ticker");
        e.name = "CollectionInputError";
        throw e;
      },
    });
    const { body } = await poll(t.app, (await submit(t.app)).json().statusUrl);
    expect(body).toMatchObject({ status: "failed", error: { code: "COLLECTION_INPUT_INVALID" } });
  });

  it("rejects a non-KOSPI listing as failed and never calls the models", async () => {
    const ev = evidence({ company: { name: "X", corpCode: null, exchange: null, exchangeVerifiedBy: [] }, issues: [{ provider: "naver", code: "not_kospi", severity: "error", message: "KOSDAQ" }] });
    const { body, intelligence } = await partialCase(ev, accepted());
    expect(body).toMatchObject({ status: "failed", error: { code: "NOT_KOSPI" } });
    expect(intelligence).not.toHaveBeenCalled();
  });

  it("unverified exchange is a warning: the valuation is produced but graded provisional", async () => {
    const { body } = await partialCase(evidence({ company: { name: "X", corpCode: null, exchange: null, exchangeVerifiedBy: [] } }), accepted());
    expect(body.status).toBe("partial");
    expect(body.result.analysis.scenarios).toHaveLength(3);
    expect(body.result.valuation).toMatchObject({ status: "available", grade: "provisional" });
    expect(body.result.partialReasons).toEqual([expect.objectContaining({ code: "EXCHANGE_UNVERIFIED", severity: "warning" })]);
  });

  it("dataset ticker must equal the request ticker", async () => {
    const ds = makeDataset();
    ds.company.ticker = "222220";
    const { body } = await partialCase(evidence(), accepted(ds));
    noPrices(body);
    expect(body.result.partialReasons.map((r: any) => r.code)).toContain("DATASET_TICKER_MISMATCH");
  });

  it("runs static + as-of validation on the proposed dataset: soft issues keep a provisional price", async () => {
    const ds = makeDataset();
    ds.financials.totalRevenueKRW = 2.5e11; // products explain 40% => coverage insufficient (residual assumptions exist)
    const { body } = await partialCase(evidence(), accepted(ds));
    expect(body.result.valuation).toMatchObject({ status: "available", grade: "provisional" });
    const reason = body.result.partialReasons.find((r: any) => r.code === "DATA_VALIDATION_WARNINGS");
    expect(reason.severity).toBe("warning");
    expect(reason.details.map((i: any) => i.code)).toContain("COVERAGE_INSUFFICIENT");
  });

  it("hard validation issues still block the valuation", async () => {
    const ds = makeDataset();
    ds.products[0].revenue[3].revenue = 2e9; // product revenue above the whole market => invalid share
    const { body } = await partialCase(evidence(), accepted(ds));
    noPrices(body);
    const reason = body.result.partialReasons.find((r: any) => r.code === "DATA_VALIDATION_FAILED");
    expect(reason.severity).toBe("blocking");
    expect(reason.details.map((i: any) => i.code)).toContain("INVALID_SHARE");
  });

  it("repairs a missing residual, out-of-range share bounds and unsorted series instead of refusing a price", async () => {
    const ds = makeDataset();
    delete ds.residual;
    ds.products[0].shareBounds = { min: 0.2, max: 0.3 }; // observed share 0.1
    ds.markets[0].observations.reverse();
    const { body } = await partialCase(evidence(), accepted(ds));
    expect(body.result.valuation).toMatchObject({ status: "available", grade: "provisional" });
    const repaired = body.result.partialReasons.find((r: any) => r.code === "DATASET_REPAIRED");
    expect(repaired.details.map((r: any) => r.code)).toEqual(expect.arrayContaining(["RESIDUAL_ASSUMED", "SHARE_BOUNDS_WIDENED", "SERIES_SORTED"]));
    expect(body.result.analysis.assumptions.residual).toMatchObject({ annualGrowth: { bear: 0, base: 0, bull: 0 }, operatingMargin: { base: 0.2 } });
    expect(body.result.analysis.scenarios[1].products[0].revenueShare).toBeCloseTo(0.1);
  });

  it("a draft the review did not accept is valued provisionally when it passed the hard checks", async () => {
    const issues = [{ code: "AUDIT_UNCONFIRMED", path: "quote.priceKRW", message: "not confirmed" }];
    const draft = accepted(null, { status: "partial", provisionalDataset: makeDataset(), audit: { issues, excludedDocuments: [], auditSummary: "x", auditedBy: "agy", independentAudit: true, limitations: [] } });
    const { body } = await partialCase(evidence(), draft);
    expect(body.status).toBe("partial");
    expect(body.result.valuation).toMatchObject({ status: "available", grade: "provisional" });
    const reason = body.result.partialReasons.find((r: any) => r.code === "RESEARCH_PROVISIONAL");
    expect(reason).toMatchObject({ severity: "warning", details: [{ code: "AUDIT_UNCONFIRMED", path: "quote.priceKRW" }] });
    expect(body.result.research.draftDataset).toMatchObject({ status: "provisional", dataset: { company: { ticker: "111110" } } });
  });

  it("returns the raw draft dataset as rejected when the review produced no usable dataset", async () => {
    const raw = { ...makeDataset(), quote: { priceKRW: -1 } };
    const draft = accepted(null, { status: "rejected", draftDataset: raw });
    const { body } = await partialCase(evidence(), draft);
    noPrices(body);
    expect(body.result.partialReasons.map((r: any) => r.code)).toContain("RESEARCH_NOT_ACCEPTED");
    expect(body.result.research.draftDataset).toEqual({ status: "rejected", serverRepaired: false, dataset: raw });
  });

  it("reports no draft dataset when the models produced none", async () => {
    const { body } = await partialCase(evidence(), accepted(null, { status: "unavailable" }));
    expect(body.result.research.draftDataset).toBeNull();
  });

  it("a provider error next to a provisional dataset is a warning, not a block", async () => {
    const draft = accepted(null, { status: "partial", provisionalDataset: makeDataset(), providers: { claude: ok("claude"), agy: err("agy", "SCHEMA_INVALID") } });
    const { body } = await partialCase(evidence(), draft);
    expect(body.result.valuation.grade).toBe("provisional");
    expect(body.result.partialReasons.map((r: any) => [r.code, r.severity])).toEqual(expect.arrayContaining([["PROVIDER_ERROR", "warning"], ["RESEARCH_PROVISIONAL", "warning"]]));
  });

  it("rejects schema-invalid datasets from the intelligence module", async () => {
    const ds = makeDataset() as any;
    ds.company.exchange = "KOSDAQ";
    const { body } = await partialCase(evidence(), accepted(ds));
    noPrices(body);
    expect(body.result.partialReasons.map((r: any) => r.code)).toContain("DATASET_SCHEMA_INVALID");
  });

  it("replaces a dataset quote that differs (price OR trade date in KST) from the collected Naver quote", async () => {
    const price = makeDataset();
    price.quote.priceKRW = 49_000;
    const p = (await partialCase(evidence(), accepted(price))).body.result;
    expect(p.partialReasons).toEqual([expect.objectContaining({ code: "DATASET_QUOTE_REPLACED", severity: "warning" })]);
    expect(p.analysis.facts.quote).toEqual({ priceKRW: 50_000, asOf: "2026-01-10" });
    const day = makeDataset();
    day.quote.asOf = "2026-01-09";
    expect((await partialCase(evidence(), accepted(day))).body.result.partialReasons.map((r: any) => r.code)).toContain("DATASET_QUOTE_REPLACED");
    // a UTC timestamp for the same KST day is accepted
    const utc = evidence();
    utc.market.quote!.tradedAt = "2026-01-10T06:30:00Z"; // 15:30 KST same day
    expect((await partialCase(utc, accepted())).body.status).toBe("completed");
  });

  it("historical asOf without a dated quote is clearly partial (Naver only serves the latest snapshot)", async () => {
    const ev = evidence({ market: { quote: null } });
    const { body } = await partialCase(ev, accepted(null), { ticker: "111110", asOf: "2026-01-05" });
    noPrices(body);
    const reason = body.result.partialReasons.find((r: any) => r.code === "HISTORICAL_QUOTE_UNAVAILABLE");
    expect(reason.message).toContain("latest quote snapshot");
  });

  it("current-day request with no quote reports QUOTE_MISSING", async () => {
    const { body } = await partialCase(evidence({ market: { quote: null } }), accepted(null));
    expect(body.result.partialReasons.map((r: any) => r.code)).toContain("QUOTE_MISSING");
  });

  it("non-positive common earnings: valuation reflects the scenarios (partial), analysis kept, job partial", async () => {
    const ds = makeDataset();
    ds.products[0].operatingMargin.value = { bear: -0.3, base: 0.2, bull: 0.3 };
    ds.residual!.value.operatingMargin = { bear: -0.3, base: 0.1, bull: 0.1 };
    const { body } = await partialCase(evidence(), accepted(ds));
    expect(body.status).toBe("partial");
    expect(body.result.valuation).toEqual({ status: "partial", scenarios: { bear: "unavailable", base: "available", bull: "available" }, grade: "verified" });
    expect(body.result.analysis.scenarios[0].valuation.status).toBe("unavailable");
    expect(body.result.partialReasons.map((r: any) => r.code)).toContain("VALUATION_UNAVAILABLE");
    expect(JSON.stringify(body.result.analysis)).not.toMatch(/NaN|Infinity/);
  });

  it("no evidence documents at all: partial, models not invoked", async () => {
    const ev = evidence({ market: { quote: null, news: [] }, filings: { list: [], statements: [] } });
    const { body, intelligence } = await partialCase(ev, accepted());
    noPrices(body);
    expect(intelligence).not.toHaveBeenCalled();
    expect(body.result.partialReasons.map((r: any) => r.code)).toContain("NO_EVIDENCE_DOCUMENTS");
  });
});

// ---- evidence-only research ------------------------------------------------------------------------------------

describe("POST /v1/research (evidence only)", () => {
  it("collects evidence without invoking Claude/agy and never returns a valuation", async () => {
    const intelligence = vi.fn(async () => accepted());
    const { app } = await setup({}, NOW, { collect: async () => evidence(), intelligence });
    const res = await submit(app, { ticker: "111110", asOf: AS_OF }, {}, "/v1/research");
    expect(res.statusCode).toBe(202);
    const job = res.json();
    expect(job.statusUrl).toBe(`/v1/research/${job.id}`);
    const { body } = await poll(app, job.statusUrl);
    expect(body).toMatchObject({ kind: "research", status: "completed" });
    expect(body.result).toMatchObject({ llmInvoked: false, ticker: "111110" });
    expect(body.result.evidence.market.quote.close).toBe(50000);
    expect(body.result.documents.sentToModelsIfAnalysed.length).toBeGreaterThan(0);
    expect(body.result.missingInputs[0]).toMatchObject({ source: "collector", field: "marketRevenueQuarterly" });
    expect(JSON.stringify(body)).not.toMatch(/targetPriceKRW|scenarios/);
    expect(intelligence).not.toHaveBeenCalled();
  });

  it("partial evidence maps to partial, total failure to failed, not-KOSPI to failed", async () => {
    const run = async (ev: PublicEvidence) => {
      const { app } = await setup({}, NOW, { collect: async () => ev });
      return (await poll(app, (await submit(app, { ticker: "111110", asOf: AS_OF }, {}, "/v1/research")).json().statusUrl)).body;
    };
    expect((await run(evidence({ status: "partial" }))).status).toBe("partial");
    const failed = await run(evidence({ status: "failed" }));
    expect(failed).toMatchObject({ status: "failed", error: { code: "COLLECTION_FAILED" } });
    expect(failed.result.evidence).toBeDefined();
    expect((await run(evidence({ issues: [{ provider: "naver", code: "not_kospi", severity: "error", message: "x" }] }))).error.code).toBe("NOT_KOSPI");
  });
});

// ---- auth --------------------------------------------------------------------------------------------------------

describe("API_KEY protects costly jobs and mutations", () => {
  it("requires x-api-key for public analyses, research and job results; demo stays open", async () => {
    const t = await setup({ apiKey: "s3cret-key" }, new Date("2026-09-28T12:00:00Z"), { collect: async () => evidence(), intelligence: async () => accepted(null) });
    const key = { "x-api-key": "s3cret-key" };
    expect((await submit(t.app, { ticker: "111110", asOf: "2026-09-28" })).statusCode).toBe(401);
    expect((await submit(t.app, { ticker: "111110", asOf: "2026-09-28" }, {}, "/v1/research")).statusCode).toBe(401);
    expect((await submit(t.app, { ticker: "111110", asOf: "2026-09-28" }, { "x-api-key": "nope" })).statusCode).toBe(401);
    expect((await submit(t.app, { ticker: "005930", asOf: "2026-09-28", mode: "demo" })).statusCode).toBe(200);

    const started = await submit(t.app, { ticker: "111110", asOf: "2026-09-28" }, key);
    expect(started.statusCode).toBe(202);
    const url = started.json().statusUrl;
    expect((await t.app.inject({ url })).statusCode).toBe(401);
    expect((await t.app.inject({ url, headers: { "x-api-key": "wrong" } })).body).not.toContain("s3cret-key");
    expect((await poll(t.app, url, key)).res.statusCode).toBe(200);
    const r = await submit(t.app, { ticker: "111110", asOf: "2026-09-28" }, key, "/v1/research");
    expect(r.statusCode).toBe(202);
    expect((await t.app.inject({ url: r.json().statusUrl })).statusCode).toBe(401);
  });

  it("health exposes only booleans about integrations, never key material", async () => {
    const config = loadConfig({ DART_API_KEY: "DARTSECRETVALUE", NAVER_CLIENT_ID: "id-value", NAVER_CLIENT_SECRET: "sec-value", API_KEY: "APIKEYVALUE", EDINET_API_KEY: "EDINETSECRET" });
    const { app } = await setup({ capabilities: config.capabilities, apiKey: config.apiKey });
    const body = (await app.inject({ url: "/health" })).body;
    expect(JSON.parse(body).capabilities).toEqual({ dartConfigured: true, naverSearchConfigured: true, secConfigured: false, edinetConfigured: true });
    for (const v of ["DARTSECRETVALUE", "sec-value", "APIKEYVALUE", "EDINETSECRET"]) expect(body).not.toContain(v);
    expect(config.secrets()).toEqual(expect.arrayContaining(["DARTSECRETVALUE", "APIKEYVALUE", "EDINETSECRET"]));
  });
});

describe("config: coherent job/call timeout budget", () => {
  it("derives the outer job timeout default from the per-call timeout when RESEARCH_JOB_TIMEOUT_MS is unset", () => {
    // default per-call 600_000 * 7 sequential calls + 300_000 overhead = 4_500_000
    expect(loadConfig({}).jobs.jobTimeoutMs).toBe(4_500_000);
    // a larger explicit per-call timeout derives a larger job budget too, instead of leaving an unrelated fixed
    // default to fight it.
    expect(loadConfig({ INTELLIGENCE_TIMEOUT_MS: "900000" }).jobs.jobTimeoutMs).toBe(900_000 * 7 + 300_000);
  });

  it("an explicit RESEARCH_JOB_TIMEOUT_MS is always honored as-is, even when it looks too small for a worst-case sequential run", () => {
    expect(loadConfig({ RESEARCH_JOB_TIMEOUT_MS: "500000" }).jobs.jobTimeoutMs).toBe(500_000);
    // explicit + explicit + incompatible: diagnosed with a warning, never thrown, never silently reinterpreted.
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      const cfg = loadConfig({ INTELLIGENCE_TIMEOUT_MS: "600000", RESEARCH_JOB_TIMEOUT_MS: "900000" });
      expect(cfg.jobs.jobTimeoutMs).toBe(900_000); // honored exactly as set, not raised to fit
      expect(warn.mock.calls.some((c) => String(c[0]).includes("DIAGNOSTIC"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });
});

// ---- queue, dedup, ttl, shutdown --------------------------------------------------------------------------------

describe("bounded jobs", () => {
  it("de-duplicates equivalent in-flight requests but starts a new job after completion", async () => {
    const g = gate();
    const collect = vi.fn(async () => {
      await g.opened;
      return evidence();
    });
    const { app } = await setup({}, NOW, { collect, intelligence: async () => accepted(null) });
    const a = (await submit(app)).json();
    const b = (await submit(app)).json();
    expect(b).toMatchObject({ id: a.id, deduplicated: true });
    const other = (await submit(app, { ticker: "222220", asOf: AS_OF })).json();
    expect(other.id).not.toBe(a.id);
    const research = (await submit(app, { ticker: "111110", asOf: AS_OF }, {}, "/v1/research")).json();
    expect(research.id).not.toBe(a.id); // different kind => different job
    g.release();
    await poll(app, a.statusUrl);
    await poll(app, other.statusUrl);
    const again = (await submit(app)).json();
    expect(again.id).not.toBe(a.id);
    expect(again.deduplicated).toBe(false);
    await poll(app, again.statusUrl);
    expect(collect).toHaveBeenCalledTimes(4);
  });

  it("caps running + pending jobs (429 QUEUE_FULL) and drains the queue in order", async () => {
    const g = gate();
    const started: string[] = [];
    const collect = vi.fn(async ({ ticker }: { ticker: string }) => {
      started.push(ticker);
      await g.opened;
      return evidence({ ticker });
    });
    const jobs = { maxRunning: 1, maxPending: 1, maxRetained: 50, ttlMs: 60_000, jobTimeoutMs: 10_000 };
    const { app } = await setup({ jobs }, NOW, { collect, intelligence: async () => accepted(null) });
    const j1 = await submit(app, { ticker: "111110", asOf: AS_OF });
    const j2 = await submit(app, { ticker: "222220", asOf: AS_OF });
    const j3 = await submit(app, { ticker: "333330", asOf: AS_OF });
    expect([j1.statusCode, j2.statusCode, j3.statusCode]).toEqual([202, 202, 429]);
    expect(j3.json().error.code).toBe("QUEUE_FULL");
    await sleep(20);
    expect((await app.inject({ url: j2.json().statusUrl })).json().status).toBe("queued");
    expect(started).toEqual(["111110"]);
    expect((await app.inject({ url: "/health" })).json().jobs).toMatchObject({ running: 1, pending: 1 });
    g.release();
    expect((await poll(app, j1.json().statusUrl)).body.status).toMatch(/completed|partial/);
    expect((await poll(app, j2.json().statusUrl)).body.status).toMatch(/completed|partial/);
    expect(started).toEqual(["111110", "222220"]);
    expect((await submit(app, { ticker: "333330", asOf: AS_OF })).statusCode).toBe(202); // capacity is back
  });

  it("expires finished jobs after the TTL and caps retained jobs (no timers involved)", async () => {
    let now = NOW.getTime();
    const jobs = { maxRunning: 2, maxPending: 5, maxRetained: 2, ttlMs: 10_000, jobTimeoutMs: 10_000 };
    const t = await setup({ jobs, now: () => new Date(now) }, NOW, { collect: async ({ ticker }) => evidence({ ticker }), intelligence: async () => accepted(null), now: () => new Date(now) });
    const ids: string[] = [];
    for (const ticker of ["111110", "222220", "333330"]) {
      const j = (await submit(t.app, { ticker, asOf: AS_OF })).json();
      await poll(t.app, j.statusUrl);
      ids.push(j.statusUrl);
      now += 1;
    }
    expect((await t.app.inject({ url: ids[0]! })).statusCode).toBe(404); // evicted by maxRetained=2
    expect((await t.app.inject({ url: ids[2]! })).statusCode).toBe(200);
    now += 10_000;
    const gone = await t.app.inject({ url: ids[2]! });
    expect(gone.statusCode).toBe(404);
    expect(gone.json().error.code).toBe("JOB_NOT_FOUND");
    expect(gone.json().error.message).toContain("lost on restart");
    expect(t.research.jobs.stats().retained).toBe(0);
  });

  it("abandons jobs that exceed the job timeout and aborts the collector signal", async () => {
    let aborted = false;
    const jobs = { maxRunning: 1, maxPending: 1, maxRetained: 10, ttlMs: 60_000, jobTimeoutMs: 40 };
    const t = await setup({ jobs }, NOW, {
      collect: (_i, { signal }) =>
        new Promise((_res, rej) => {
          signal.addEventListener("abort", () => {
            aborted = true;
            rej(signal.reason);
          });
        }),
    });
    const { body } = await poll(t.app, (await submit(t.app)).json().statusUrl);
    expect(body).toMatchObject({ status: "failed", error: { code: "JOB_TIMEOUT" } });
    expect(aborted).toBe(true);
    // the slot is free again
    expect((await submit(t.app, { ticker: "222220", asOf: AS_OF })).statusCode).toBe(202);
  });

  it("job timeout also abandons models that ignore the signal", async () => {
    const jobs = { maxRunning: 1, maxPending: 1, maxRetained: 10, ttlMs: 60_000, jobTimeoutMs: 40 };
    const t = await setup({ jobs }, NOW, { collect: async () => evidence(), intelligence: () => new Promise<AnalysisResult>(() => {}) });
    const { body } = await poll(t.app, (await submit(t.app)).json().statusUrl);
    expect(body).toMatchObject({ status: "failed", error: { code: "JOB_TIMEOUT" } });
  });

  it("app.close() aborts running jobs (CLI children get the signal), fails queued ones and rejects new work", async () => {
    const signals: AbortSignal[] = [];
    const jobs = { maxRunning: 1, maxPending: 2, maxRetained: 10, ttlMs: 60_000, jobTimeoutMs: 60_000 };
    const t = await setup({ jobs }, NOW, {
      collect: async () => evidence(),
      intelligence: (_i, { signal }) =>
        new Promise<AnalysisResult>((_res, rej) => {
          signals.push(signal);
          signal.addEventListener("abort", () => rej(signal.reason));
        }),
    });
    const running = (await submit(t.app, { ticker: "111110", asOf: AS_OF })).json();
    const queued = (await submit(t.app, { ticker: "222220", asOf: AS_OF })).json();
    for (let i = 0; i < 100 && signals.length === 0; i++) await sleep(5);
    expect(signals).toHaveLength(1);
    await t.app.close();
    expect(signals[0]!.aborted).toBe(true);
    expect(() => t.research.startAnalysis({ ticker: "333330", asOf: AS_OF })).toThrowError(/shutting down/);
    const view = (id: string) => t.research.getJob(id, "analysis");
    expect(view(running.id)).toMatchObject({ status: "failed", error: { code: "SERVER_CLOSING" } });
    expect(view(queued.id)).toMatchObject({ status: "failed", error: { code: "SERVER_CLOSING" } });
  });
});

// ---- evidence -> documents -----------------------------------------------------------------------------------------

describe("evidence documents", () => {
  it("converts any timestamp to the Asia/Seoul calendar date", () => {
    expect(kstDate("2026-01-14T16:00:00Z")).toBe("2026-01-15"); // 01:00 KST next day
    expect(kstDate("2026-01-15T14:59:59Z")).toBe("2026-01-15");
    expect(kstDate("2026-01-15T00:30:00+09:00")).toBe("2026-01-15");
    expect(kstDate("garbage")).toBe("");
  });

  it("turns exchange disclosures into model documents dated/linked by their own DART receipt", () => {
    const ev = evidence();
    ev.filings.disclosures = [{ rceptNo: "20260105900001", receiptUrl: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260105900001", reportName: "기업설명회(IR)개최(안내공시)", receivedDate: "2026-01-05", kind: "earnings_schedule", isCorrection: false, text: "1. 개최일자 | 2026-01-30 / 2. 개최목적 | 2025년 4분기 경영실적 발표", truncated: false }];
    const doc = buildDocuments(ev).documents.find((d) => d.id === "dsc-20260105900001")!;
    expect(doc).toMatchObject({ url: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20260105900001", publishedAt: "2026-01-05", title: "DART 거래소 공시 - 기업설명회(IR)개최(안내공시)" });
    expect(doc.text).toContain("애널리스트 컨센서스가 아님");
    expect(doc.text).toContain("1. 개최일자 | 2026-01-30 / 2. 개최목적 | 2025년 4분기 경영실적 발표");
  });

  it("turns share totals, FX rates, the PER band and annual consensus into attributable documents", () => {
    const ev = evidence();
    ev.filings.shareCounts = [{ fiscalYear: 2025, period: "Q3", periodEnd: "2025-09-30", rceptNo: "20251114000001", receiptUrl: RECEIPT("20251114000001"), receivedDate: "2025-11-14",
      classes: [{ kind: "common", label: "보통주", issued: 1_000_000, treasury: 10_000, outstanding: 990_000 }, { kind: "preferred", label: "우선주", issued: 50_000, treasury: 0, outstanding: 50_000 }] }];
    ev.market.fxRates = [{ currency: "USD", krwPerUnit: 1380.1234, rateDate: "2026-01-09", source: "ECB", sourceUrl: "https://api.frankfurter.dev/v1/2026-01-09?base=EUR&symbols=KRW,USD" }];
    ev.market.perReference = { ttmEpsKRW: 5000, quarters: ["2025Q1", "2025Q2", "2025Q3", "2025Q4"], latestClose: { date: "2026-01-09", closeKRW: 50000 }, current: 10, window: { from: "2025-07-01", to: "2026-01-09", sessions: 120, min: 8, median: 9.5, max: 12 }, sourceUrls: ["https://m.stock.naver.com/api/stock/111110/price"] };
    ev.market.annualFinance = [
      { ticker: "111110", period: "2024.12", isConsensus: false, revenueKRW: 1e12, operatingProfitKRW: 1e11, netIncomeKRW: null, epsKRW: null, observedAt: NOW.toISOString(), sourceUrl: "https://m.stock.naver.com/api/stock/111110/finance/annual" },
      { ticker: "111110", period: "2025.12", isConsensus: true, revenueKRW: 1.1e12, operatingProfitKRW: null, netIncomeKRW: null, epsKRW: 5000, observedAt: NOW.toISOString(), sourceUrl: "https://m.stock.naver.com/api/stock/111110/finance/annual" },
    ];
    const built = buildDocuments(ev);
    const doc = (id: string) => built.documents.find((d) => d.id === id)!;
    expect(doc("shr-20251114000001")).toMatchObject({ url: RECEIPT("20251114000001"), publishedAt: "2025-11-14" });
    expect(doc("shr-20251114000001").text).toContain("보통주 [보통주] | 발행주식총수 1,000,000주 | 자기주식수 10,000주 | 유통주식수 990,000주");
    expect(doc("fx-ecb-2026-01-09")).toMatchObject({ publishedAt: "2026-01-09" });
    expect(doc("fx-ecb-2026-01-09").text).toContain("1 USD = 1,380.1234 KRW");
    expect(doc("naver-per-band").text).toContain("후행 PER 10배");
    expect(doc("naver-per-band").text).toContain("최저 8배, 중앙 9.5배, 최고 12배");
    expect(doc("naver-annual").text).toContain("2025.12 [컨센서스] 매출액 1,100,000,000,000 원");
    expect(doc("naver-annual").text).toContain("(매출 전년 대비 10%)");
    // share totals and FX ride with the quote, ahead of statements
    const ids = built.documents.map((d) => d.id);
    expect(ids.indexOf("fx-ecb-2026-01-09")).toBeLessThan(ids.findIndex((i) => i.startsWith("stmt-")));
  });

  it("dates the quote by its KST trade date, not by slicing a UTC string", () => {
    const ev = evidence();
    ev.market.quote!.tradedAt = "2026-01-14T16:00:00Z";
    const doc = buildDocuments(ev).documents.find((d) => d.id === "naver-quote")!;
    expect(doc.publishedAt).toBe("2026-01-15");
    expect(doc.text).toContain("50,000");
    const bad = evidence();
    bad.market.quote!.tradedAt = "nonsense";
    expect(buildDocuments(bad).documents.find((d) => d.id === "naver-quote")).toBeUndefined();
  });

  it("statement text keeps row currency and decimals and labels BS/CF/per-share rows correctly", () => {
    const text = buildDocuments(evidence()).documents.find((d) => d.id.startsWith("stmt-"))!.text;
    expect(text).toContain("원(KRW)으로 가정하지 않습니다"); // header never assumes KRW for every row
    expect(text).toContain("[KRW]"); // revenue row currency preserved
    expect(text).toContain("74,068,313,000,000");
    expect(text).toMatch(/매출액.*당기\(해당 3개월\(분기\)/);
    expect(text).toContain("1,234.56"); // decimals not rounded
    expect(text).toMatch(/기본주당이익.*\[KRW, 비화폐\/주당·주식수·비율\].*당기 값\(기간 성격 미확인/);
    expect(text).toMatch(/자산총계.*\[USD\].*기말 잔액\(시점/); // BS is a snapshot in its own currency
    expect(text).toContain("5,000,000.25");
    expect(text).toMatch(/영업활동현금흐름.*\[통화 미상\].*공시 제공 기준/); // unknown currency is explicit
    expect(text).not.toMatch(/자산총계.*3개월/);
    expect(text).not.toMatch(/영업활동현금흐름.*3개월/);
  });

  const derived = (annual: FilingEvidence, q3: FilingEvidence) =>
    evidence({
      filings: {
        list: [annual, q3],
        statements: [],
        derivedQuarters: [
          { fiscalYear: 2025, quarter: 4, periodEnd: "2025-12-31", fsDiv: "CFS", method: "annual_minus_q3_cumulative", annualRceptNo: annual.rceptNo, q3RceptNo: q3.rceptNo, verificationStatus: "derived", rows: [{ statement: "IS", accountId: "ifrs-full_Revenue", accountName: "매출액", currency: "KRW", amount: 10, annualAmount: 40, q3CumulativeAmount: 30 }] },
        ],
      },
    });

  it("derived Q4 documents cite the ANNUAL receipt/date and name both source receipts", () => {
    const annual = filing("20260310000009", "2026-03-10", "FY", "2025-12-31");
    const q3 = filing("20251114000001", "2025-11-14", "Q3", "2025-09-30");
    const doc = buildDocuments(derived(annual, q3)).documents.find((d) => d.id.startsWith("drv-"))!;
    expect(doc).toMatchObject({ url: annual.receiptUrl, publishedAt: "2026-03-10" });
    expect(doc.text).toContain(annual.receiptUrl);
    expect(doc.text).toContain(q3.receiptUrl);
    expect(doc.text).toContain("2025-11-14");
    expect(doc.text).toContain("[KRW]");
  });

  it("withholds a Q4 derivation when the Q3 report was (re)filed after the annual report or is a correction", () => {
    const annual = filing("20260310000009", "2026-03-10", "FY", "2025-12-31");
    const lateQ3 = filing("20260320000002", "2026-03-20", "Q3", "2025-09-30", { isCorrection: true });
    expect(buildDocuments(derived(annual, lateQ3)).documents.find((d) => d.id.startsWith("drv-"))).toBeUndefined();
    const corrQ3 = filing("20251201000002", "2025-12-01", "Q3", "2025-09-30", { isCorrection: true });
    expect(buildDocuments(derived(annual, corrQ3)).documents.find((d) => d.id.startsWith("drv-"))).toBeUndefined();
  });

  it("uses fetched article text when present, prioritises product/market coverage, and labels snippets", () => {
    const news = (id: string, title: string, snippet: string, over: object = {}) => ({ id, title, snippet, publishedAt: "2026-01-12T09:00:00+09:00", officeName: null, url: `https://n.news.naver.com/mnews/article/001/00000${id}`, originalUrl: null, origin: "naver-stock-news" as const, ...over });
    const items = Array.from({ length: 14 }, (_, i) => news(String(100 + i), `일반 주가 ${i}`, "주가 등락"));
    items.push(news("999", "반도체 시장 점유율 성장", "짧음", { articleText: "글로벌 시장 규모 점유율 성장 전망 ".repeat(20), articleTruncated: true, publishedAt: "2026-01-01T09:00:00+09:00" }));
    const docs = buildDocuments(evidence({ market: { news: items } })).documents.filter((d) => d.id.startsWith("news-"));
    expect(docs.length).toBeLessThanOrEqual(10);
    expect(docs[0]!.id).toBe("news-n-999"); // older, but about the product market => first
    expect(docs[0]!.text).toContain("기사 본문 발췌(잘림)");
    expect(docs[0]!.text).toContain("글로벌 시장 규모");
    expect(docs[1]!.text).toContain("짧은 스니펫만 확보");
    expect(docs[0]!.text).toContain("검증되지 않은 보도");
  });

  it("maps DART excerpts/tables to the actual receipt URL and receipt date, with unverified candidates labelled", () => {
    const f = filing("20251114000001", "2025-11-14", "Q3", "2025-09-30");
    const src = { rceptNo: f.rceptNo, receiptUrl: f.receiptUrl, reportName: f.reportName, periodEnd: f.period.end, sectionTitle: "사업의 내용" };
    const ev = evidence({
      filings: {
        list: [f],
        statements: [],
        excerpts: [{ ...src, text: "DRAM 시장 점유율은 40% 입니다.", truncated: false }],
        tables: [{ ...src, sectionTitle: "매출 표", unit: "백만원", rows: [["a", "1"]], text: "a | 1", truncated: false }],
        metricCandidates: [{ kind: "market_share", label: "DRAM", rawText: "DRAM 시장 점유율은 40%", value: 40, unit: "%", scale: null, measure: "unspecified", basis: "unspecified", periodHint: null, context: "", source: src, verificationStatus: "candidate" }],
        productCandidates: [{ name: "DRAM", evidence: "text_list", context: "", source: src, verificationStatus: "candidate" }],
      },
    });
    const docs = buildDocuments(ev).documents;
    const exc = docs.find((d) => d.id === `exc-${f.rceptNo}`)!;
    expect(exc).toMatchObject({ url: f.receiptUrl, publishedAt: "2025-11-14" });
    expect(exc.text).toContain("DRAM 시장 점유율은 40% 입니다.");
    expect(exc.text).toContain("자동 추출 후보 (미검증");
    expect(docs.find((d) => d.id === `tbl-${f.rceptNo}`)!.text).toContain("[단위: 백만원]");
  });

  it("filing_text reserves fair representation for shares/finance categories within one document against an oversized business excerpt", () => {
    const f = filing("20251114000001", "2025-11-14", "Q3", "2025-09-30");
    const src = (title: string) => ({ rceptNo: f.rceptNo, receiptUrl: f.receiptUrl, reportName: f.reportName, periodEnd: f.period.end, sectionTitle: title });
    const bigBusiness = { ...src("사업의 내용"), category: "business" as const, text: "회사의 주요 제품과 사업 부문에 대한 상세한 설명입니다. ".repeat(3000), truncated: false };
    const shares = { ...src("주식의 총수 등"), category: "shares" as const, text: "발행주식총수 관련 상세 현황 설명.", truncated: false };
    const finance = { ...src("시설투자 계획"), category: "finance" as const, financeTopic: "capex" as const, text: "설비투자 계획 및 실행 현황 설명.", truncated: false };
    const ev = evidence({ filings: { list: [f], statements: [], excerpts: [bigBusiness, shares, finance] } });
    const built = buildDocuments(ev);
    const doc = built.documents.find((d) => d.id === `exc-${f.rceptNo}`)!;

    expect(doc.text.length).toBeLessThanOrEqual(20_000); // per-document hard cap (DOC_CHAR_LIMIT)
    expect(doc.text).toContain("발행주식총수"); // shares category survives an oversized business excerpt
    expect(doc.text).toContain("설비투자 계획"); // finance category survives too
    expect(doc.text).toMatch(/\[주식\/지분\]/); // source section labels retained per category
    expect(doc.text).toMatch(/\[재무\]/);
    expect(doc.text).toContain("[TRUNCATED"); // omission is reported, never silently dropped
    expect(built.refs.find((r) => r.id === doc.id)?.truncated).toBe(true);
    // IDs/URL/provenance and the full raw collection are untouched by trimming what's sent to the models.
    expect(doc.id).toBe(`exc-${f.rceptNo}`);
    expect(doc.url).toBe(f.receiptUrl);
    expect(doc.publishedAt).toBe(f.receivedDate);
    expect(ev.filings.excerpts[0]!.text.length).toBeGreaterThan(20_000);
  });

  it("filing_tables reserves fair representation for shares/finance categories within one document against an oversized business table", () => {
    const f = filing("20251114000001", "2025-11-14", "Q3", "2025-09-30");
    const src = (title: string) => ({ rceptNo: f.rceptNo, receiptUrl: f.receiptUrl, reportName: f.reportName, periodEnd: f.period.end, sectionTitle: title });
    const bigBusiness = { ...src("매출 표"), category: "business" as const, unit: "백만원", rows: [["a", "1"]], text: "매출 상세 내역 표. ".repeat(3000), truncated: false };
    const shares = { ...src("주식 총수 표"), category: "shares" as const, unit: "주", rows: [["b", "2"]], text: "발행주식총수 표 상세.", truncated: false };
    const finance = { ...src("현금흐름표 요약"), category: "finance" as const, financeTopic: "cashflow" as const, unit: "억원", rows: [["c", "3"]], text: "영업활동 현금흐름 표.", truncated: false };
    const ev = evidence({ filings: { list: [f], statements: [], tables: [bigBusiness, shares, finance] } });
    const built = buildDocuments(ev);
    const doc = built.documents.find((d) => d.id === `tbl-${f.rceptNo}`)!;

    expect(doc.text.length).toBeLessThanOrEqual(20_000);
    expect(doc.text).toContain("발행주식총수 표 상세");
    expect(doc.text).toContain("영업활동 현금흐름 표");
    expect(doc.text).toMatch(/\[주식\/지분\]/);
    expect(doc.text).toMatch(/\[재무\]/);
    expect(doc.text).toContain("[TRUNCATED");
    expect(built.refs.find((r) => r.id === doc.id)?.truncated).toBe(true);
  });

  it("truncateStatement always honors the hard char limit and gives every nonempty IS/BS/CF category fair, redistributed representation", () => {
    const head = "HEAD ".repeat(40); // 200 chars
    const pathologicalCf = ["CF행 ".repeat(3000)]; // one CF line far bigger than any budget below, alone
    const isLines = Array.from({ length: 5 }, (_, i) => `IS행${i}: 매출액 ${i}`);
    const bsLines = Array.from({ length: 5 }, (_, i) => `BS행${i}: 자산총계 ${i}`);
    const sl = { head, byCat: [isLines, bsLines, pathologicalCf] as [string[], string[], string[]] };

    // Tiny remaining limit (smaller than the head itself): the hard cap must still never be exceeded.
    const tiny = truncateStatement(sl, 50);
    expect(tiny.text.length).toBeLessThanOrEqual(50);
    expect(tiny.truncated).toBe(true);

    // A reasonable budget: the pathological CF line must not be able to consume the whole budget and starve IS/BS.
    const reasonable = truncateStatement(sl, 400);
    expect(reasonable.text.length).toBeLessThanOrEqual(400);
    expect(reasonable.truncated).toBe(true);
    expect(reasonable.text).toContain("IS행0");
    expect(reasonable.text).toContain("BS행0");

    // A merely large (not pathological) CF category still gets fair, non-empty representation alongside IS/BS.
    const bigButFairCf = Array.from({ length: 20 }, (_, i) => `CF행${i}: 영업활동 ${i}`);
    const sl2 = { head, byCat: [isLines, bsLines, bigButFairCf] as [string[], string[], string[]] };
    const fair = truncateStatement(sl2, 600);
    expect(fair.text.length).toBeLessThanOrEqual(600);
    expect(fair.text).toContain("IS행0");
    expect(fair.text).toContain("BS행0");
    expect(fair.text).toContain("CF행0");

    // Below the full-text length, always truncated=false and the exact text (no hidden truncation).
    const untouched = truncateStatement(sl, 100_000);
    expect(untouched.truncated).toBe(false);
  });

  it("a large income statement never crowds out balance-sheet/cash-flow rows (CAPEX/financing survive for the auto strategy path)", () => {
    const manyIsRows = Array.from({ length: 200 }, (_, i) => ({ statement: "IS" as const, accountId: `is${i}`, accountName: `IS계정${i}`, currency: "KRW", thisTermLabel: null, thisTermAmount: i, thisTermCumulativeAmount: null, priorTermLabel: null, priorTermAmount: null, priorQuarterLabel: null, priorQuarterAmount: null, priorCumulativeAmount: null }));
    const capexRow = { statement: "CF" as const, accountId: "capex", accountName: "유형자산의 취득", currency: "KRW", thisTermLabel: null, thisTermAmount: 12345, thisTermCumulativeAmount: null, priorTermLabel: null, priorTermAmount: null, priorQuarterLabel: null, priorQuarterAmount: null, priorCumulativeAmount: null };
    const debtRow = { statement: "BS" as const, accountId: "debt", accountName: "장기차입금", currency: "KRW", thisTermLabel: null, thisTermAmount: 67890, thisTermCumulativeAmount: null, priorTermLabel: null, priorTermAmount: null, priorQuarterLabel: null, priorQuarterAmount: null, priorCumulativeAmount: null };
    const ev = evidence({ filings: { statements: [statement("20251114000001", { rows: [...manyIsRows, capexRow, debtRow] })] } });
    const text = buildDocuments(ev).documents.find((d) => d.id.startsWith("stmt-"))!.text;
    expect(text).toContain("유형자산의 취득");
    expect(text).toContain("12,345");
    expect(text).toContain("장기차입금");
    expect(text).toContain("67,890");
  });

  it("keeps late funding accounts even when BS/CF themselves exceed their row quotas", () => {
    const rows = (["BS", "CF"] as const).flatMap((category) => {
      const blank = { ...statement("20251114000001").rows[0], statement: category, currency: "KRW" };
      const filler = Array.from({ length: 100 }, (_, i) => ({ ...blank, accountId: `misc${i}`, accountName: `기타상세${i}` }));
      const names = category === "BS" ? ["현금및현금성자산", "장기차입금", "유동성장기부채"] : ["유형자산의 취득", "차입금의 상환", "법인세의 납부", "이자의 지급", "감가상각비", "배당금 지급"];
      return [...filler, ...names.map((accountName, i) => ({ ...blank, accountName, accountId: `funding${i}`, thisTermAmount: 12345 }))];
    });
    const ev = evidence({ filings: { statements: [statement("20251114000001", { rows })] } });
    const text = buildDocuments(ev).documents.find((d) => d.id.startsWith("stmt-"))!.text;
    for (const name of ["현금및현금성자산", "장기차입금", "유형자산의 취득", "차입금의 상환", "법인세의 납부", "이자의 지급", "감가상각비", "배당금 지급"])
      expect(text).toContain(name);
  });

  it("respects the intelligence limits: <=30 documents, bounded characters, every document schema-valid", () => {
    const f = filing("20251114000001", "2025-11-14", "Q3", "2025-09-30");
    const src = { rceptNo: f.rceptNo, receiptUrl: f.receiptUrl, reportName: f.reportName, periodEnd: f.period.end, sectionTitle: "s" };
    const many = Array.from({ length: 28 }, (_, i) => statement(`2025111400${String(i).padStart(4, "0")}`, { periodEnd: `2025-09-${String((i % 28) + 1).padStart(2, "0")}` }));
    const ev = evidence({
      filings: { list: [f, ...many.map((s) => filing(s.rceptNo, "2025-11-14", "Q3", "2025-09-30"))], statements: many, excerpts: [{ ...src, text: "x".repeat(200_000), truncated: false }] },
    });
    const built = buildDocuments(ev);
    expect(built.documents.length).toBeLessThanOrEqual(LIMITS.maxDocuments);
    expect(built.documents.reduce((n, d) => n + d.text.length, 0)).toBeLessThanOrEqual(LIMITS.maxTotalChars);
    built.documents.forEach((d) => expect(EvidenceDocumentSchema.safeParse(d).success).toBe(true));
    expect(built.omitted.length).toBeGreaterThan(0);
    expect(built.refs.some((r) => r.truncated)).toBe(true);
  });

  it("the smaller model evidence budget still preserves quote/share proof and the financial statement over a flood of news, and reports what was dropped", () => {
    const news = Array.from({ length: 30 }, (_, i) => ({
      id: `n${i}`,
      title: `뉴스 ${i}`,
      snippet: "일반 시황 뉴스 본문 ".repeat(50),
      publishedAt: "2026-01-12T09:00:00+09:00",
      officeName: "A",
      url: `https://n.news.naver.com/mnews/article/001/000000${1000 + i}`,
      originalUrl: null,
      origin: "naver-stock-news" as const,
    }));
    const ev = evidence({ market: { news } });
    const built = buildDocuments(ev);
    // Quote (share/price proof) and the DART statement (IS/BS/CF) are added before news in priority order, so they
    // are never crowded out by a flood of lower-priority news documents even under the smaller budget.
    expect(built.documents.find((d) => d.id === "naver-quote")).toBeDefined();
    expect(built.documents.find((d) => d.id.startsWith("stmt-"))).toBeDefined();
    const stmtDoc = built.documents.find((d) => d.id.startsWith("stmt-"))!;
    expect(stmtDoc.text).toContain("매출액"); // IS
    expect(stmtDoc.text).toContain("자산총계"); // BS
    expect(stmtDoc.text).toContain("영업활동현금흐름"); // CF
    // The full raw collection (not sent to the models) is untouched: nothing here trims `ev` itself.
    expect(ev.market.news).toHaveLength(30);
    // Every document actually sent stays inside the smaller total budget, and every omission is reported.
    expect(built.documents.reduce((n, d) => n + d.text.length, 0)).toBeLessThanOrEqual(200_000);
    expect(built.omitted.some((o) => o.kind === "news")).toBe(true);
  });

  it("CRITICAL: many statement quarters never starve filing_text (business narrative) or reference (shares/foreign-ownership context) -- the real-snapshot regression", () => {
    // A large-cap ticker with many CFS/OFS quarters: at the old (pre-reservation) single shared budget, statements
    // alone filled the whole budget before the loop ever reached filing_text/reference, so a real snapshot came back
    // with quote + statements only -- no business narrative, no shares proof beyond the statements.
    const many = Array.from({ length: 12 }, (_, i) =>
      statement(`2025111400${String(i).padStart(4, "0")}`, { fsDiv: i % 2 === 0 ? "CFS" : "OFS", periodEnd: `2025-${String(9 - Math.floor(i / 2)).padStart(2, "0")}-30` }));
    const filings = many.map((s) => filing(s.rceptNo, "2025-11-14", "Q3", s.periodEnd));
    const businessRcept = "20251114009999";
    const businessFiling = filing(businessRcept, "2025-11-14", "Q3", "2025-09-30");
    const businessSrc = { rceptNo: businessRcept, receiptUrl: businessFiling.receiptUrl, reportName: businessFiling.reportName, periodEnd: businessFiling.period.end, sectionTitle: "사업의 내용" };
    const ev = evidence({
      filings: {
        list: [...filings, businessFiling],
        statements: many,
        excerpts: [{ ...businessSrc, text: "회사의 주요 제품과 사업 부문에 대한 상세한 설명. ".repeat(400), truncated: false }],
      },
      market: { referenceMetrics: [{ label: "발행주식총수", rawValue: "5,969,782,550", rawDescription: "보통주", role: "shares_outstanding", sourceUrl: "https://m.stock.naver.com/x", retrievedAt: NOW.toISOString() }] },
    });
    const built = buildDocuments(ev);
    const kinds = new Set(built.refs.map((r) => r.kind));
    expect(kinds.has("filing_text")).toBe(true); // business narrative survived
    expect(kinds.has("reference")).toBe(true); // shares/ownership context survived
    expect(kinds.has("statement")).toBe(true); // statements still present, just not the only thing
    const excerptDoc = built.documents.find((d) => d.id === `exc-${businessRcept}`);
    expect(excerptDoc?.text).toContain("주요 제품과 사업 부문");
  });

  it("a large income statement never pushes CF rows past the per-document CHARACTER truncation cutoff (row-count budgeting alone does not bound chars)", () => {
    const wideIsRows = Array.from({ length: 80 }, (_, i) => ({
      statement: "IS" as const, accountId: `is${i}`, accountName: `매출 관련 상세 계정과목 설명이 매우 길게 들어가는 항목 번호 ${i}`, currency: "KRW",
      thisTermLabel: "제 57 기 3분기", thisTermAmount: 123456789 + i, thisTermCumulativeAmount: 999999999,
      priorTermLabel: "제 56 기 3분기", priorTermAmount: 111111111, priorQuarterLabel: null, priorQuarterAmount: null, priorCumulativeAmount: 888888888,
    }));
    const capexRow = { statement: "CF" as const, accountId: "capex", accountName: "유형자산의 취득", currency: "KRW", thisTermLabel: null, thisTermAmount: 12345, thisTermCumulativeAmount: null, priorTermLabel: null, priorTermAmount: null, priorQuarterLabel: null, priorQuarterAmount: null, priorCumulativeAmount: null };
    const financingRow = { statement: "CF" as const, accountId: "financing", accountName: "재무활동으로 인한 현금흐름", currency: "KRW", thisTermLabel: null, thisTermAmount: 54321, thisTermCumulativeAmount: null, priorTermLabel: null, priorTermAmount: null, priorQuarterLabel: null, priorQuarterAmount: null, priorCumulativeAmount: null };
    const ev = evidence({ filings: { statements: [statement("20251114000001", { rows: [...wideIsRows, capexRow, financingRow] })] } });
    const doc = buildDocuments(ev).documents.find((d) => d.id.startsWith("stmt-"))!;
    expect(doc.text).toContain("유형자산의 취득");
    expect(doc.text).toContain("12,345");
    expect(doc.text).toContain("재무활동으로 인한 현금흐름");
    expect(doc.text).toContain("54,321");
  });
});

describe("common stock only", () => {
  it("rejects preferred-share tickers with 422 before any job or collection call", async () => {
    const collect = vi.fn(async () => evidence());
    const { app } = await setup({}, NOW, { collect, intelligence: vi.fn(async () => accepted()) });
    for (const [url, ticker] of [["/v1/analyses", "005935"], ["/v1/research", "005387"]] as const) {
      const res = await submit(app, { ticker, asOf: AS_OF }, {}, url);
      expect(res.statusCode).toBe(422);
      expect(res.json().error.code).toBe("NOT_COMMON_STOCK");
    }
    expect(collect).not.toHaveBeenCalled();
  });

  it("fails the job with NOT_COMMON_STOCK when the collector flags an ETF/REIT and never calls the models", async () => {
    const ev = evidence({ issues: [{ provider: "naver", code: "not_common_stock", severity: "error", message: "Ticker 348950 is not a common stock: REIT" }] });
    const intelligence = vi.fn(async () => accepted());
    const t = await setup({}, NOW, { collect: async () => ev, intelligence });
    const { body } = await poll(t.app, (await submit(t.app)).json().statusUrl);
    expect(body).toMatchObject({ status: "failed", error: { code: "NOT_COMMON_STOCK" } });
    expect(intelligence).not.toHaveBeenCalled();
  });
});

// ---- automatic strategy connection (earnings-gap-auto/v1) ---------------------------------------------------------

describe("strategyAuto: automatic earnings-gap-auto/v1 connection on POST /v1/analyses", () => {
  it("ticker-only public analysis reaches the automatic strategy path and never affects the existing job status", async () => {
    const candidate = makeSingleQuarterCandidate("111110");
    const intelligence = vi.fn(async () => accepted(null, { strategy: { forecast: candidate.forecast, currentConsensus: candidate.currentConsensus, priorConsensus: candidate.priorConsensus, catalyst: candidate.catalyst, unavailable: [] } }));
    const { app } = await setup({}, NOW, { collect: async () => evidence(), intelligence });
    const job = (await submit(app, { ticker: "111110" })).json(); // ticker-only: no strategy JSON authored by the caller
    const { body } = await poll(app, job.statusUrl);
    expect(body.result.strategyAuto).toBeDefined();
    expect(body.result.strategyAuto.status).toBe("eligible");
  });

  it("complete sourced fixtures produce a forecast bridge, funding risk and a full eligibility evaluation", async () => {
    const candidate = makeSingleQuarterCandidate("111110");
    const intelligence = vi.fn(async () => accepted(null, { strategy: { forecast: candidate.forecast, currentConsensus: candidate.currentConsensus, priorConsensus: candidate.priorConsensus, catalyst: candidate.catalyst, unavailable: [] } }));
    const { app } = await setup({}, NOW, { collect: async () => evidence(), intelligence });
    const { body } = await poll(app, (await submit(app, { ticker: "111110", asOf: AS_OF })).json().statusUrl);
    const sa = body.result.strategyAuto;
    expect(sa.status).toBe("eligible");
    expect(sa.bridge.ntmEpsKRW).toBeCloseTo(2); // one quarter
    expect(sa.risk).not.toBeNull();
    expect(sa.evaluation.eligible).toBe(true);
    expect(sa.missing).toEqual([]);
    // never a fabricated portfolio weight/budget in the automatic path
    expect(JSON.stringify(sa.evaluation)).not.toMatch(/"weight"|"budgetKRW"/);
  });

  it("missing/mismatched consensus produces an explicit partial strategy subresult without blocking the existing valuation", async () => {
    const candidate = makeSingleQuarterCandidate("111110");
    const intelligence = vi.fn(async () =>
      accepted(makeDataset(), {
        strategy: {
          forecast: candidate.forecast,
          currentConsensus: null,
          priorConsensus: null,
          catalyst: candidate.catalyst,
          unavailable: [{ field: "currentConsensus", code: "EPS_UNCITED", message: "epsPerShare: no citation for this number" }],
        },
      }),
    );
    const { app } = await setup({}, NOW, { collect: async () => evidence(), intelligence });
    const { body } = await poll(app, (await submit(app, { ticker: "111110", asOf: AS_OF })).json().statusUrl);
    expect(body.status).toBe("completed"); // the product-market valuation is unaffected by the missing consensus
    expect(body.result.valuation.status).toBe("available");
    const sa = body.result.strategyAuto;
    expect(sa.status).toBe("estimate_only"); // the single-quarter estimate stands without consensus
    expect(sa.bridge).not.toBeNull(); // earnings bridge/risk still visible
    expect(sa.risk).not.toBeNull();
    expect(sa.evaluation).toBeNull();
    expect(sa.missing).toContainEqual(expect.objectContaining({ field: "currentConsensus", code: "EPS_UNCITED" }));
    expect(sa.missing.map((m: any) => m.field)).toContain("priorConsensus");
  });

  it("gracefully reports strategy status unavailable when no model draft was produced at all", async () => {
    const { app } = await setup({}, NOW, { collect: async () => evidence(), intelligence: async () => accepted(null) });
    const { body } = await poll(app, (await submit(app, { ticker: "111110", asOf: AS_OF })).json().statusUrl);
    expect(body.status).toBe("partial");
    expect(body.result.analysis).toBeNull();
    expect(body.result.strategyAuto.status).toBe("insufficient_data");
    expect(body.result.strategyAuto.missing.map((m: any) => m.field)).toEqual(expect.arrayContaining(["forecast", "currentConsensus", "priorConsensus", "catalyst"]));
  });

  it("always reports an explicit unavailable subresult (never a silently disappearing null) when the intelligence module was never invoked at all", async () => {
    const ev = evidence({ market: { quote: null, news: [] }, filings: { list: [], statements: [] } });
    const intelligence = vi.fn(async () => accepted());
    const { app } = await setup({}, NOW, { collect: async () => ev, intelligence });
    const { body } = await poll(app, (await submit(app, { ticker: "111110", asOf: AS_OF })).json().statusUrl);
    expect(intelligence).not.toHaveBeenCalled();
    const sa = body.result.strategyAuto;
    expect(sa).not.toBeNull();
    expect(sa.status).toBe("insufficient_data");
    expect(sa.bridge).toBeNull();
    expect(sa.missing).toContainEqual(expect.objectContaining({ field: "all", code: "NO_MODEL_DRAFT" }));
  });

  // ---- true end-to-end: fake collector -> REAL analyzeEvidence (real prompts + real verification) via an injected
  // fake CLI runner -> public ticker-only job -> automatic strategy calculation. Not a stubbed AnalysisResult.
  describe("end-to-end through the real analyzeEvidence pipeline (fake CLI runner, not a stubbed intelligence)", () => {
    const ok = (stdout: string): RunResult => ({ stdout, stderr: "", exitCode: 0, timedOut: false, outputLimitExceeded: false });
    const claudeOut = (p: unknown) => ok(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "```json\n" + JSON.stringify(p) + "\n```" }));
    const agyOut = (a: unknown) => ok(JSON.stringify({ conversation_id: "c", status: "SUCCESS", response: JSON.stringify(a), usage: {} }));
    const isAuditPrompt = (r: RunRequest) => r.stdin.includes("독립 감사인") || r.args.some((a) => a.includes("독립 감사인"));
    const route = (draft: unknown, audit: unknown): Runner => async (r) => (isAuditPrompt(r) ? agyOut(audit) : claudeOut(draft));
    const runnerOpts = (runner: Runner) => ({ claudePath: "/opt/bin/claude", agyPath: "/opt/bin/agy", runner, cache: false, env: { PATH: "/usr/bin" } });

    const CUR_NEWS = { id: "n-cur", title: "실적발표 컨퍼런스콜", snippet: "s", officeName: "A", url: "https://n.news.naver.com/mnews/article/001/0000000010", originalUrl: null, origin: "naver-stock-news" as const,
      publishedAt: "2026-01-10T09:00:00+09:00", articleText: "2026Q1 연결 기준 보통주 희석 컨센서스 EPS 7원으로 집계됐다. 다음 실적발표 예정일은 2026-02-05이다." };
    const PRIOR_NEWS = { id: "n-prior", title: "이전 컨센서스", snippet: "s", officeName: "A", url: "https://n.news.naver.com/mnews/article/001/0000000011", originalUrl: null, origin: "naver-stock-news" as const,
      publishedAt: "2025-12-06T09:00:00+09:00", articleText: "2026Q1 연결 기준 보통주 희석 컨센서스 EPS 6원으로 집계됐다." };
    const groundedSrc = () => ({ title: "DART", url: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20251114000001", kind: "filing", knownAt: "2025-11-14T00:00:00+09:00" });
    const segment = () => ({ name: "seg", volume: 10, unitPriceKRW: 100, variableCostPerUnitKRW: 60, fixedCostKRW: 100, source: groundedSrc(), assumptions: { isAssumption: true, rationale: "직전 분기 기반 전망", source: groundedSrc() } });
    const quarterOf = (q: string) => ({ quarter: q, segments: [segment()], coverageAttestation: { complete: true, statedBy: "claude" },
      netInterestKRW: -10, taxRate: 0.2, noncontrollingShare: 0, preferredClaimsKRW: 0, dilutedCommonShares: 25,
      bridgeAssumptions: { isAssumption: true, rationale: "가정 유지", source: groundedSrc() } });
    const draftForecast = () => ({ schemaVersion: 1, ticker: "111110", company: { name: "Test Co", exchange: "KOSPI", securityType: "common_stock", source: groundedSrc() },
      scope: "consolidated", sector: "auto", fiscalYearBasis: "calendar", currency: "KRW", generatedAt: "2026-01-15T00:00:00+09:00", analyst: "claude",
      quarters: ["2026Q1"].map(quarterOf) });
    const draftConsensus = (eps: number, news: typeof CUR_NEWS) => ({ schemaVersion: 1, ticker: "111110", scope: "consolidated", basis: "common_diluted", currency: "KRW", unit: "KRW_per_share",
      horizonQuarters: ["2026Q1"], epsPerShare: eps, knownAt: news.publishedAt, source: { title: news.title, url: news.url, kind: "market_data_vendor", knownAt: news.publishedAt } });
    const draftCatalyst = () => ({ schemaVersion: 1, ticker: "111110", eventType: "earnings_release", eventAt: "2026-02-05T09:00:00+09:00", knownAt: CUR_NEWS.publishedAt,
      source: { title: CUR_NEWS.title, url: CUR_NEWS.url, kind: "exchange_notice", knownAt: CUR_NEWS.publishedAt } });
    const curQuote = "2026Q1 연결 기준 보통주 희석 컨센서스 EPS 7원으로 집계됐다.";
    const priorQuote = "2026Q1 연결 기준 보통주 희석 컨센서스 EPS 6원으로 집계됐다.";
    const strategyDraft = () => ({
      dataset: null, missingFields: ["quote.priceKRW"], narrative: { product: "p", industry: "i" }, assumptions: [], limitations: [],
      citations: [
        { fieldPath: "currentConsensus.epsPerShare", documentId: `news-n-${CUR_NEWS.id}`, url: CUR_NEWS.url, publishedAt: "2026-01-10", evidenceQuote: curQuote, quotedNumber: "7" },
        { fieldPath: "currentConsensus.horizonQuarters", documentId: `news-n-${CUR_NEWS.id}`, url: CUR_NEWS.url, publishedAt: "2026-01-10", evidenceQuote: curQuote, quotedNumber: "7" },
        { fieldPath: "priorConsensus.epsPerShare", documentId: `news-n-${PRIOR_NEWS.id}`, url: PRIOR_NEWS.url, publishedAt: "2025-12-06", evidenceQuote: priorQuote, quotedNumber: "6" },
        { fieldPath: "priorConsensus.horizonQuarters", documentId: `news-n-${PRIOR_NEWS.id}`, url: PRIOR_NEWS.url, publishedAt: "2025-12-06", evidenceQuote: priorQuote, quotedNumber: "6" },
        { fieldPath: "catalyst.eventAt", documentId: `news-n-${CUR_NEWS.id}`, url: CUR_NEWS.url, publishedAt: "2026-01-10", evidenceQuote: "다음 실적발표 예정일은 2026-02-05이다.", quotedNumber: "2026-02-05" },
      ],
      strategy: { forecast: draftForecast(), currentConsensus: draftConsensus(7, CUR_NEWS), priorConsensus: draftConsensus(6, PRIOR_NEWS), catalyst: draftCatalyst() },
    });
    const auditOf = () => ({ approved: true, claims: [], estimateReviews: [], disagreements: [], missingFields: ["quote.priceKRW"], summary: "no observed dataset facts to confirm" });

    it("runs the ticker-only public analysis through the real prompt/verification pipeline and produces a genuine automatic strategy result", async () => {
      const intelligence = (input: EvidenceInput, opts2: { signal: AbortSignal }) =>
        analyzeEvidence(input, { ...runnerOpts(route(strategyDraft(), auditOf())), now: () => NOW, signal: opts2.signal });
      const ev = evidence({ market: { news: [CUR_NEWS, PRIOR_NEWS] } });
      const { app } = await setup({}, NOW, { collect: async () => ev, intelligence });
      const { body } = await poll(app, (await submit(app, { ticker: "111110" })).json().statusUrl); // ticker-only
      const sa = body.result.strategyAuto;
      expect(sa.mode).toBe("live");
      expect(sa.bridge?.ntmEpsKRW).toBeCloseTo(9.28); // one quarter: revenue 1000, OP 300, pretax 290, tax 58, net 232 over 25 shares
      expect(sa.risk).toBeNull(); // no funding plan was drafted; explicitly unavailable, never fabricated as zero
      expect(sa.missing).toContainEqual(expect.objectContaining({ field: "funding", code: "FUNDING_UNAVAILABLE" }));
      // gap ~32.6% and revision ~16.7% both clear the default thresholds; this is genuinely ineligible only because
      // no funding/liquidity data was drafted -- a real partial verdict through the pipeline, not a fabricated pass.
      expect(sa.evaluation.eligible).toBe(false);
      expect((sa.evaluation as any).reasons.map((r: any) => r.code)).toEqual(expect.arrayContaining(["RISK_DATA_MISSING", "LIQUIDITY_DATA_MISSING"]));
      expect(sa.status).toBe("ineligible");
      expect(sa.generatedAt).toBeDefined();
      expect(sa.independentlyAudited).toBe(false);
      // No 2025-12-31 statement exists on 2026-01-15, so no statement-derived plan either -- with the exact reason.
      expect(sa.missing).toContainEqual(expect.objectContaining({ field: "funding", code: "FUNDING_OPENING_BALANCE_UNAVAILABLE" }));
    });

    // Regression: the model's funding completion is rejected (or returns null), although the consolidated BS/CF
    // were collected and sent to it. risk used to stay null; it is now derived from those statements, end to end.
    it("connects real collected consolidated statements to strategyAuto.risk when the model funding plan is rejected", async () => {
      const real: StatementSet = JSON.parse(await readFile(new URL("./fixtures/dart-012450-2025Q3-cfs.json", import.meta.url), "utf8"));
      const ev = evidence({ filings: { list: [filing(real.rceptNo, "2025-11-13", "Q3", "2025-09-30")], statements: [real] } });
      const src = () => ({ title: "DART", url: real.receiptUrl, kind: "filing", knownAt: "2025-11-13T00:00:00+09:00" });
      const forecast = { ...draftForecast(), company: { ...draftForecast().company, source: src() },
        quarters: [{ ...quarterOf("2025Q4"), segments: [{ ...segment(), source: src(), assumptions: { isAssumption: true, rationale: "3분기 기반", source: src() } }],
          bridgeAssumptions: { isAssumption: true, rationale: "가정 유지", source: src() } }] };
      const draft = { ...strategyDraft(), citations: [], strategy: { forecast, currentConsensus: null, priorConsensus: null, catalyst: null } };
      let fundingCalls = 0;
      const runner: Runner = async (r) => {
        if (isAuditPrompt(r)) return agyOut(auditOf());
        if ([r.stdin, ...r.args].some((a) => a.includes("누락된 투자·운전자본·차입 자금 계획만 보완"))) {
          fundingCalls++;
          return claudeOut({ funding: null, missingFields: ["분기 D&A와 차입 만기 스케줄이 공시되지 않았습니다."] });
        }
        return claudeOut(draft);
      };
      const intelligence = (input: EvidenceInput, o: { signal: AbortSignal }) => analyzeEvidence(input, { ...runnerOpts(runner), now: () => NOW, signal: o.signal });
      const { app } = await setup({}, NOW, { collect: async () => ev, intelligence });
      const { body } = await poll(app, (await submit(app, { ticker: "111110" })).json().statusUrl);
      const sa = body.result.strategyAuto;
      expect(fundingCalls).toBe(1);
      expect(sa.bridge.quarters[0].quarter).toBe("2025Q4");
      expect(sa.risk).not.toBeNull();
      expect(sa.fundingOrigin).toBe("derived_from_filings");
      expect(sa.risk.base.quarters[0].openingCashKRW).toBe(4_244_476_069_000);
      expect(sa.risk.base.quarters[0].capexKRW).toBeCloseTo((873_772_782_000 + 191_369_077_000) / 3, 0);
      expect(sa.risk.stress.endingCashKRW).toBeLessThan(sa.risk.base.endingCashKRW);
      // no-refinancing bound: all current (<=12m) borrowings due in this quarter
      expect(sa.noRefinancingBound.currentDebtKRW).toBe(7_569_521_034_000);
      expect(sa.noRefinancingBound.baseEndingCashKRW).toBeCloseTo(sa.risk.base.endingCashKRW - 7_569_521_034_000 * 3 / 4, 0);
      expect(sa.noRefinancingBound.stressAdditionalFundingRequiredKRW).toBeGreaterThanOrEqual(sa.noRefinancingBound.baseAdditionalFundingRequiredKRW);
      expect(sa.missing.filter((m: any) => m.field === "funding")).toEqual([]);
      expect(sa.notes.join(" ")).toContain("[FUNDING_INPUT_MISSING] 분기 D&A와 차입 만기 스케줄이 공시되지 않았습니다.");
      expect(sa.notes.join(" ")).toContain("결정론적으로 파생");
      const fundingRefs = sa.assumptions.filter((a: any) => a.fieldPath.startsWith("forecast.funding"));
      expect(fundingRefs).toHaveLength(2);
      expect(fundingRefs.every((a: any) => a.isModelEstimate === false && a.source.url === real.receiptUrl)).toBe(true);
    });
  });
});

// ---- doctor / scripts ---------------------------------------------------------------------------------------------

describe("doctor and scripts", () => {
  const fakeRunner = (behaviour: Record<string, { exitCode: number; stdout?: string; spawnError?: string }>) => async (req: { command: string; args: string[] }) => {
    const key = `${path.basename(req.command)} ${req.args.join(" ")}`;
    const r = behaviour[key] ?? { exitCode: 1, spawnError: "ENOENT" };
    return { stdout: r.stdout ?? "", stderr: "", exitCode: r.exitCode, timedOut: false, outputLimitExceeded: false, spawnError: r.spawnError };
  };

  const MODELS = "Fetching available models...\ngemini-3.8-flash-high\tGemini 3.8 Flash (High)\n";
  const both = { "claude --version": { exitCode: 0, stdout: "2.0.0" }, "claude auth status": { exitCode: 0, stdout: '{"loggedIn":true}' }, "agy --version": { exitCode: 0, stdout: "1.2.12" }, "agy models": { exitCode: 0, stdout: MODELS } };

  it("reports presence/auth/config without values and without any model prompt", async () => {
    const home = await tmpDir("home");
    const calls: string[][] = [];
    const runner = async (req: any) => {
      calls.push(req.args);
      return fakeRunner(both)(req);
    };
    const env = { HOME: home, PATH: "/usr/bin", GOOGLE_API_KEY: "GOOGKEYVALUE", GOOGLE_CLOUD_PROJECT: "billing", DART_API_KEY: "DARTVALUE", ANTHROPIC_API_KEY: "ANTKEY" } as NodeJS.ProcessEnv;
    const report = await runDoctor({ env, runner: runner as any, home });
    const text = JSON.stringify(report) + formatDoctor(report);
    for (const secret of ["GOOGKEYVALUE", "DARTVALUE", "ANTKEY", "billing"]) expect(text).not.toContain(secret);
    const by = Object.fromEntries(report.items.map((i) => [i.name, i]));
    expect(report.ok).toBe(true);
    expect(report.readiness).toEqual({ evidence: true, fullAnalysis: true, dualModel: true });
    expect(by["claude-login"]!.status).toBe("ok");
    expect(by["agy-cli"]!.status).toBe("ok");
    expect(by["agy-login"]!.status).toBe("ok");
    expect(by["paid-env"]).toMatchObject({ status: "warn" });
    expect(by["paid-env"]!.detail).toContain("never forwarded");
    expect(by["dart-key"]!.status).toBe("ok");
    expect(by["naver-search"]!.status).toBe("warn");
    // only version / auth-status / `agy models` probes: no prompt (no -p/--print flag, nothing that consumes model quota)
    expect(calls.every((a) => a.length <= 2 && !a.some((x) => x.startsWith("-p") || x.startsWith("--print") || x === "--prompt"))).toBe(true);
  });

  it("one usable model is enough for a (single-model) analysis; a missing CLI is only a warning", async () => {
    const home = await tmpDir("home");
    const env = { HOME: home, PATH: "/usr/bin", DART_API_KEY: "K" } as NodeJS.ProcessEnv;
    const noAgy = await runDoctor({ env, runner: fakeRunner({ "claude --version": both["claude --version"], "claude auth status": both["claude auth status"] }) as any, home });
    expect(noAgy.ok).toBe(true);
    expect(noAgy.readiness).toEqual({ evidence: true, fullAnalysis: true, dualModel: false });
    expect(Object.fromEntries(noAgy.items.map((i) => [i.name, i]))["agy-cli"]!.status).toBe("warn");
    expect(formatDoctor(noAgy)).toContain("단일 모델");

    const noClaude = await runDoctor({ env, runner: fakeRunner({ "agy --version": both["agy --version"], "agy models": both["agy models"] }) as any, home });
    expect(noClaude.readiness).toEqual({ evidence: true, fullAnalysis: true, dualModel: false });
  });

  it("fails only when neither CLI is runnable; separates evidence from analysis readiness", async () => {
    const home = await tmpDir("home");
    const report = await runDoctor({ env: { HOME: home, PATH: "/usr/bin" } as NodeJS.ProcessEnv, runner: fakeRunner({}) as any, home });
    const by = Object.fromEntries(report.items.map((i) => [i.name, i]));
    expect(report.ok).toBe(false);
    expect(by["model-cli"]!.status).toBe("fail");
    expect(report.readiness).toEqual({ evidence: false, fullAnalysis: false, dualModel: false });
    expect(by["dart-key"]!.detail).toContain("Naver quote/news still work");
  });

  it("exit code 0 from `claude auth status` / `agy models` without a real login is not a login", async () => {
    const home = await tmpDir("home");
    const env = { HOME: home, PATH: "/usr/bin", DART_API_KEY: "K" } as NodeJS.ProcessEnv;
    for (const [stdout, expected] of [['{"loggedIn":false}', false], ["", false], ['{"loggedIn":true}', true]] as const) {
      const report = await runDoctor({ env, runner: fakeRunner({ "claude --version": both["claude --version"], "claude auth status": { exitCode: 0, stdout } }) as any, home });
      expect(report.readiness.fullAnalysis, stdout).toBe(expected);
    }
    const noModels = await runDoctor({ env, runner: fakeRunner({ "agy --version": both["agy --version"], "agy models": { exitCode: 0, stdout: "Fetching available models...\n" } }) as any, home });
    expect(noModels.readiness.fullAnalysis).toBe(false);
    expect(Object.fromEntries(noModels.items.map((i) => [i.name, i]))["agy-login"]!.status).toBe("warn");
  });

  it("package scripts provide agy login and doctor (no gemini:* scripts), and .gitignore covers .tools", async () => {
    const pkg = JSON.parse(await readFile("package.json", "utf8"));
    expect(pkg.scripts["agy:login"]).toContain("scripts/agy-login.mjs");
    expect(Object.keys(pkg.scripts).filter((k) => k.startsWith("gemini"))).toEqual([]);
    expect(pkg.scripts.doctor).toBeDefined();
    expect(await readFile(".gitignore", "utf8")).toMatch(/^\.tools\/$/m);
    const login = await readFile("scripts/agy-login.mjs", "utf8");
    expect(login).toContain("ENV_ALLOWLIST"); // the login child gets an allowlisted environment, never API-key variables
    expect(login).not.toMatch(/GOOGLE_API_KEY|GOOGLE_CLOUD_PROJECT/);
    expect(await readFile(".env.example", "utf8")).not.toMatch(/=\s*[A-Za-z0-9]{20,}/);
  });
});
