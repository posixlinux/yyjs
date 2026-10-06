import { parentPort, workerData } from "node:worker_threads";
import { forecastMany, type EngineOptions, type Series } from "./engine.js";

// Runs one engine computation off the main thread (see runner.ts), so a 30-60 s fit never stalls the HTTP server.
const { series, options, targets } = workerData as { series: Series[]; options: EngineOptions; targets?: string[] };
try {
  parentPort!.postMessage({ ok: true, result: forecastMany(series, options, targets) });
} catch (e) {
  parentPort!.postMessage({ ok: false, message: (e as Error).message });
}
