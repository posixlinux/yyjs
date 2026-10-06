import { parentPort, workerData } from "node:worker_threads";
import { forecast, type EngineOptions, type Series } from "./engine.js";

// Runs one engine computation off the main thread (see runner.ts), so a 30-60 s fit never stalls the HTTP server.
const { target, peers, options } = workerData as { target: Series; peers: Series[]; options: EngineOptions };
try {
  parentPort!.postMessage({ ok: true, result: forecast(target, peers, options) });
} catch (e) {
  parentPort!.postMessage({ ok: false, message: (e as Error).message });
}
