import { Worker } from "node:worker_threads";
import { forecast, type EngineOptions, type ForecastResult, type Series } from "./engine.js";

// The compiled server (dist/*.js) runs the engine in a worker thread; under tsx/vitest (.ts sources a worker cannot
// load directly) it runs inline. One computation at a time: the engine is CPU-bound, so parallel runs only slow
// each other down.

let chain: Promise<unknown> = Promise.resolve();

export function runEngine(target: Series, peers: Series[], options: EngineOptions): Promise<ForecastResult> {
  const job = chain.then(() => (import.meta.url.endsWith(".js") ? inWorker(target, peers, options) : forecast(target, peers, options)));
  chain = job.catch(() => undefined);
  return job;
}

function inWorker(target: Series, peers: Series[], options: EngineOptions): Promise<ForecastResult> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./worker.js", import.meta.url), { workerData: { target, peers, options } });
    w.once("message", (m: { ok: true; result: ForecastResult } | { ok: false; message: string }) => (m.ok ? resolve(m.result) : reject(new Error(m.message))));
    w.once("error", reject);
    w.once("exit", (code) => code !== 0 && reject(new Error(`forecast worker exited with code ${code}`)));
  });
}
