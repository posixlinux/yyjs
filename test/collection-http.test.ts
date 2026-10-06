import { describe, expect, it } from "vitest";
import { createHttp } from "../src/collection/http.js";

const URL_ = "https://m.stock.naver.com/api/stock/005930/basic";
const base = { timeoutMs: 5_000, maxBytes: 1_000_000, maxRequests: 10, secrets: [] };

/** A fake fetch whose first response is held until released (or the request is aborted). */
function slowFetch() {
  let calls = 0;
  let release!: () => void;
  const gate = new Promise<void>((r) => (release = r));
  const fetchFn = (async (_url: string, init?: RequestInit) => {
    calls++;
    const signal = init?.signal;
    await new Promise<void>((resolve, reject) => {
      if (signal?.aborted) return reject(signal.reason);
      signal?.addEventListener("abort", () => reject(signal.reason), { once: true });
      gate.then(resolve);
    });
    return new Response(JSON.stringify({ ok: calls }), { status: 200 });
  }) as typeof fetch;
  return { fetchFn, release, calls: () => calls };
}

describe("shared HTTP cache across jobs", () => {
  it("does not hand one job's abort to another job waiting on the same request", async () => {
    const f = slowFetch();
    const a = new AbortController();
    const jobA = createHttp({ ...base, fetch: f.fetchFn, signal: a.signal });
    const jobB = createHttp({ ...base, fetch: f.fetchFn });

    const pa = jobA.json(URL_, { ttlMs: 60_000 });
    const pb = jobB.json(URL_, { ttlMs: 60_000 }); // joins A's in-flight request
    a.abort(new Error("job A timed out"));
    await expect(pa).rejects.toMatchObject({ code: "aborted" });

    f.release();
    await expect(pb).resolves.toEqual({ ok: 2 }); // B fetched for itself
    expect(f.calls()).toBe(2);
  });

  it("still shares a successful in-flight request", async () => {
    const f = slowFetch();
    const jobA = createHttp({ ...base, fetch: f.fetchFn });
    const jobB = createHttp({ ...base, fetch: f.fetchFn });
    const pa = jobA.json(URL_, { ttlMs: 60_000 });
    const pb = jobB.json(URL_, { ttlMs: 60_000 });
    f.release();
    expect(await pa).toEqual({ ok: 1 });
    expect(await pb).toEqual({ ok: 1 });
    expect(f.calls()).toBe(1);
  });
});
