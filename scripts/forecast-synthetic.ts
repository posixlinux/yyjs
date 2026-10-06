// Synthetic benchmark for the short-term forecaster (no network): random walks must show no edge, markets with
// planted short-term structure must be detected. Run: npm run forecast:synthetic
import { backtestStats, buildSamples, DEFAULT_OPTIONS, stack, walkForward } from "../src/forecast/engine.js";
import type { Bar } from "../src/forecast/history.js";

function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());
}
const day = (i: number) => new Date(Date.UTC(2023, 0, 2) + i * 86_400_000).toISOString().slice(0, 10);

/** r_t = phi r_{t-1} + kappa * (index move) + volume-linked drift + noise */
function market(n: number, seed: number, o: { phi?: number; volSignal?: number; idx?: number[] } = {}): Bar[] {
  const g = rng(seed);
  let r = 0, c = 10_000;
  const bars: Bar[] = [];
  let volShock = 0;
  for (let i = 0; i < n; i++) {
    const prevShock = volShock;
    volShock = g();
    r = (o.phi ?? 0) * r + (o.volSignal ?? 0) * 0.02 * Math.sign(prevShock) * (Math.abs(prevShock) > 1 ? 1 : 0) + 0.02 * g() + (o.idx ? o.idx[i]! : 0);
    const prev = c;
    c = c * Math.exp(r);
    bars.push({ date: day(i), open: prev, high: Math.max(prev, c) * 1.004, low: Math.min(prev, c) * 0.996, close: c, volume: 1e6 * Math.exp(0.5 * volShock) });
  }
  return bars;
}

const N = Number(process.env.N ?? 700);
const OPTS = { ...DEFAULT_OPTIONS, gbm: process.env.GBM !== "0" };
const ONLY = process.env.ONLY;
const scenarios: [string, { phi?: number; volSignal?: number }, number][] = [
  ["random walk x8", {}, 8],
  ["momentum phi=0.15 x8", { phi: 0.15 }, 8],
  ["reversal phi=-0.15 x8", { phi: -0.15 }, 8],
  ["momentum phi=0.35 x1", { phi: 0.35 }, 1],
  ["volume signal x8", { volSignal: 0.3 }, 8],
];
const idxG = rng(999);
const idxRet = Array.from({ length: N }, () => 0.01 * idxG());
let lvl = 1000;
const index: Bar[] = idxRet.map((x, i) => ((lvl *= Math.exp(x)), { date: day(i), open: null, high: null, low: null, close: lvl, volume: null }));
for (const [name, o, k] of scenarios.filter(([n]) => !ONLY || n.includes(ONLY))) {
  const series = Array.from({ length: k }, (_, j) => ({ ticker: String(100000 + j * 10), bars: market(N, 1000 * j + name.length, o), index }));
  const s = buildSamples(series);
  const cells: string[] = [];
  for (const hi of [0, 1, 2]) {
    const first = walkForward(s, hi, OPTS);
    const a = backtestStats(first, hi + 1);
    const g = backtestStats(first.map((x) => ({ ...x, p: x.pg })), hi + 1);
    const b = backtestStats(stack(first, OPTS.step), hi + 1);
    cells.push(`h${hi + 1}: lin ${(a.accuracy! * 100).toFixed(1)} gbm ${(g.accuracy! * 100).toFixed(1)} → stack ${(b.accuracy! * 100).toFixed(1)} (mom ${(b.momentumAccuracy! * 100).toFixed(1)}, Δbrier ${(b.brier! - b.brierBaseRate!).toFixed(4)}, ${b.edge})`);
  }
  console.log(`${name.padEnd(24)} ${cells.join(" | ")}`);
}
