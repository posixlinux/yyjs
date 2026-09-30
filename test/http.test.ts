import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { setup, type TestApp } from "./app.js";
import { AS_OF, makeDataset } from "./fixture.js";

const DEMO_NOW = new Date("2026-09-28T12:00:00Z");

// Synchronous stored-data analyses must now be requested explicitly: the default mode is "public" (async job).
const analyse = (app: TestApp, payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/v1/analyses", payload: { mode: "manual", ...payload } });

describe("HTTP happy path", () => {
  it("ingests a dataset, lists it, and analyses it (manual mode by default)", async () => {
    const { app, dataDir } = await setup();
    const post = await app.inject({ method: "POST", url: "/v1/datasets", payload: makeDataset() });
    expect(post.statusCode).toBe(201);
    expect(post.json()).toMatchObject({ created: true, ticker: "111110", mode: "manual" });
    expect(await readdir(dataDir)).toEqual(["111110.json"]);

    expect((await app.inject({ url: "/v1/companies?query=test" })).json().companies).toHaveLength(1);
    expect((await app.inject({ url: "/v1/companies?query=zzz" })).json().companies).toHaveLength(0);
    const co = await app.inject({ url: "/v1/companies/111110" });
    expect(co.json()).toMatchObject({ ticker: "111110", products: [{ id: "p1" }] });

    const res = await analyse(app, { ticker: "111110", asOf: AS_OF });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body).toMatchObject({ mode: "manual", targetQuarter: "2026Q2", modelVersion: expect.any(String) });
    expect(body.scenarios.map((s: any) => s.scenario)).toEqual(["bear", "base", "bull"]);
    expect(body.scenarios[1].valuation.status).toBe("available");
    expect(body.limitations.length).toBeGreaterThan(3);

    expect((await app.inject({ method: "POST", url: "/v1/datasets", payload: makeDataset() })).statusCode).toBe(200); // replace
  });

  it("serves health and the ingest JSON schema", async () => {
    const { app } = await setup();
    expect((await app.inject({ url: "/health" })).json().status).toBe("ok");
    const schema = (await app.inject({ url: "/v1/schema" })).json().schema;
    expect(schema.properties.company.properties.exchange).toMatchObject({ const: "KOSPI" });
  });

  it("the README/example payload is valid for ingestion and analysis", async () => {
    const { app } = await setup({}, DEMO_NOW);
    const payload = JSON.parse(await readFile("examples/dataset.example.json", "utf8"));
    expect((await app.inject({ method: "POST", url: "/v1/datasets", payload })).statusCode).toBe(201);
    const res = await analyse(app, { ticker: "123456", asOf: "2026-09-28" });
    expect(res.statusCode, res.body).toBe(200);
  });
});

describe("demo vs manual", () => {
  it("runs both fictional demo fixtures, clearly flagged synthetic", async () => {
    const { app } = await setup({}, DEMO_NOW);
    for (const ticker of ["005930", "005380"]) {
      const res = await analyse(app, { ticker, asOf: "2026-09-28", mode: "demo" });
      expect(res.statusCode, res.body).toBe(200);
      const b = res.json();
      expect(b.dataQuality.synthetic).toBe(true);
      expect(b.dataQuality.warnings.join(" ")).toContain("SYNTHETIC");
      expect(b.companyName).toContain("가상");
      expect(b.targetQuarter).toBe("2026Q4");
    }
  });

  it("never falls back to demo data in manual mode", async () => {
    const { app } = await setup({}, DEMO_NOW);
    const res = await analyse(app, { ticker: "005930", asOf: "2026-09-28" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.code).toBe("COMPANY_NOT_FOUND");
    expect(res.json().error.hint).toContain("POST /v1/datasets");
    expect((await app.inject({ url: "/v1/companies/005930" })).statusCode).toBe(404);
    expect((await app.inject({ url: "/v1/companies/005930?mode=demo" })).statusCode).toBe(200);
  });

  it("refuses demo mode when disabled (production default)", async () => {
    const { app } = await setup({ demoEnabled: false }, DEMO_NOW);
    const res = await analyse(app, { ticker: "005930", asOf: "2026-09-28", mode: "demo" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("DEMO_MODE_DISABLED");
    expect(loadConfig({ NODE_ENV: "production" }).demoEnabled).toBe(false);
    expect(loadConfig({ NODE_ENV: "production", DEMO_MODE_ENABLED: "true" }).demoEnabled).toBe(true);
    expect(loadConfig({}).demoEnabled).toBe(true);
  });

  it("rejects ingestion of synthetic datasets into the manual store", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "POST", url: "/v1/datasets", payload: { ...makeDataset(), synthetic: true } });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details[0].code).toBe("SYNTHETIC_NOT_ALLOWED");
  });
});

describe("errors", () => {
  it("returns structured 400s for bad requests", async () => {
    const { app } = await setup();
    for (const payload of [{ ticker: "59", asOf: AS_OF }, { ticker: "111110", asOf: "2026-02-30" }, { ticker: "111110", asOf: AS_OF, mode: "live" }, { ticker: "111110", asOf: AS_OF, url: "http://evil" }]) {
      const res = await analyse(app, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect((await app.inject({ url: "/v1/companies/abc" })).statusCode).toBe(400);
    expect((await app.inject({ url: "/v1/companies/111110?mode=x" })).statusCode).toBe(400);
    const bad = await app.inject({ method: "POST", url: "/v1/analyses", payload: "{oops", headers: { "content-type": "application/json" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("BAD_REQUEST");
    expect((await analyse(app, { ticker: "111110", asOf: "2026-01-16" })).json().error.code).toBe("INVALID_AS_OF"); // future relative to clock
  });

  it("returns 404 for unknown tickers and routes", async () => {
    const { app } = await setup();
    expect((await analyse(app, { ticker: "999999", asOf: AS_OF })).statusCode).toBe(404);
    const r = await app.inject({ url: "/nope" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("ROUTE_NOT_FOUND");
  });

  it("returns 422 with issue list for invalid datasets and never stores them", async () => {
    const { app, dataDir } = await setup();
    const ds = makeDataset();
    ds.products[0].revenue[3].currency = "EUR";
    ds.markets[0].observations[3].basis = "annual";
    const res = await app.inject({ method: "POST", url: "/v1/datasets", payload: ds });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details.map((i: any) => i.code)).toEqual(expect.arrayContaining(["CURRENCY_MISMATCH", "ANNUAL_QUARTERLY_CONFUSION"]));
    expect(await readdir(dataDir)).toEqual([]);
  });

  it("rejects ingest of future evidence relative to the server clock", async () => {
    const { app } = await setup();
    const ds = makeDataset();
    ds.company.sources[0].publishedAt = "2026-06-01";
    const res = await app.inject({ method: "POST", url: "/v1/datasets", payload: ds });
    expect(res.statusCode).toBe(422);
    expect(res.json().error.details[0].code).toBe("FUTURE_EVIDENCE");
  });

  it("returns 422 at analysis time for stale or future evidence in a stored dataset", async () => {
    const { app } = await setup({}, new Date("2026-02-15T00:00:00Z"));
    await app.inject({ method: "POST", url: "/v1/datasets", payload: makeDataset() });
    const stale = await analyse(app, { ticker: "111110", asOf: "2026-01-31" }); // quote is 21 days old
    expect(stale.statusCode).toBe(422);
    expect(stale.json().error.details.map((i: any) => i.code)).toContain("STALE_EVIDENCE");
    const future = await analyse(app, { ticker: "111110", asOf: "2026-01-05" });
    expect(future.statusCode).toBe(422);
    expect(future.json().error.details.map((i: any) => i.code)).toContain("FUTURE_EVIDENCE");
  });

  it("returns 502 when a stored dataset is corrupt", async () => {
    const { app, dataDir } = await setup();
    await app.inject({ method: "POST", url: "/v1/datasets", payload: makeDataset() });
    const { writeFile } = await import("node:fs/promises");
    await writeFile(path.join(dataDir, "111110.json"), "{}");
    const res = await analyse(app, { ticker: "111110", asOf: AS_OF });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("DATA_PROVIDER_ERROR");
  });

  it("enforces the body size limit with 413", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "POST", url: "/v1/datasets", payload: { pad: "x".repeat(1_100_000) } });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("API key and network exposure", () => {
  it("requires x-api-key for dataset mutations only, without echoing the key", async () => {
    const { app } = await setup({ apiKey: "s3cret-key" });
    const none = await app.inject({ method: "POST", url: "/v1/datasets", payload: makeDataset() });
    expect(none.statusCode).toBe(401);
    const wrong = await app.inject({ method: "POST", url: "/v1/datasets", payload: makeDataset(), headers: { "x-api-key": "nope" } });
    expect(wrong.statusCode).toBe(401);
    expect(wrong.body).not.toContain("s3cret-key");
    const ok = await app.inject({ method: "POST", url: "/v1/datasets", payload: makeDataset(), headers: { "x-api-key": "s3cret-key" } });
    expect(ok.statusCode).toBe(201);
    expect((await app.inject({ url: "/v1/companies" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/health" })).body).not.toContain("s3cret-key");
  });

  it("refuses to bind a non-loopback host without an API key", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrow(/API_KEY/);
    expect(loadConfig({ HOST: "0.0.0.0", API_KEY: "k" }).host).toBe("0.0.0.0");
    expect(loadConfig({}).host).toBe("127.0.0.1");
  });
});
