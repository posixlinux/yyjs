import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import {
  analyzeEvidence,
  checkReadiness,
  clearProviderAvailability,
  codexArgs,
  codexEvents,
  type EvidenceInput,
  type RunRequest,
  type RunResult,
  type Runner,
} from "../src/intelligence/index.js";
import { buildEnv } from "../src/intelligence/runner.js";
import { parseModels } from "../src/config.js";
import { setup } from "../test/app.js";

const HOME = mkdtempSync(join(tmpdir(), "intel-codex-home-"));
afterAll(() => rmSync(HOME, { recursive: true, force: true }));
beforeEach(() => clearProviderAvailability());

// ---- fixtures ---------------------------------------------------------------------------------------------------

const ASOF = "2026-06-30";
const D1 = { id: "d1", title: "1Q26 보고서", url: "https://dart.fss.or.kr/r/1", publishedAt: "2026-05-15",
  text: "삼성전자 2026년 1분기 보고서. 연결 매출액 74,000억원. 발행 보통주 희석주식수 5,969,782,550주. 시장 2025Q2 시장 매출 100억원, 2025Q3 시장 매출 110억원, 2025Q4 시장 매출 120억원, 2026Q1 시장 매출 130억원. 메모리 제품 매출 50억원." };
const D2 = { id: "d2", title: "종가 기사", url: "https://news.example.com/a", publishedAt: "2026-06-01", text: "주가는 종가 70,000원으로 마감했다." };
const input = (extra: EvidenceInput["documents"] = []): EvidenceInput => ({ ticker: "005930", asOf: ASOF, documents: [D1, D2, ...extra] });

const s1 = { title: D1.title, url: D1.url, publishedAt: D1.publishedAt };
const s2 = { title: D2.title, url: D2.url, publishedAt: D2.publishedAt };
const assume = (v: unknown) => ({ value: v, source: { title: "모델 가정", manualReference: "MODEL_ASSUMPTION: 보수적 추정", publishedAt: ASOF }, rationale: "과거 추세 기반 가정" });
const tri = (a: number, b: number, c: number) => ({ bear: a, base: b, bull: c });

const dataset = () => ({
  schemaVersion: 1,
  company: { ticker: "005930", name: "삼성전자", exchange: "KOSPI", description: "반도체 제조사", sources: [s1] },
  quote: { priceKRW: 70000, asOf: "2026-06-01", source: s2 },
  shares: { dilutedCommon: 5969782550, asOf: "2026-03-31", source: s1 },
  fx: [],
  financials: { quarter: "2026Q1", totalRevenueKRW: 7.4e12, source: s1 },
  markets: [{
    id: "mem", name: "메모리", scope: "글로벌 메모리", currency: "KRW",
    observations: [["2025Q2", 1e10], ["2025Q3", 1.1e10], ["2025Q4", 1.2e10], ["2026Q1", 1.3e10]].map(([quarter, revenue]) => ({ quarter, revenue, basis: "quarterly", source: s1 })),
    annualGrowth: assume(tri(0, 0.05, 0.1)),
    seasonality: assume({ q1: 1, q2: 1, q3: 1, q4: 1 }),
    cyclical: assume(tri(0.95, 1, 1.05)),
  }],
  products: [{
    id: "hbm", name: "HBM", marketId: "mem",
    revenue: [{ quarter: "2026Q1", revenue: 5e9, currency: "KRW", basis: "quarterly", source: s1 }],
    shareDelta: assume(tri(-0.01, 0, 0.01)),
    shareBounds: { min: 0, max: 1 },
    operatingMargin: assume(tri(0.1, 0.2, 0.3)),
  }],
  earningsBridge: assume({ netInterestKRW: 0, effectiveTaxRate: 0.2, noncontrollingShare: 0.01, preferredClaimsKRW: 0 }),
  valuation: { peMultiple: assume(tri(8, 10, 12)) },
});

const cite = (fieldPath: string, d: typeof D1, quote: string, quotedNumber: string, multiplier = 1) =>
  ({ fieldPath, documentId: d.id, url: d.url, publishedAt: d.publishedAt, evidenceQuote: quote, quotedNumber, multiplier });
const citations = () => [
  cite("quote.priceKRW", D2, "종가 70,000원", "70,000"),
  cite("shares.dilutedCommon", D1, "보통주 희석주식수 5,969,782,550주", "5,969,782,550"),
  cite("financials.totalRevenueKRW", D1, "연결 매출액 74,000억원", "74,000", 1e8),
  cite("markets[0].observations[0].revenue", D1, "2025Q2 시장 매출 100억원", "100", 1e8),
  cite("markets[0].observations[1].revenue", D1, "2025Q3 시장 매출 110억원", "110", 1e8),
  cite("markets[0].observations[2].revenue", D1, "2025Q4 시장 매출 120억원", "120", 1e8),
  cite("markets[0].observations[3].revenue", D1, "2026Q1 시장 매출 130억원", "130", 1e8),
  cite("products[0].revenue[0].revenue", D1, "메모리 제품 매출 50억원", "50", 1e8),
];
const proposal = (over: Record<string, unknown> = {}) => ({
  dataset: dataset(), missingFields: [], narrative: { product: "HBM 제품", industry: "메모리 산업" },
  citations: citations(), assumptions: [{ fieldPath: "valuation.peMultiple", statement: "PER 10배", rationale: "역사적 평균" }], limitations: [], ...over,
});
const audit = (over: Record<string, unknown> = {}) => ({
  approved: true, claims: citations().map((c) => ({ fieldPath: c.fieldPath, verdict: "confirmed" })), disagreements: [], missingFields: [], summary: "일치", ...over,
});

const ok = (stdout: string): RunResult => ({ stdout, stderr: "", exitCode: 0, timedOut: false, outputLimitExceeded: false });
const claudeOut = (p: unknown) => ok(JSON.stringify({ type: "result", subtype: "success", is_error: false, result: "```json\n" + JSON.stringify(p) + "\n```" }));
const agyOut = (a: unknown, extra: Record<string, unknown> = {}) => ok(JSON.stringify({ conversation_id: "c", status: "SUCCESS", response: JSON.stringify(a), usage: {}, ...extra }));
const agyErr = (error: string) => ok(JSON.stringify({ conversation_id: "c", status: "ERROR", response: "", error, usage: {} }));
const QUOTA_MSG = "API error (attempt 5): RESOURCE_EXHAUSTED (code 429): Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 2h30m.";

// A provider that both drafts and (when the other one is expired) audits its own draft answers by prompt type.
const isAuditPrompt = (r: RunRequest) => r.stdin.includes("독립 감사인") || r.args.some((a) => a.includes("독립 감사인"));
const claudeBoth = (p: unknown = proposal(), a: unknown = audit()) => (r: RunRequest) => claudeOut(isAuditPrompt(r) ? a : p);
const agyBoth = (p: unknown = proposal(), a: unknown = audit()) => (r: RunRequest) => agyOut(isAuditPrompt(r) ? a : p);

const CLAUDE = "/opt/bin/claude";
const AGY = "/opt/bin/agy";
const CODEX = "/opt/bin/codex";

// `codex exec --json` event stream: the final answer arrives as an agent_message item.
const codexStream = (text: string, extra: object[] = []) =>
  [{ type: "thread.started", thread_id: "t" }, { type: "turn.started" }, ...extra, { type: "item.completed", item: { id: "i", type: "agent_message", text } }, { type: "turn.completed", usage: {} }]
    .map((e) => JSON.stringify(e)).join("\n");
const codexOut = (body: unknown, extra: object[] = []) => ok(codexStream(JSON.stringify(body), extra));
const isStrategyPrompt = (r: RunRequest) => [r.stdin, ...r.args].some((a) => a.includes("예정 이벤트(촉매)를 제공된 문서에서 추출"));
const EMPTY_STRATEGY = { strategy: { forecast: null, currentConsensus: null, priorConsensus: null, catalyst: null }, citations: [] };
const answer = (r: RunRequest) => (isStrategyPrompt(r) ? EMPTY_STRATEGY : isAuditPrompt(r) ? audit() : proposal());
const envelope = (r: RunRequest, body: unknown) => (r.command === CODEX ? codexOut(body) : r.command === CLAUDE ? claudeOut(body) : agyOut(body));
const opts = (runner: Runner, extra: Record<string, unknown> = {}) => ({ claudePath: CLAUDE, agyPath: AGY, codexPath: CODEX, runner, cache: false, env: { PATH: "/usr/bin", HOME, OPENAI_API_KEY: "sk-secret" }, ...extra });

describe("codex provider", () => {
  it("analyses with Codex alone: prompt on stdin, hardened exec flags, self-audit -> single_model", async () => {
    const calls: RunRequest[] = [];
    const runner: Runner = async (r) => (calls.push(r), envelope(r, answer(r)));
    const r = await analyzeEvidence(input(), opts(runner, { models: ["codex"] }));
    expect(r.status).toBe("single_model");
    expect(r.crossChecked).toBe(false);
    expect(r.audit.draftedBy).toBe("codex");
    expect(r.audit.auditedBy).toBe("codex");
    expect(Object.keys(r.providers)).toEqual(["codex"]);
    expect(r.audit.limitations.join(" ")).toContain("only codex was selected");
    expect(calls.every((c) => c.command === CODEX)).toBe(true); // Claude and agy are never called
    const c = calls[0]!;
    expect(c.args.slice(0, 2)).toEqual(["exec", "--json"]);
    expect(c.args).toEqual(expect.arrayContaining(["--ephemeral", "--ignore-user-config", "--ignore-rules", "--skip-git-repo-check", "read-only", 'approval_policy="never"', 'web_search="disabled"']));
    expect(c.args.at(-1)).toBe("-");
    expect(c.stdin).toContain("005930");
    expect(c.env.OPENAI_API_KEY).toBeUndefined(); // no paid API route
  });

  it("prefers the --output-last-message file over the event stream", async () => {
    const runner: Runner = async (r) => {
      const file = r.args[r.args.indexOf("--output-last-message") + 1]!;
      writeFileSync(file, "```json\n" + JSON.stringify(answer(r)) + "\n```");
      return ok(codexStream("not json"));
    };
    const r = await analyzeEvidence(input(), opts(runner, { models: ["codex"] }));
    expect(r.status).toBe("single_model");
  });

  it("Claude drafts and Codex independently cross-checks -> accepted", async () => {
    const order: string[] = [];
    const runner: Runner = async (r) => {
      if (!isStrategyPrompt(r)) order.push(`${r.command === CODEX ? "codex" : "claude"}:${isAuditPrompt(r) ? "audit" : "draft"}`);
      return envelope(r, answer(r));
    };
    const r = await analyzeEvidence(input(), opts(runner, { models: ["claude", "codex"] }));
    expect(r.status).toBe("accepted");
    expect(r.crossChecked).toBe(true);
    expect(order).toEqual(["claude:draft", "codex:audit"]);
    expect(Object.keys(r.providers).sort()).toEqual(["claude", "codex"]);
  });

  it("a Codex quota failure marks it expired and the other selected model carries on alone", async () => {
    const quota = ok([{ type: "turn.started" }, { type: "error", message: "Reconnecting... 1/5" }, { type: "turn.failed", error: { message: "You've hit your usage limit. Try again in 3 hours." } }].map((e) => JSON.stringify(e)).join("\n"));
    const runner: Runner = async (r) => (r.command === CODEX ? quota : envelope(r, answer(r)));
    const r = await analyzeEvidence(input(), opts(runner, { models: ["codex", "claude"] }));
    expect(r.status).toBe("single_model");
    expect(r.audit.draftedBy).toBe("claude");
    expect(r.unavailable[0]).toMatchObject({ provider: "codex", code: "QUOTA" });
    expect(Date.parse(r.unavailable[0]!.retryAfter) - Date.now()).toBeGreaterThan(2.9 * 3600_000);
  });

  it("a non-zero exit reports the event-stream error (login) instead of stderr noise", async () => {
    const runner: Runner = async (r) => r.command === CODEX
      ? { stdout: JSON.stringify({ type: "turn.failed", error: { message: "401 Unauthorized: not logged in" } }), stderr: "WARNING: noise", exitCode: 1, timedOut: false, outputLimitExceeded: false }
      : envelope(r, answer(r));
    const r = await analyzeEvidence(input(), opts(runner, { models: ["codex"] }));
    expect(r.status).toBe("unavailable");
    expect(r.unavailable[0]).toMatchObject({ provider: "codex", code: "AUTH_REQUIRED" });
  });

  it("a Codex tool call discards the reply", async () => {
    const runner: Runner = async (r) => r.command === CODEX
      ? codexOut(answer(r), [{ type: "item.completed", item: { id: "c", type: "command_execution", command: "ls" } }])
      : envelope(r, answer(r));
    const r = await analyzeEvidence(input(), opts(runner, { models: ["codex"] }));
    expect(r.providers.codex?.code).toBe("TOOL_USE_DETECTED");
    expect(r.dataset).toBeNull();
  });

  it("codexEvents ignores transient reconnect notices and malformed lines", () => {
    expect(codexEvents([JSON.stringify({ type: "error", message: "Reconnecting... 2/5" }), "garbage", codexStream("{}")].join("\n"))).toMatchObject({ failure: null, toolUse: false, completed: true, finalText: "{}" });
    expect(codexEvents(JSON.stringify({ type: "error", message: "stream disconnected" })).failure).toBe("stream disconnected");
  });

  it("codexArgs passes model and reasoning effort only when set", () => {
    expect(codexArgs("/x/last.txt")).not.toContain("--model");
    const a = codexArgs("/x/last.txt", "gpt-5-codex", "high");
    expect(a).toEqual(expect.arrayContaining(["--model", "gpt-5-codex", 'model_reasoning_effort="high"', "--output-last-message", "/x/last.txt"]));
  });

  it("buildEnv forwards CODEX_HOME but never OPENAI_API_KEY", () => {
    expect(buildEnv({ CODEX_HOME: "/h/.codex", OPENAI_API_KEY: "sk" })).toEqual({ CODEX_HOME: "/h/.codex" });
  });

  it("readiness probes the codex binary too", async () => {
    const runner: Runner = async (r) => (r.command === CODEX ? ok("codex-cli 0.160.1") : { stdout: "", stderr: "", exitCode: null, timedOut: false, outputLimitExceeded: false, spawnError: "ENOENT" } as RunResult);
    const r = await checkReadiness(opts(runner));
    expect(r.codex).toMatchObject({ available: true, version: "codex-cli 0.160.1" });
    expect(r.ready).toBe(true);
    expect(r.dual).toBe(false);
  });
});

describe("model selection", () => {
  it("INTELLIGENCE_MODELS parsing defaults to claude", () => {
    expect(parseModels(undefined)).toEqual(["claude"]);
    expect(parseModels("codex")).toEqual(["codex"]);
    expect(parseModels("Claude, agy")).toEqual(["claude", "agy"]);
    expect(parseModels("codex+claude")).toEqual(["codex", "claude"]);
    expect(parseModels("gpt")).toEqual(["claude"]);
    expect(parseModels("claude,codex,agy")).toEqual(["claude"]);
  });

  it("POST /v1/analyses validates models and passes them to the job (default claude)", async () => {
    const seen: unknown[] = [];
    const { app } = await setup({}, undefined, {
      collect: async () => { throw new Error("stop"); },
      intelligence: async (_i, o) => { seen.push(o.models); throw new Error("unused"); },
    });
    const post = (body: object) => app.inject({ method: "POST", url: "/v1/analyses", payload: { ticker: "005930", ...body } });
    expect((await post({ models: ["gpt"] })).statusCode).toBe(400);
    expect((await post({ models: ["claude", "claude"] })).statusCode).toBe(400);
    expect((await post({ models: [] })).statusCode).toBe(400);
    expect((await post({ mode: "demo", models: ["codex"] })).json().error.code).toBe("MODELS_PUBLIC_ONLY");
    const a = (await post({ models: ["codex", "claude"] })).json();
    const b = (await post({})).json();
    expect(a.id).not.toBe(b.id); // different model choices are different jobs
    const ja = (await app.inject({ url: a.statusUrl })).json();
    const jb = (await app.inject({ url: b.statusUrl })).json();
    expect(ja.request.models).toEqual(["codex", "claude"]);
    expect(jb.request.models).toEqual(["claude"]);
    const health = (await app.inject({ url: "/health" })).json();
    expect(health.defaultModels).toEqual(["claude"]);
  });
});
