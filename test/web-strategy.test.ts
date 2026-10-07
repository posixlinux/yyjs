import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";
import vm from "node:vm";

// public/app.js is a plain browser script (no module exports, no DOM library dependency beyond the tiny surface
// it actually touches: getElementById/createElement/createTextNode/append/setAttribute). We stand up just that
// surface with hand-rolled stubs and run the real source through vm so the tests exercise the shipped code, not a
// reimplementation of it.

type StubNode = {
  tagName?: string;
  nodeType: number;
  textContent: string;
  className: string;
  attrs: Record<string, string>;
  children: StubNode[];
  value: string;
  hidden: boolean;
  disabled: boolean;
  dataset: Record<string, string>;
  _listeners: Record<string, ((ev: unknown) => unknown)[]>;
  id?: string;
  setAttribute(k: string, v: string): void;
  getAttribute(k: string): string | undefined;
  append(...nodes: (StubNode | string)[]): void;
  appendChild(n: StubNode): StubNode;
  replaceChildren(...nodes: StubNode[]): void;
  addEventListener(type: string, fn: (ev: unknown) => unknown): void;
  dispatchEvent(ev: { type: string }): void;
  closest(): null;
  focus(): void;
};

function makeNode(tagName?: string): StubNode {
  const node: StubNode = {
    tagName,
    nodeType: 1,
    textContent: "",
    className: "",
    attrs: {},
    children: [],
    value: "",
    hidden: false,
    disabled: false,
    dataset: {},
    _listeners: {},
    setAttribute(k, v) {
      node.attrs[k] = v;
    },
    getAttribute(k) {
      return node.attrs[k];
    },
    append(...nodes) {
      for (const n of nodes) if (typeof n !== "string") node.children.push(n);
    },
    appendChild(n) {
      node.children.push(n);
      return n;
    },
    replaceChildren(...nodes) {
      node.children = nodes;
    },
    addEventListener(type, fn) {
      (node._listeners[type] ??= []).push(fn);
    },
    dispatchEvent(ev) {
      for (const fn of node._listeners[ev.type] ?? []) fn(ev);
    },
    closest() {
      return null;
    },
    focus() {},
  };
  return node;
}

/** Concatenates every textContent in the subtree, deep-first, so assertions can search rendered output loosely. */
function allText(n: StubNode): string {
  return [n.textContent, ...n.children.map(allText)].filter(Boolean).join(" ");
}

function findByHref(n: StubNode, hrefSubstring: string): StubNode | null {
  if (n.attrs?.href && n.attrs.href.includes(hrefSubstring)) return n;
  for (const c of n.children ?? []) {
    const f = findByHref(c, hrefSubstring);
    if (f) return f;
  }
  return null;
}

function anyHref(n: StubNode): string[] {
  return [n.attrs?.href, ...(n.children ?? []).flatMap(anyHref)].filter((x): x is string => !!x);
}

const APP_JS_PATH = path.join(path.dirname(fileURLToPath(import.meta.url)), "..", "public", "app.js");
const SOURCE = readFileSync(APP_JS_PATH, "utf8");

type Elements = Record<string, StubNode>;

function buildContext() {
  const ids = ["q", "qToggle", "market", "sort", "models", "list", "listInfo", "ticker", "asOf", "apiKey", "keyRow", "go", "rank", "out", "form"];
  const elements: Elements = {};
  for (const id of ids) elements[id] = makeNode("stub");

  const fetchCalls: { url: string; init?: RequestInit }[] = [];
  const fetchImpl = { current: async (_url: string, _init?: RequestInit): Promise<Response> => new Response("{}", { status: 200 }) };
  const fetchStub = ((url: string, init?: RequestInit) => {
    fetchCalls.push({ url, init });
    return fetchImpl.current(url, init);
  }) as unknown as typeof fetch;

  const store = new Map<string, string>();
  const sessionStorage = {
    getItem: (k: string) => store.get(k) ?? null,
    setItem: (k: string, v: string) => void store.set(k, v),
  };

  class FakeFormData {
    private form: StubNode;
    constructor(form: StubNode) {
      this.form = form;
    }
    get(name: string) {
      return (this.form as unknown as { formValues?: Record<string, string> }).formValues?.[name] ?? null;
    }
  }

  const document = {
    getElementById: (id: string) => elements[id],
    createElement: (tag: string) => makeNode(tag),
    createTextNode: (text: string) => ({ nodeType: 3, textContent: text, children: [] as StubNode[], attrs: {} }) as unknown as StubNode,
  };

  const context: Record<string, unknown> = {
    document,
    fetch: fetchStub,
    FormData: FakeFormData,
    sessionStorage,
    URL,
    console,
    setTimeout: (fn: () => void) => {
      fn();
      return 0 as unknown as ReturnType<typeof setTimeout>;
    },
    clearTimeout: () => {},
    setInterval: () => 0,
    clearInterval: () => {},
    Date,
    Object,
    Math,
    Number,
    String,
    Array,
    Promise,
    Response,
    Error,
  };
  context.globalThis = context;
  vm.createContext(context);
  return { context, elements, fetchCalls, fetchImpl, sessionStorage };
}

async function load() {
  const { context, elements, fetchCalls, fetchImpl } = buildContext();
  const script = new vm.Script(SOURCE, { filename: "app.js" });
  script.runInContext(context);
  // init() runs immediately and calls /health then /v1/universe; let its microtasks settle before tests continue.
  await new Promise((r) => setTimeout(r, 0));
  await new Promise((r) => setTimeout(r, 0));
  return { context, elements, fetchCalls, fetchImpl };
}

describe("public/app.js strategyAuto rendering", () => {
  it("shows one quarter of public consensus without EPS strategy inputs or a forecast", async () => {
    const { context } = await load();
    const render = context.renderStrategyAuto as (sa: unknown) => StubNode;
    const node = render({ status: "insufficient_data", mode: "live", quarterlyConsensus: [{
      consensus: { quarter: "2026Q4", revenueKRW: 1e12, operatingProfitKRW: -1e8, netIncomeKRW: null, epsKRW: 123,
        observedAt: "2026-10-01T01:00:00Z", sourceUrl: "https://m.stock.naver.com/api/stock/005930/finance/quarter" },
      status: "consensus_only", revenue: null, operatingProfit: null, note: "같은 분기 전망 없음" }], notes: [], missing: [] });
    const text = allText(node);
    expect(text).toContain("분기 컨센서스");
    expect(text).toContain("2026Q4");
    expect(text).toContain("123원");
    expect(text).toContain("1조원");
    expect(text).toContain("EPS(참고)");
    expect(text).not.toContain("조회 가능한 분기 컨센서스가 없습니다");
    expect(findByHref(node, "/finance/quarter")).not.toBeNull();
  });

  it("presents a single-quarter estimate as a finished result, labelled with its quarter, when no consensus exists", async () => {
    const { context } = await load();
    const render = context.renderStrategyAuto as (sa: unknown) => StubNode;
    const text = allText(render({ status: "estimate_only", mode: "live", notes: [], missing: [], quarterlyConsensus: [], risk: null,
      bridge: { ntmEpsKRW: 1234, quarters: [{ quarter: "2026Q4", revenueKRW: 1e12, operatingProfitKRW: 1e11, epsKRW: 1234 }] } }));
    expect(text).toContain("한 분기 실적 추정(단기, 최장 3개월)");
    expect(text).toContain("추정 완료");
    expect(text).toContain("2026Q4 추정 EPS");
    expect(text).not.toContain("4개 분기");
  });

  it("shows the quarterly funding table and both scenarios when risk is available", async () => {
    const { context } = await load();
    const render = context.renderStrategyAuto as (sa: unknown) => StubNode;
    const text = allText(render({ status: "insufficient_data", mode: "live", notes: [], missing: [],
      risk: { base: { minimumQuarterBoundaryCashKRW: 100, peakAdditionalFundingRequiredKRW: 0,
        quarters: [{ quarter: "2026Q4", openingCashKRW: 100, capexKRW: 80, deltaWorkingCapitalKRW: 5, debtPrincipalDueKRW: 25, endingCashKRW: 232, additionalFundingRequiredKRW: 0 }] },
        stress: { minimumQuarterBoundaryCashKRW: -30, peakAdditionalFundingRequiredKRW: 30 } } }));
    expect(text).toContain("자금 상태(기본 시나리오)");
    expect(text).toContain("하방 시나리오");
    expect(text).toContain("설비·무형자산 투자");
    expect(text).toContain("운전자본 증가");
    expect(text).toContain("2026Q4");
    expect(text).not.toContain("자금 계획을 확보하지 못했습니다");
  });

  it("labels a statement-derived funding plan as a disclosed-statement derivation, not a model estimate", async () => {
    const { context } = await load();
    const render = context.renderStrategyAuto as (sa: unknown) => StubNode;
    const node = render({ status: "estimate_only", mode: "live", missing: [], fundingOrigin: "derived_from_filings",
      notes: ["자금 계획은 모델 초안이 아니라 2025 Q3 연결 재무제표(기말 2025-09-30, 접수번호 20251113000661)에서 결정론적으로 파생했습니다."],
      risk: { base: { minimumQuarterBoundaryCashKRW: 100, peakAdditionalFundingRequiredKRW: 0,
        quarters: [{ quarter: "2025Q4", openingCashKRW: 100, capexKRW: 80, deltaWorkingCapitalKRW: 5, debtPrincipalDueKRW: 25, endingCashKRW: 232, additionalFundingRequiredKRW: 0 }] },
        stress: { minimumQuarterBoundaryCashKRW: 50, peakAdditionalFundingRequiredKRW: 0 } },
      noRefinancingBound: { currentDebtKRW: 400, assumedPrincipalDueKRW: 100, baseEndingCashKRW: -68, stressEndingCashKRW: -150, baseAdditionalFundingRequiredKRW: 68, stressAdditionalFundingRequiredKRW: 150 },
      assumptions: [{ fieldPath: "forecast.funding.assumptions", rationale: "[공시 재무제표 결정론적 파생, 모델 추정 아님] 기초 현금=...",
        source: { title: "DART 연결 재무제표", url: "https://dart.fss.or.kr/dsaf001/main.do?rcpNo=20251113000661", kind: "filing", knownAt: "2025-11-13T00:00:00+09:00" },
        isModelEstimate: false, independentlyAudited: false }] });
    const text = allText(node);
    expect(text).toContain("DART 연결 재무제표(재무상태표·현금흐름표 누적액)에서 결정론적으로 파생");
    expect(text).toContain("공시 재무제표 기반 결정론적 파생 가정(모델 추정 아님)");
    expect(text).toContain("모델 추정치·공시 파생 가정");
    expect(text).toContain("접수번호 20251113000661");
    expect(text).toContain("차환 없음 보수적 경우");
    expect(text).toContain("4개 분기 균등 도래 가정");
    expect(text).not.toContain("자금 계획을 확보하지 못했습니다");
  });

  it("shows the concrete missing funding input beside the unavailable message", async () => {
    const { context } = await load();
    const render = context.renderStrategyAuto as (sa: unknown) => StubNode;
    const node = render({ status: "insufficient_data", mode: "live", risk: null,
      missing: [{ field: "funding", code: "FUNDING_INPUT_MISSING", message: "차입 만기 자료가 없습니다." }] });
    const textOutsideDetails = (n: StubNode): string => n.tagName === "details" ? "" : [n.textContent, ...n.children.map(textOutsideDetails)].join(" ");
    expect(textOutsideDetails(node)).toContain("차입 만기 자료가 없습니다.");
  });

  it("shows a plain Korean analysis-only title, generatedAt, mode, and a plain-Korean 'no independent audit' notice (no raw dev fields)", async () => {
    const { context } = await load();
    const renderStrategyAuto = context.renderStrategyAuto as (sa: unknown) => StubNode;
    const sa = {
      status: "eligible",
      mode: "live",
      decisionAt: "2026-09-30T10:00:00+09:00",
      generatedAt: "2026-09-29T08:00:00+09:00",
      independentlyAudited: false,
      bridge: null,
      risk: null,
      evaluation: null,
      missing: [],
      notes: [],
      assumptions: [
        {
          fieldPath: "forecast.quarters[0].segments[0].assumptions",
          rationale: "물량은 전분기 대비 5% 증가로 가정",
          source: { title: "3Q26 IR 자료", url: "https://example.com/ir.pdf", kind: "filing", knownAt: "2026-09-01T00:00:00+09:00" },
          isModelEstimate: true,
          independentlyAudited: false,
        },
      ],
    };
    const node = renderStrategyAuto(sa);
    const text = allText(node);
    expect(text).toContain("실적 전망·투자 위험");
    expect(text).toContain("생성 시각");
    expect(text).toContain(sa.generatedAt);
    expect(text).toContain("실시간");
    expect(text).toContain("독립 감사: 받지 않음");
    expect(text).toContain("모델 추정 · 별도 모델 검토 없음");
    expect(text).not.toMatch(/매수|매도|주문 실행/); // analysis only, never an order
    // Developer-facing raw fields/field paths must never reach the human-readable copy.
    expect(text).not.toContain("isModelEstimate=");
    expect(text).not.toContain("independentlyAudited=");
    expect(text).not.toContain("forecast.quarters[0].segments[0].assumptions");
    expect(text).not.toContain("인용·스키마의 결정론적 검사");
    // The fieldPath is instead rendered as readable quarter/segment/assumption labels.
    expect(text).toContain("1분기");
    expect(text).toContain("세그먼트 1");
    const link = findByHref(node, "example.com/ir.pdf");
    expect(link).not.toBeNull();
    expect(link?.attrs.rel).toContain("noopener");
  });

  it("labels a retrospective run as historical research, not a live signal", async () => {
    const { context } = await load();
    const renderStrategyAuto = context.renderStrategyAuto as (sa: unknown) => StubNode;
    const sa = {
      status: "insufficient_data",
      mode: "retrospective_research",
      decisionAt: "2026-06-30T23:59:59+09:00",
      generatedAt: null,
      independentlyAudited: false,
      bridge: null,
      risk: null,
      evaluation: null,
      missing: [{ field: "forecast", code: "FORECAST_UNAVAILABLE", message: "no verified forecast" }],
      notes: [],
      assumptions: [],
    };
    const node = renderStrategyAuto(sa);
    const text = allText(node);
    expect(text).toContain("과거 재현");
    expect(text).toContain("실거래 신호 아님");
    expect(text).toContain("FORECAST_UNAVAILABLE");
    expect(text).toContain("없음"); // generatedAt fallback text when no forecast was extracted
  });

  it("never turns a non-https assumption source URL into a clickable link (safeLink falls through to text)", async () => {
    const { context } = await load();
    const renderStrategyAuto = context.renderStrategyAuto as (sa: unknown) => StubNode;
    const sa = {
      status: "insufficient_data",
      mode: "live",
      decisionAt: "2026-09-30T10:00:00+09:00",
      generatedAt: "2026-09-29T08:00:00+09:00",
      independentlyAudited: false,
      bridge: null,
      risk: null,
      evaluation: null,
      missing: [],
      notes: [],
      assumptions: [
        {
          fieldPath: "forecast.quarters[0].segments[0].assumptions",
          rationale: "위험한 링크",
          source: { title: "악성 링크", url: "javascript:alert(1)", kind: "manual_assumption", knownAt: "2026-09-01T00:00:00+09:00" },
          isModelEstimate: true,
          independentlyAudited: false,
        },
      ],
    };
    const node = renderStrategyAuto(sa);
    expect(anyHref(node).some((h) => h.startsWith("javascript:"))).toBe(false);
    expect(allText(node)).toContain("악성 링크"); // still shown as inert text, never dropped silently
  });
});

describe("public/app.js job polling", () => {
  it.each(["completed", "partial", "failed"])("long-polls without fixed delays, patches only progress nodes and fills the result at %s", async (terminal) => {
    const { context, elements, fetchImpl } = await load();
    elements.ticker.value = "005930";
    const delays: number[] = [];
    context.setTimeout = (fn: () => void, delay: number) => { delays.push(delay); fn(); return 0; };
    // Local elapsed-time ticker: captured so the test drives it like a 1s clock.
    let ticker: (() => void) | null = null;
    let cleared = false;
    context.setInterval = (fn: () => void, ms: number) => { expect(ms).toBe(1000); ticker = fn; return 7; };
    context.clearInterval = (id: number) => { if (id === 7) cleared = true; };
    const replace = elements.out.replaceChildren;
    let renders = 0;
    elements.out.replaceChildren = (...nodes) => { renders++; replace(...nodes); };
    let polls = 0;
    let waitingNode: StubNode | undefined;
    let contentNode: StubNode | undefined;
    let hintNode: StubNode | undefined;
    let resultRenders = 0;
    let clock = 1_000_000;
    context.Date = { now: () => clock };
    const urls: string[] = [];
    fetchImpl.current = async (url: string) => {
      if (url === "/v1/analyses") return new Response(JSON.stringify({ statusUrl: "/v1/analyses/job1", status: "queued" }));
      urls.push(url);
      expect(renders).toBe(1);
      waitingNode ??= elements.out.children[0];
      expect(elements.out.children[0]).toBe(waitingNode);
      if (!contentNode) {
        contentNode = elements.out.children[1];
        hintNode = contentNode.children[0];
        const replaceResult = contentNode.replaceChildren;
        contentNode.replaceChildren = (...nodes) => { resultRenders++; replaceResult(...nodes); };
      }
      expect(elements.out.children[1]).toBe(contentNode);
      expect(contentNode.children[0]).toBe(hintNode);
      expect(resultRenders).toBe(0);
      expect(allText(waitingNode!)).toContain(polls === 0 ? "대기 중" : "진행 중");
      // while the server holds the request, the local clock keeps the elapsed time moving second by second
      for (let i = 0; i < 20; i++) { clock += 1000; ticker!(); }
      expect(allText(waitingNode!)).toContain(`${(polls + 1) * 20}초`);
      expect(cleared).toBe(false);
      expect(elements.go.disabled).toBe(true);
      polls++;
      return new Response(JSON.stringify({ status: polls < 4 ? "running" : terminal, request: { ticker: "005930" },
        ...(terminal === "failed" && polls === 4 ? { error: { code: "JOB_TIMEOUT", message: "Timed out" } } : {}) }));
    };
    await elements.form._listeners.submit[0]({ preventDefault() {} });
    expect(polls).toBe(4);
    expect(urls.every((u) => u === "/v1/analyses/job1?wait=55")).toBe(true);
    expect(delays).toEqual([]); // no fixed-interval polling
    expect(renders).toBe(1);
    expect(resultRenders).toBe(1);
    expect(elements.out.children[0]).toBe(waitingNode);
    expect(elements.out.children[1]).toBe(contentNode);
    // frozen at the moment the terminal response arrived: later ticks (if any) must not move it
    expect(cleared).toBe(true);
    expect(allText(waitingNode!)).toContain("80초");
    expect(elements.go.disabled).toBe(false);
    if (terminal === "failed") expect(allText(elements.out)).toContain("JOB_TIMEOUT");
  });

  it("keeps polling through queued/running past the old 900-iteration (~30 min) cap until a terminal status arrives", async () => {
    const { elements, fetchCalls, fetchImpl } = await load();
    elements.ticker.value = "005930";
    (elements.form as unknown as { formValues: Record<string, string> }).formValues = { mode: "research" };

    const TOTAL_POLLS = 950; // more than the old hard-coded 900 cap
    let pollCount = 0;
    fetchImpl.current = async (url: string) => {
      if (url === "/v1/research") return new Response(JSON.stringify({ statusUrl: "/v1/research/job1", id: "job1", status: "queued" }), { status: 200 });
      if (url === "/v1/research/job1?wait=55") {
        pollCount++;
        const status = pollCount >= TOTAL_POLLS ? "completed" : pollCount % 2 === 0 ? "running" : "queued";
        return new Response(JSON.stringify({ id: "job1", status, request: { ticker: "005930" }, result: status === "completed" ? { note: "done" } : undefined }), { status: 200 });
      }
      return new Response("{}", { status: 200 });
    };

    const submitHandlers = elements.form._listeners["submit"] ?? [];
    expect(submitHandlers.length).toBe(1);
    let prevented = false;
    await submitHandlers[0]!({ preventDefault: () => (prevented = true) });

    expect(prevented).toBe(true);
    expect(pollCount).toBe(TOTAL_POLLS); // proves the loop was not cut off at 900
    const getCalls = fetchCalls.filter((c) => c.url === "/v1/research/job1?wait=55");
    expect(getCalls.length).toBe(TOTAL_POLLS);
    const outText = allText(elements.out);
    expect(outText).toContain("완료"); // terminal "completed" status rendered
  });

  it("surfaces a job lookup failure (e.g. evicted/expired job) as a normal error box instead of hanging", async () => {
    const { elements, fetchImpl } = await load();
    elements.ticker.value = "005930";
    (elements.form as unknown as { formValues: Record<string, string> }).formValues = { mode: "research" };

    fetchImpl.current = async (url: string) => {
      if (url === "/v1/research") return new Response(JSON.stringify({ statusUrl: "/v1/research/job2" }), { status: 200 });
      return new Response(JSON.stringify({ error: { code: "JOB_NOT_FOUND", message: "No research job job2" } }), { status: 404 });
    };

    const submitHandlers = elements.form._listeners["submit"] ?? [];
    await submitHandlers[0]!({ preventDefault: () => {} });

    const outText = allText(elements.out);
    expect(outText).toContain("JOB_NOT_FOUND");
  });
});
