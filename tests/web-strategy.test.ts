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
  const ids = ["q", "list", "listInfo", "ticker", "asOf", "apiKey", "keyRow", "go", "out", "form"];
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
  it("keeps polling through queued/running past the old 900-iteration (~30 min) cap until a terminal status arrives", async () => {
    const { elements, fetchCalls, fetchImpl } = await load();
    elements.ticker.value = "005930";
    (elements.form as unknown as { formValues: Record<string, string> }).formValues = { mode: "research" };

    const TOTAL_POLLS = 950; // more than the old hard-coded 900 cap
    let pollCount = 0;
    fetchImpl.current = async (url: string) => {
      if (url === "/v1/research") return new Response(JSON.stringify({ statusUrl: "/v1/research/job1", id: "job1", status: "queued" }), { status: 200 });
      if (url === "/v1/research/job1") {
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
    const getCalls = fetchCalls.filter((c) => c.url === "/v1/research/job1");
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
