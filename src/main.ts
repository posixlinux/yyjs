import path from "node:path";
import { collectPublicEvidence } from "./collection/index.js";
import { loadConfig } from "./config.js";
import { buildApp } from "./http/app.js";
import { analyzeEvidence } from "./intelligence/index.js";
import { LocalStore } from "./providers/local.js";
import { ResearchService } from "./research/service.js";
import { Service } from "./service.js";
import { StrategyService } from "./strategy/service.js";

const config = loadConfig();
if (!config.capabilities.dartConfigured)
  console.warn("[config] DART_API_KEY is not set: DART filings/statements will not be collected (0 filings) and no valuation can be produced. Put it in .env and restart.");
const service = new Service(
  { manual: new LocalStore(config.dataDir, false), demo: new LocalStore(config.demoDir, true) },
  config,
);
const research = new ResearchService(
  {
    collect: (input, { signal }) => collectPublicEvidence(input, { signal, now: config.now, cacheDir: config.cacheDir }),
    // jobTimeoutMs is the SAME effective outer deadline JobManager enforces (config.jobs.jobTimeoutMs): passing it
    // through lets resolveOptions log a diagnostic when the per-call CLI timeout does not fit that budget. It never
    // shortens the configured per-call timeout -- the job's own AbortController (JOB_TIMEOUT) is the real backstop.
    intelligence: (input, { signal }) => analyzeEvidence(input, { agyPath: config.agyPath, jobTimeoutMs: config.jobs.jobTimeoutMs, signal }),
    now: config.now,
    secrets: config.secrets,
    strategyMinimumCashBufferKRW: config.strategyMinimumCashBufferKRW,
  },
  config.jobs,
  (asOf) => service.resolveAsOf(asOf),
);
const strategy = new StrategyService(
  { forecasts: path.join(config.dataDir, "strategy/forecasts"), consensus: path.join(config.dataDir, "strategy/consensus"), catalysts: path.join(config.dataDir, "strategy/catalysts") },
  { now: config.now },
);
const app = buildApp(service, research, config, undefined, strategy);

// Graceful shutdown: app.close() aborts running jobs and fails queued ones (jobs are in-memory and lost on restart).
for (const sig of ["SIGINT", "SIGTERM"] as const) process.once(sig, () => void app.close().finally(() => process.exit(0)));

app.listen({ port: config.port, host: config.host }).catch((err) => {
  app.log.error(err);
  process.exit(1);
});
