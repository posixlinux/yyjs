import { copyFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { loadConfig } from "../src/config.js";
import { demoDir, setup, type TestApp } from "./app.js";
import { tmpDir } from "./fixture.js";

const DEMO_NOW = new Date("2026-09-28T12:00:00Z");

// Synchronous analyses of the bundled demo fixtures must be requested explicitly: the default mode is "public" (async job).
const analyse = (app: TestApp, payload: Record<string, unknown>) => app.inject({ method: "POST", url: "/v1/analyses", payload: { mode: "demo", ...payload } });

describe("HTTP happy path", () => {
  it("serves health and the dataset JSON schema", async () => {
    const { app } = await setup();
    expect((await app.inject({ url: "/health" })).json().status).toBe("ok");
    const schema = (await app.inject({ url: "/v1/schema" })).json().schema;
    expect(schema.properties.company.properties.exchange).toMatchObject({ enum: ["KOSPI", "KOSDAQ"] });
  });

  it("rejects mode=manual and has no dataset ingestion route", async () => {
    const { app } = await setup({}, DEMO_NOW);
    expect((await app.inject({ method: "POST", url: "/v1/datasets", payload: {} })).statusCode).toBe(404);
    const res = await analyse(app, { ticker: "005930", asOf: "2026-09-28", mode: "manual" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("VALIDATION_ERROR");
    expect((await app.inject({ url: "/v1/companies/005930?mode=manual" })).statusCode).toBe(200); // unknown query keys are ignored
  });
});

describe("demo", () => {
  it("runs both fictional demo fixtures, clearly flagged synthetic", async () => {
    const { app } = await setup({}, DEMO_NOW);
    for (const ticker of ["005930", "005380"]) {
      const res = await analyse(app, { ticker, asOf: "2026-09-28" });
      expect(res.statusCode, res.body).toBe(200);
      const b = res.json();
      expect(b.mode).toBe("demo");
      expect(b.dataQuality.synthetic).toBe(true);
      expect(b.dataQuality.warnings.join(" ")).toContain("SYNTHETIC");
      expect(b.companyName).toContain("가상");
      expect(b.targetQuarter).toBe("2026Q3"); // results reported through 2026Q2
    }
  });

  it("lists and profiles the demo fixtures", async () => {
    const { app } = await setup({}, DEMO_NOW);
    expect((await app.inject({ url: "/v1/companies" })).json().companies.map((c: any) => c.ticker)).toEqual(["005380", "005930"]);
    expect((await app.inject({ url: "/v1/companies?query=zzz" })).json().companies).toHaveLength(0);
    expect((await app.inject({ url: "/v1/companies/005930" })).json()).toMatchObject({ ticker: "005930", mode: "demo", synthetic: true });
    expect((await app.inject({ url: "/v1/companies/111110" })).statusCode).toBe(404);
  });

  it("refuses demo mode when disabled (production default)", async () => {
    const { app } = await setup({ demoEnabled: false }, DEMO_NOW);
    const res = await analyse(app, { ticker: "005930", asOf: "2026-09-28" });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe("DEMO_MODE_DISABLED");
    expect((await app.inject({ url: "/v1/companies" })).json().companies).toEqual([]);
    expect(loadConfig({ NODE_ENV: "production" }).demoEnabled).toBe(false);
    expect(loadConfig({ NODE_ENV: "production", DEMO_MODE_ENABLED: "true" }).demoEnabled).toBe(true);
    expect(loadConfig({}).demoEnabled).toBe(true);
  });
});

describe("errors", () => {
  it("returns structured 400s for bad requests", async () => {
    const { app } = await setup({}, DEMO_NOW);
    for (const payload of [{ ticker: "59", asOf: "2026-09-28" }, { ticker: "005930", asOf: "2026-02-30" }, { ticker: "005930", asOf: "2026-09-28", mode: "live" }, { ticker: "005930", asOf: "2026-09-28", url: "http://evil" }]) {
      const res = await analyse(app, payload);
      expect(res.statusCode).toBe(400);
      expect(res.json().error.code).toBe("VALIDATION_ERROR");
    }
    expect((await app.inject({ url: "/v1/companies/abc" })).statusCode).toBe(400);
    const bad = await app.inject({ method: "POST", url: "/v1/analyses", payload: "{oops", headers: { "content-type": "application/json" } });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error.code).toBe("BAD_REQUEST");
    expect((await analyse(app, { ticker: "005930", asOf: "2026-09-29" })).json().error.code).toBe("INVALID_AS_OF"); // future relative to clock
  });

  it("returns 404 for unknown tickers and routes", async () => {
    const { app } = await setup({}, DEMO_NOW);
    const res = await analyse(app, { ticker: "999999", asOf: "2026-09-28" });
    expect(res.statusCode).toBe(404);
    expect(res.json().error.hint).toContain("mode=public");
    const r = await app.inject({ url: "/nope" });
    expect(r.statusCode).toBe(404);
    expect(r.json().error.code).toBe("ROUTE_NOT_FOUND");
  });

  it("returns 422 at analysis time for stale or future evidence in a demo fixture", async () => {
    const { app } = await setup({}, new Date("2026-12-31T12:00:00Z"));
    const stale = await analyse(app, { ticker: "005930", asOf: "2026-12-31" });
    expect(stale.statusCode).toBe(422);
    expect(stale.json().error.details.map((i: any) => i.code)).toContain("STALE_EVIDENCE");
    const future = await analyse(app, { ticker: "005930", asOf: "2026-01-05" });
    expect(future.statusCode).toBe(422);
    expect(future.json().error.details.map((i: any) => i.code)).toContain("FUTURE_EVIDENCE");
  });

  it("returns 502 when a demo fixture is corrupt", async () => {
    const dir = await tmpDir("demo");
    await copyFile(path.join(demoDir, "005930.json"), path.join(dir, "005930.json"));
    await writeFile(path.join(dir, "005380.json"), "{}");
    const { app } = await setup({ demoDir: dir }, DEMO_NOW);
    expect((await analyse(app, { ticker: "005930", asOf: "2026-09-28" })).statusCode).toBe(200);
    const res = await analyse(app, { ticker: "005380", asOf: "2026-09-28" });
    expect(res.statusCode).toBe(502);
    expect(res.json().error.code).toBe("DATA_PROVIDER_ERROR");
  });

  it("enforces the body size limit with 413", async () => {
    const { app } = await setup();
    const res = await app.inject({ method: "POST", url: "/v1/analyses", payload: { pad: "x".repeat(1_100_000) } });
    expect(res.statusCode).toBe(413);
    expect(res.json().error.code).toBe("PAYLOAD_TOO_LARGE");
  });
});

describe("API key and network exposure", () => {
  it("keeps demo reads open with an API key configured, without echoing the key", async () => {
    const { app } = await setup({ apiKey: "s3cret-key" }, DEMO_NOW);
    expect((await app.inject({ url: "/v1/companies" })).statusCode).toBe(200);
    expect((await analyse(app, { ticker: "005930", asOf: "2026-09-28" })).statusCode).toBe(200);
    expect((await app.inject({ url: "/health" })).body).not.toContain("s3cret-key");
  });

  it("refuses to bind a non-loopback host without an API key", () => {
    expect(() => loadConfig({ HOST: "0.0.0.0" })).toThrow(/API_KEY/);
    expect(loadConfig({ HOST: "0.0.0.0", API_KEY: "k" }).host).toBe("0.0.0.0");
    expect(loadConfig({}).host).toBe("127.0.0.1");
  });
});
