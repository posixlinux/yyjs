import type { FastifyInstance } from "fastify";
import { z } from "zod";
import { ReplayInputSchema } from "../strategy/replay.js";
import { ScreenRequestSchema, type RecordKind, type StrategyService } from "../strategy/service.js";

const IdParam = z.object({ id: z.uuid() });
const KIND_ROUTE: Record<string, RecordKind> = { forecasts: "forecast", consensus: "consensus", catalysts: "catalyst" };

// replay always re-derives the selection from `screen` (the same candidates/config/decisionAt), never from a
// client-echoed ScreenResult, so a caller cannot tamper with which tickers were selected (see StrategyService.screenAndReplay).
const ReplayRequestSchema = z.object({ screen: ScreenRequestSchema, replay: ReplayInputSchema }).strict();

/**
 * earnings-gap-auto/v1 (docs/STRATEGY_SPEC.md). Registered only when a StrategyService is supplied to buildApp, so
 * existing callers/tests of buildApp(service, research, config[, universe]) are unaffected (optional 5th argument).
 * Every route follows the same x-api-key gate as POST /v1/datasets ("Authenticated HTTP API... same as existing
 * mutations"); screening/replay are synchronous (no LLM, no network), so no job queue is needed here.
 */
export function registerStrategyRoutes(app: FastifyInstance, strategy: StrategyService, requireKey: (headers: Record<string, unknown>) => void) {
  for (const [route, kind] of Object.entries(KIND_ROUTE)) {
    app.post(`/v1/strategy/records/${route}`, { onRequest: async (req) => requireKey(req.headers) }, async (req, reply) => {
      const rec = await strategy.record(kind, req.body);
      return reply.status(201).send(rec);
    });
    app.get(`/v1/strategy/records/${route}`, { onRequest: async (req) => requireKey(req.headers) }, async () => ({ records: await strategy.listRecords(kind) }));
    app.get(`/v1/strategy/records/${route}/:id`, { onRequest: async (req) => requireKey(req.headers) }, async (req) => strategy.getRecord(kind, IdParam.parse(req.params).id));
  }

  app.post("/v1/strategy/screen", { onRequest: async (req) => requireKey(req.headers) }, async (req) => {
    const body = ScreenRequestSchema.parse(req.body);
    return strategy.screen(body);
  });

  app.post("/v1/strategy/replay", { onRequest: async (req) => requireKey(req.headers) }, async (req) => {
    const body = ReplayRequestSchema.parse(req.body);
    return strategy.screenAndReplay(body.screen, body.replay);
  });
}
