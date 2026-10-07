import { Worker } from "node:worker_threads";
import { forecastMany, MIN_HISTORY_FOR, type EngineOptions, type ForecastResult, type Series } from "./engine.js";

// The compiled server (dist/*.js) runs the engine in a worker thread; under tsx/vitest (.ts sources a worker cannot
// load directly) it runs inline. One computation at a time: the engine is CPU-bound, so parallel runs only slow
// each other down.

type Many = ReturnType<typeof forecastMany>;
const WORKER_TIMEOUT_MS = 10 * 60_000;
let chain: Promise<unknown> = Promise.resolve();

export function runMany(series: Series[], options: EngineOptions, targets?: string[]): Promise<Many> {
  const job = chain.then(() => (import.meta.url.endsWith(".js") ? inWorker(series, options, targets) : forecastMany(series, options, targets)));
  chain = job.catch(() => undefined);
  return job;
}

export async function runEngine(target: Series, peers: Series[], options: EngineOptions): Promise<ForecastResult> {
  if (target.bars.length < MIN_HISTORY_FOR) throw new Error(`Need at least ${MIN_HISTORY_FOR} sessions of ${target.ticker}; have ${target.bars.length}`);
  const r = await runMany([target, ...peers.filter((p) => p.ticker !== target.ticker)], options, [target.ticker]);
  return r.results[0]!;
}

function inWorker(series: Series[], options: EngineOptions, targets?: string[]): Promise<Many> {
  return new Promise((resolve, reject) => {
    const w = new Worker(new URL("./worker.js", import.meta.url), { workerData: { series, options, targets } });
    // A stuck computation must not block every later forecast behind it.
    const timer = setTimeout(() => {
      reject(new Error(`forecast computation exceeded ${WORKER_TIMEOUT_MS / 1000} s and was stopped`));
      void w.terminate();
    }, WORKER_TIMEOUT_MS);
    timer.unref();
    const done = () => clearTimeout(timer);
    w.once("message", (m: { ok: true; result: Many } | { ok: false; message: string }) => (done(), m.ok ? resolve(m.result) : reject(new Error(m.message))));
    w.once("error", (e) => (done(), reject(e)));
    w.once("exit", (code) => (done(), code !== 0 && reject(new Error(`forecast worker exited with code ${code}`))));
  });
}
