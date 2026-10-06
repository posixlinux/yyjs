import { createHash, timingSafeEqual } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import Fastify, { type FastifyInstance } from "fastify";
import { z, ZodError } from "zod";
import { root, type Config } from "../config.js";
import { AnalysisRequestSchema, DatasetSchema, ResearchRequestSchema } from "../domain/schema.js";
import { AppError } from "../errors.js";
import { MODEL_VERSION } from "../model/model.js";
import type { ResearchService } from "../research/service.js";
import { UniverseProvider } from "../research/universe.js";
import type { Service } from "../service.js";
import { registerStrategyRoutes } from "./strategy.js";
import { DEFAULT_HYPOTHESIS_PARAMS } from "../strategy/config.js";
import { STRATEGY_VERSION } from "../strategy/version.js";
import type { StrategyService } from "../strategy/service.js";

const digest = (s: string) => createHash("sha256").update(s).digest();
const TickerParam = z.object({ ticker: z.string().regex(/^\d{6}$/, "six-digit KOSPI ticker") });
const IdParam = z.object({ id: z.uuid() });
// Long-poll: ?wait=<seconds, 0..60> holds a queued/running job's status request until it finishes (or the wait ends).
const WaitQuery = z.object({ wait: z.coerce.number().int().min(0).max(60).optional() });

export function buildApp(
  service: Service,
  research: ResearchService,
  config: Pick<Config, "apiKey" | "demoEnabled" | "logLevel"> & { capabilities?: Record<string, boolean>; defaultModels?: Config["defaultModels"] },
  universe: UniverseProvider = new UniverseProvider(),
  strategy?: StrategyService,
): FastifyInstance {
  const app = Fastify({
    bodyLimit: 1_000_000, // requests are small; oversize -> 413
    logger: config.logLevel === "silent" ? false : { level: config.logLevel, redact: ["req.headers.x-api-key", "req.headers.authorization"] },
  });
  app.addHook("onClose", async () => {
    await research.close(); // abort running jobs, fail queued ones
  });

  // API_KEY (when configured) protects every expensive/public-collection route, its results and strategy records.
  const requireKey = (headers: Record<string, unknown>) => {
    if (!config.apiKey) return;
    const given = headers["x-api-key"];
    if (typeof given !== "string" || !timingSafeEqual(digest(given), digest(config.apiKey))) throw new AppError(401, "UNAUTHORIZED", "Missing or invalid x-api-key");
  };

  const fail = (status: number, code: string, message: string, details?: unknown, hint?: string) => ({ status, body: { error: { code, message, ...(details !== undefined && { details }), ...(hint && { hint }) } } });

  app.setErrorHandler((err, req, reply) => {
    let r;
    if (err instanceof AppError) r = fail(err.status, err.code, err.message, err.details, err.hint);
    else if (err instanceof ZodError)
      r = fail(400, "VALIDATION_ERROR", "Request failed schema validation", err.issues.map((i) => ({ path: i.path.join("."), message: i.message })), "See GET /v1/schema.");
    else if ((err as { statusCode?: number }).statusCode && (err as { statusCode: number }).statusCode < 500) {
      const s = (err as { statusCode: number }).statusCode;
      r = fail(s, s === 413 ? "PAYLOAD_TOO_LARGE" : "BAD_REQUEST", s === 413 ? "Request body too large" : "Malformed request (invalid JSON or content type)");
    } else {
      req.log.error({ err: { message: (err as Error).message, stack: (err as Error).stack } }, "unhandled error"); // no secrets: headers are redacted, keys never in messages
      r = fail(500, "INTERNAL_ERROR", "Internal server error");
    }
    return reply.status(r.status).send(r.body);
  });
  app.setNotFoundHandler((_req, reply) => {
    const r = fail(404, "ROUTE_NOT_FOUND", "No such route");
    return reply.status(r.status).send(r.body);
  });

  app.get("/health", async () => ({
    status: "ok",
    modelVersion: MODEL_VERSION,
    demoEnabled: config.demoEnabled,
    apiKeyRequired: !!config.apiKey, // for public analysis/research jobs and strategy records
    jobs: research.jobs.stats(),
    capabilities: config.capabilities ?? {}, // booleans only, e.g. dartConfigured; never key material
    defaultModels: config.defaultModels ?? ["claude"], // public analysis models when a request names none
  }));

  // ---- web UI (static files from ./public; no inline script/style, so a strict CSP applies) -------------------------
  const PUBLIC = path.join(root, "public");
  const ASSETS: Record<string, string> = { "app.js": "text/javascript; charset=utf-8", "style.css": "text/css; charset=utf-8" };
  const CSP = "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' data:; base-uri 'none'; form-action 'none'; frame-ancestors 'none'";
  const sendFile = async (reply: import("fastify").FastifyReply, file: string, type: string) => {
    try {
      return reply.header("content-type", type).header("content-security-policy", CSP).header("x-content-type-options", "nosniff").header("cache-control", "no-cache").send(await readFile(path.join(PUBLIC, file)));
    } catch {
      throw new AppError(404, "ROUTE_NOT_FOUND", "Web UI files are missing (public/)");
    }
  };
  app.get("/", (_req, reply) => sendFile(reply, "index.html", "text/html; charset=utf-8"));
  app.get("/assets/:name", (req, reply) => {
    const { name } = z.object({ name: z.string() }).parse(req.params);
    const type = ASSETS[name];
    if (!type) throw new AppError(404, "ROUTE_NOT_FOUND", "No such asset");
    return sendFile(reply, name, type);
  });

  // KOSPI and KOSDAQ common stocks (no ETF/preferred/REIT...) for the picker; public data, cached server-side.
  // The web UI loads the whole list at once (limit up to 5000 covers every listed common stock) and searches locally.
  app.get("/v1/universe", async (req) => {
    const q = z.object({ query: z.string().max(50).optional(), limit: z.coerce.number().int().min(1).max(5000).default(50) }).parse(req.query);
    let u;
    try {
      u = await universe.get();
    } catch {
      throw new AppError(502, "UNIVERSE_UNAVAILABLE", "Could not load the KOSPI/KOSDAQ stock list from Naver Finance", undefined, "Enter a six-digit ticker manually.");
    }
    return { fetchedAt: u.fetchedAt, markets: ["KOSPI", "KOSDAQ"], commonStocksOnly: true, ...UniverseProvider.search(u, q.query, q.limit) };
  });

  app.get("/v1/schema", async () => ({
    note: "JSON Schema of the company dataset (result.research.draftDataset.dataset of a public analysis job). Cross-field rules (consecutive quarters, coverage, share bounds, currency match, source dates) are enforced server-side.",
    schema: z.toJSONSchema(DatasetSchema, { unrepresentable: "any" }),
  }));

  // Bundled demo fixtures only (fictional data).
  app.get("/v1/companies", async (req) => {
    const q = z.object({ query: z.string().max(100).optional() }).parse(req.query);
    return { companies: await service.listCompanies(q.query) };
  });

  app.get("/v1/companies/:ticker", async (req) => {
    const { ticker } = TickerParam.parse(req.params);
    return service.getCompany(ticker, "demo");
  });

  // mode=public (default): asynchronous job (202). mode=demo: synchronous deterministic analysis of a demo fixture.
  app.post("/v1/analyses", async (req, reply) => {
    const body = AnalysisRequestSchema.parse(req.body);
    if (body.mode !== "public") {
      if (body.competitors?.length) throw new AppError(400, "COMPETITORS_PUBLIC_ONLY", "competitors are collected only in mode=public");
      if (body.models?.length) throw new AppError(400, "MODELS_PUBLIC_ONLY", "models apply only to mode=public (demo analysis calls no model)");
      return service.analyze({ ticker: body.ticker, asOf: body.asOf, mode: body.mode });
    }
    requireKey(req.headers);
    const job = research.startAnalysis({ ticker: body.ticker, asOf: body.asOf, competitors: body.competitors, models: body.models });
    return reply.status(202).header("location", job.statusUrl).send(job);
  });

  app.get("/v1/analyses/:id", async (req) => {
    requireKey(req.headers);
    const { wait } = WaitQuery.parse(req.query);
    return research.waitJob(IdParam.parse(req.params).id, "analysis", (wait ?? 0) * 1000);
  });

  // Evidence-only collection job: never invokes Claude/agy.
  app.post("/v1/research", async (req, reply) => {
    requireKey(req.headers);
    const body = ResearchRequestSchema.parse(req.body);
    const job = research.startResearch(body);
    return reply.status(202).header("location", job.statusUrl).send(job);
  });

  app.get("/v1/research/:id", async (req) => {
    requireKey(req.headers);
    const { wait } = WaitQuery.parse(req.query);
    return research.waitJob(IdParam.parse(req.params).id, "research", (wait ?? 0) * 1000);
  });

  // earnings-gap-auto/v1 research/paper-trading slice (docs/STRATEGY_SPEC.md); a separate experiment surface from
  // the product-market model above. Optional: absent unless main.ts wires a StrategyService, so existing deployments
  // and every prior buildApp(...) call site are unaffected.
  if (strategy) {
    app.get("/v1/strategy/config/defaults", async () => ({ strategyVersion: STRATEGY_VERSION, hypothesisDefaults: DEFAULT_HYPOTHESIS_PARAMS, note: "Supply feeBpsPerSide, slippageBpsPerSide, sellTaxBps, initialCapitalKRW and risk.minimumCashBufferKRW explicitly. Defaults are uncalibrated experiment hypotheses, not investment recommendations." }));
    registerStrategyRoutes(app, strategy, requireKey);
  }

  return app;
}
