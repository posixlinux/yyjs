import { CollectionError } from "./types.js";

/** Only these hosts are ever fetched. Receipt URLs on dart.fss.or.kr are emitted as links, never fetched. */
export const ALLOWED_HOSTS: ReadonlySet<string> = new Set([
  "m.stock.naver.com", "n.news.naver.com", "openapi.naver.com", "opendart.fss.or.kr",
  "www.sec.gov", "data.sec.gov", "api.edinet-fsa.go.jp", "disclosure2dl.edinet-fsa.go.jp",
]);

/** Hosts that are only reachable for an exact path shape; `query: false` also forbids a query/fragment. */
const PATH_RULES: Record<string, { path: RegExp; query: boolean }> = {
  "n.news.naver.com": { path: /^\/(?:mnews\/)?article\/\d+\/\d+$/, query: false },
  "www.sec.gov": { path: /^\/files\/company_tickers\.json$/, query: false },
  "data.sec.gov": { path: /^\/api\/xbrl\/companyfacts\/CIK\d{10}\.json$/, query: false },
  "api.edinet-fsa.go.jp": { path: /^\/api\/v2\/documents(?:\.json|\/[A-Z0-9]{8})$/, query: true },
  "disclosure2dl.edinet-fsa.go.jp": { path: /^\/searchdocument\/codelist\/Edinetcode\.zip$/, query: false },
};

export interface HttpConfig {
  fetch: typeof fetch;
  timeoutMs: number;
  maxBytes: number;
  maxRequests: number;
  secrets: string[];
  signal?: AbortSignal | undefined;
}

export interface RequestOptions {
  headers?: Record<string, string>;
  maxBytes?: number;
  /** >0 caches (and de-duplicates concurrent calls for) this URL for that many ms. */
  ttlMs?: number;
}

export interface HttpClient {
  bytes(url: string, opts?: RequestOptions): Promise<Buffer>;
  json(url: string, opts?: RequestOptions): Promise<unknown>;
  /** Cache + in-flight de-duplication for derived values (e.g. the parsed corp-code index). */
  memo<T>(key: string, ttlMs: number, produce: () => Promise<T>): Promise<T>;
  requests(): number;
}

interface Entry {
  expires: number;
  value: Promise<unknown>;
}

// One cache per fetch implementation: production shares the global fetch's cache, injected fakes stay isolated.
const caches = new WeakMap<typeof fetch, Map<string, Entry>>();
const MAX_ENTRIES = 64;

export function redact(text: string, secrets: string[]): string {
  let out = text.replace(/(crtfc_key|client[_-]?secret|client[_-]?id|subscription-key)=[^&\s"']*/gi, "$1=***");
  for (const s of secrets) if (s) out = out.split(s).join("***").split(encodeURIComponent(s)).join("***");
  return out;
}

export function createHttp(cfg: HttpConfig): HttpClient {
  let cache = caches.get(cfg.fetch);
  if (!cache) caches.set(cfg.fetch, (cache = new Map()));
  const store = cache;
  let used = 0;

  function memo<T>(key: string, ttlMs: number, produce: () => Promise<T>): Promise<T> {
    const now = Date.now();
    const hit = store.get(key);
    if (hit && hit.expires > now) return hit.value as Promise<T>;
    const value = produce();
    if (ttlMs > 0) {
      store.set(key, { expires: now + ttlMs, value });
      while (store.size > MAX_ENTRIES) store.delete(store.keys().next().value as string);
      value.catch(() => {
        if (store.get(key)?.value === value) store.delete(key);
      });
    }
    return value;
  }

  async function fetchBytes(url: string, opts: RequestOptions): Promise<Buffer> {
    let u: URL;
    try {
      u = new URL(url);
    } catch {
      throw new CollectionError("blocked_url", "Invalid URL");
    }
    if (u.protocol !== "https:" || u.username || u.password || u.port || !ALLOWED_HOSTS.has(u.hostname)) {
      throw new CollectionError("blocked_url", `Host not allowed: ${u.hostname}`);
    }
    const rule = PATH_RULES[u.hostname];
    if (rule && (!rule.path.test(u.pathname) || (!rule.query && u.search) || u.hash)) throw new CollectionError("blocked_url", `Path not allowed on ${u.hostname}`);
    const label = `${u.host}${u.pathname}`;
    if (++used > cfg.maxRequests) throw new CollectionError("request_budget_exceeded", `More than ${cfg.maxRequests} upstream requests`);
    const timeout = AbortSignal.timeout(cfg.timeoutMs);
    const signal = cfg.signal ? AbortSignal.any([timeout, cfg.signal]) : timeout;
    const max = opts.maxBytes ?? cfg.maxBytes;

    let res: Response;
    try {
      res = await cfg.fetch(u.href, { headers: opts.headers ?? {}, redirect: "manual", signal });
    } catch (e) {
      if (timeout.aborted) throw new CollectionError("timeout", `Timed out after ${cfg.timeoutMs}ms: ${label}`, true);
      if (cfg.signal?.aborted) throw new CollectionError("aborted", `Aborted: ${label}`);
      throw new CollectionError("network_error", `Request failed for ${label}: ${redact(String((e as Error)?.message ?? e), cfg.secrets)}`, true);
    }
    if ((res.status >= 300 && res.status < 400) || res.type === "opaqueredirect") {
      await res.body?.cancel().catch(() => {});
      throw new CollectionError("redirect_rejected", `Redirect (HTTP ${res.status}) rejected: ${label}`);
    }
    if (!res.ok) {
      await res.body?.cancel().catch(() => {});
      throw new CollectionError("http_error", `HTTP ${res.status} from ${label}`, res.status === 429 || res.status >= 500);
    }
    const declared = Number(res.headers.get("content-length"));
    if (declared > max) {
      await res.body?.cancel().catch(() => {});
      throw new CollectionError("response_too_large", `Response from ${label} exceeds ${max} bytes`);
    }
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (res.body) {
        for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
          size += chunk.length;
          if (size > max) throw new CollectionError("response_too_large", `Response from ${label} exceeds ${max} bytes`);
          chunks.push(chunk);
        }
      }
    } catch (e) {
      if (e instanceof CollectionError) throw e;
      if (timeout.aborted) throw new CollectionError("timeout", `Timed out reading body: ${label}`, true);
      throw new CollectionError("network_error", `Body read failed for ${label}`, true);
    }
    return Buffer.concat(chunks);
  }

  const bytes = (url: string, opts: RequestOptions = {}) =>
    opts.ttlMs && opts.ttlMs > 0 ? memo(`GET ${url}`, opts.ttlMs, () => fetchBytes(url, opts)) : fetchBytes(url, opts);

  return {
    bytes,
    async json(url, opts = {}) {
      const text = (await bytes(url, opts)).toString("utf8").replace(/^﻿/, "");
      try {
        return JSON.parse(text);
      } catch {
        const u = new URL(url);
        throw new CollectionError("invalid_response", `Non-JSON response from ${u.host}${u.pathname}`);
      }
    },
    memo,
    requests: () => used,
  };
}
