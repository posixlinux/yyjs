// Small, deterministic learners for the short-term forecast: standardization with median imputation, L2-regularized
// logistic regression (Newton/IRLS) for the probability of a rise, ridge regression for the expected return, and
// Platt scaling to calibrate probabilities on out-of-sample predictions. No randomness, no dependencies.

/** Solves A x = b for a symmetric positive-definite A (Cholesky). A is modified. */
export function solveSpd(A: number[][], b: number[]): number[] {
  const n = b.length;
  const L = A.map((r) => r.slice());
  for (let j = 0; j < n; j++) {
    let d = L[j]![j]!;
    for (let k = 0; k < j; k++) d -= L[j]![k]! ** 2;
    if (!(d > 0)) d = 1e-12; // numerically singular: regularization keeps this rare
    L[j]![j] = Math.sqrt(d);
    for (let i = j + 1; i < n; i++) {
      let s = L[i]![j]!;
      for (let k = 0; k < j; k++) s -= L[i]![k]! * L[j]![k]!;
      L[i]![j] = s / L[j]![j]!;
    }
  }
  const y = new Array<number>(n);
  for (let i = 0; i < n; i++) {
    let s = b[i]!;
    for (let k = 0; k < i; k++) s -= L[i]![k]! * y[k]!;
    y[i] = s / L[i]![i]!;
  }
  const x = new Array<number>(n);
  for (let i = n - 1; i >= 0; i--) {
    let s = y[i]!;
    for (let k = i + 1; k < n; k++) s -= L[k]![i]! * x[k]!;
    x[i] = s / L[i]![i]!;
  }
  return x;
}

export type Scaler = { center: number[]; scale: number[] };

/** Median/IQR-style robust scaling fitted on training rows; NaN is imputed with the median (0 after scaling). */
export function fitScaler(X: number[][]): Scaler {
  const d = X[0]?.length ?? 0;
  const center: number[] = [], scale: number[] = [];
  for (let j = 0; j < d; j++) {
    const col = X.map((r) => r[j]!).filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
    const q = (p: number) => (col.length ? col[Math.min(col.length - 1, Math.floor(p * (col.length - 1)))]! : 0);
    const med = q(0.5);
    let s = (q(0.75) - q(0.25)) / 1.349;
    if (!(s > 1e-12)) {
      const m = col.length ? col.reduce((a, b) => a + b, 0) / col.length : 0;
      s = col.length > 1 ? Math.sqrt(col.reduce((a, v) => a + (v - m) ** 2, 0) / (col.length - 1)) : 1;
    }
    center.push(med);
    scale.push(s > 1e-12 ? s : 1);
  }
  return { center, scale };
}

const CLIP = 5; // winsorize standardized features: one extreme day must not dominate a linear model

export function transform(s: Scaler, x: number[]): number[] {
  return x.map((v, j) => (Number.isFinite(v) ? Math.max(-CLIP, Math.min(CLIP, (v - s.center[j]!) / s.scale[j]!)) : 0));
}

export const sigmoid = (z: number) => (z >= 0 ? 1 / (1 + Math.exp(-z)) : Math.exp(z) / (1 + Math.exp(z)));

export type Linear = { w: number[]; b: number };

/** L2-regularized logistic regression on standardized X (intercept unpenalized), weighted samples allowed. */
export function fitLogistic(X: number[][], y: number[], lambda: number, iters = 25, weights?: number[]): Linear {
  const n = X.length, d = X[0]?.length ?? 0;
  let w = new Array<number>(d + 1).fill(0); // last = intercept
  const pos = y.reduce((s, v, i) => s + v * (weights?.[i] ?? 1), 0) / y.reduce((s, _, i) => s + (weights?.[i] ?? 1), 0);
  w[d] = Math.log(Math.max(1e-6, pos) / Math.max(1e-6, 1 - pos));
  for (let it = 0; it < iters; it++) {
    const H = Array.from({ length: d + 1 }, () => new Array<number>(d + 1).fill(0));
    const g = new Array<number>(d + 1).fill(0);
    for (let i = 0; i < n; i++) {
      const xi = X[i]!;
      let z = w[d]!;
      for (let j = 0; j < d; j++) z += w[j]! * xi[j]!;
      const p = sigmoid(z);
      const wi = weights?.[i] ?? 1;
      const r = (p - y[i]!) * wi;
      const s = Math.max(1e-6, p * (1 - p)) * wi;
      for (let j = 0; j < d; j++) {
        g[j] += r * xi[j]!;
        const sx = s * xi[j]!;
        for (let k = 0; k <= j; k++) H[j]![k] += sx * xi[k]!;
        H[d]![j] += sx;
      }
      g[d] += r;
      H[d]![d] += s;
    }
    for (let j = 0; j < d; j++) {
      g[j] += lambda * w[j]!;
      H[j]![j] += lambda;
    }
    for (let j = 0; j <= d; j++) for (let k = j + 1; k <= d; k++) H[j]![k] = H[k]![j]!;
    const step = solveSpd(H, g);
    let maxStep = 0;
    w = w.map((v, j) => {
      maxStep = Math.max(maxStep, Math.abs(step[j]!));
      return v - step[j]!;
    });
    if (maxStep < 1e-8) break;
  }
  return { w: w.slice(0, d), b: w[d]! };
}

export const linear = (m: Linear, x: number[]) => x.reduce((s, v, j) => s + v * m.w[j]!, m.b);

/** Ridge regression (intercept unpenalized) on standardized X, optionally sample-weighted. */
export function fitRidge(X: number[][], y: number[], lambda: number, weights?: number[]): Linear {
  const n = X.length, d = X[0]?.length ?? 0;
  const wt = (i: number) => weights?.[i] ?? 1;
  let W = 0;
  for (let i = 0; i < n; i++) W += wt(i);
  W = Math.max(W, 1e-12);
  const my = y.reduce((s, v, i) => s + v * wt(i), 0) / W;
  const mx = new Array<number>(d).fill(0);
  X.forEach((r, i) => {
    for (let j = 0; j < d; j++) mx[j] += (r[j]! * wt(i)) / W;
  });
  const A = Array.from({ length: d }, () => new Array<number>(d).fill(0));
  const c = new Array<number>(d).fill(0);
  for (let i = 0; i < n; i++) {
    const r = X[i]!;
    const wi = wt(i);
    const yi = y[i]! - my;
    for (let j = 0; j < d; j++) {
      const xj = (r[j]! - mx[j]!) * wi;
      c[j] += xj * yi;
      for (let k = 0; k <= j; k++) A[j]![k] += xj * (r[k]! - mx[k]!);
    }
  }
  for (let j = 0; j < d; j++) {
    A[j]![j] += lambda;
    for (let k = j + 1; k < d; k++) A[j]![k] = A[k]![j]!;
  }
  const w = d ? solveSpd(A, c) : [];
  return { w, b: my - w.reduce((s, v, j) => s + v * mx[j]!, 0) };
}

/**
 * Platt scaling: p' = sigmoid(a * logit(p) + b), fitted on out-of-sample predictions. With no real signal the slope
 * shrinks toward 0 and p' toward the base rate, which is exactly the honest answer.
 */
export function fitPlatt(p: number[], y: number[]): { a: number; b: number } {
  const X = p.map((v) => [Math.log(Math.max(1e-6, v) / Math.max(1e-6, 1 - v))]);
  const m = fitLogistic(X, y, 1e-3, 50);
  return { a: m.w[0]!, b: m.b };
}
export const applyPlatt = (c: { a: number; b: number }, p: number) => sigmoid(c.a * Math.log(Math.max(1e-6, p) / Math.max(1e-6, 1 - p)) + c.b);

export const quantile = (xs: number[], q: number): number => {
  const s = xs.filter((v) => Number.isFinite(v)).sort((a, b) => a - b);
  if (!s.length) return NaN;
  const pos = q * (s.length - 1);
  const lo = Math.floor(pos), hi = Math.ceil(pos);
  return s[lo]! + (s[hi]! - s[lo]!) * (pos - lo);
};

// ---- gradient-boosted depth-2 trees (logistic loss) -------------------------------------------------------------
// Captures thresholds and interactions a linear model misses (e.g. "a volume spike AND a down day"). Features are
// pre-binned on training quantiles, every split is chosen on histogram sums, and leaves are shrunk Newton steps,
// so it is fast, deterministic and hard to overfit with the defaults below.

export type Stump = { f: number; t: number; left: Stump | number; right: Stump | number };
export type Gbm = { base: number; trees: Stump[]; rate: number; edges: number[][] };

const BINS = 16;

function binEdges(X: number[][]): number[][] {
  const d = X[0]?.length ?? 0;
  const edges: number[][] = [];
  for (let j = 0; j < d; j++) {
    const col = X.map((r) => r[j]!).filter(Number.isFinite).sort((a, b) => a - b);
    const e: number[] = [];
    for (let k = 1; k < BINS; k++) {
      const v = col.length ? col[Math.floor((k / BINS) * (col.length - 1))]! : 0;
      if (!e.length || v > e.at(-1)!) e.push(v);
    }
    edges.push(e);
  }
  return edges;
}
const binOf = (e: number[], v: number) => {
  if (!Number.isFinite(v)) return 0;
  let lo = 0, hi = e.length;
  while (lo < hi) {
    const m = (lo + hi) >> 1;
    if (v > e[m]!) lo = m + 1;
    else hi = m;
  }
  return lo; // 0..e.length
};

export function fitGbm(X: number[][], y: number[], o: { rounds?: number; rate?: number; minLeaf?: number; lambda?: number; weights?: number[] } = {}): Gbm {
  const rounds = o.rounds ?? 60, rate = o.rate ?? 0.05, minLeaf = o.minLeaf ?? Math.max(30, Math.floor(X.length * 0.02)), lam = o.lambda ?? 5;
  const n = X.length, d = X[0]?.length ?? 0;
  const edges = binEdges(X);
  // Bin index of every (row, feature) in one flat byte array: the split search below is all histogram sums.
  const B = new Uint8Array(n * d);
  for (let i = 0; i < n; i++) for (let j = 0; j < d; j++) B[i * d + j] = binOf(edges[j]!, X[i]![j]!);
  const pos = y.reduce((s, v) => s + v, 0) / Math.max(1, n);
  const base = Math.log(Math.max(1e-6, pos) / Math.max(1e-6, 1 - pos));
  const F = new Float64Array(n).fill(base);
  const g = new Float64Array(n), h = new Float64Array(n);
  const G = new Float64Array(BINS + 1), Hh = new Float64Array(BINS + 1), C = new Int32Array(BINS + 1);
  const trees: Stump[] = [];
  const leaf = (Gs: number, Hs: number) => -Gs / (Hs + lam);
  const sums = (idx: Int32Array) => {
    let Gs = 0, Hs = 0;
    for (let k = 0; k < idx.length; k++) (Gs += g[idx[k]!]!), (Hs += h[idx[k]!]!);
    return [Gs, Hs] as const;
  };
  // Best split of `idx` on any feature: [feature, bin threshold, gain].
  const bestSplit = (idx: Int32Array): [number, number, number] => {
    let bf = -1, bt = 0, bg = 0;
    const [Gt, Ht] = sums(idx);
    const parent = (Gt * Gt) / (Ht + lam);
    for (let j = 0; j < d; j++) {
      const nb = edges[j]!.length + 1;
      if (nb < 2) continue;
      G.fill(0, 0, nb);
      Hh.fill(0, 0, nb);
      C.fill(0, 0, nb);
      for (let k = 0; k < idx.length; k++) {
        const i = idx[k]!;
        const b = B[i * d + j]!;
        G[b] += g[i]!;
        Hh[b] += h[i]!;
        C[b]++;
      }
      let gl = 0, hl = 0, cl = 0;
      for (let b = 0; b < nb - 1; b++) {
        gl += G[b]!;
        hl += Hh[b]!;
        cl += C[b]!;
        if (cl < minLeaf || idx.length - cl < minLeaf) continue;
        const gr = Gt - gl, hr = Ht - hl;
        const gain = (gl * gl) / (hl + lam) + (gr * gr) / (hr + lam) - parent;
        if (gain > bg) (bf = j), (bt = b), (bg = gain);
      }
    }
    return [bf, bt, bg];
  };
  const part = (idx: Int32Array, f: number, t: number): [Int32Array, Int32Array] => {
    let nl = 0;
    for (let k = 0; k < idx.length; k++) if (B[idx[k]! * d + f]! <= t) nl++;
    const L = new Int32Array(nl), R = new Int32Array(idx.length - nl);
    let a = 0, c = 0;
    for (let k = 0; k < idx.length; k++) {
      const i = idx[k]!;
      if (B[i * d + f]! <= t) L[a++] = i;
      else R[c++] = i;
    }
    return [L, R];
  };
  const all = Int32Array.from({ length: n }, (_, i) => i);
  for (let r = 0; r < rounds; r++) {
    for (let i = 0; i < n; i++) {
      const p = sigmoid(F[i]!);
      const w = o.weights?.[i] ?? 1;
      g[i] = (p - y[i]!) * w;
      h[i] = Math.max(1e-6, p * (1 - p)) * w;
    }
    const [f, t, gain] = bestSplit(all);
    if (f < 0 || gain <= 0) break;
    const [L, R] = part(all, f, t);
    const child = (idx: Int32Array): Stump | number => {
      const [cf, ct, cg] = bestSplit(idx);
      if (cf < 0 || cg <= 0) return leaf(...sums(idx));
      const [l, rr] = part(idx, cf, ct);
      return { f: cf, t: ct, left: leaf(...sums(l)), right: leaf(...sums(rr)) };
    };
    const tree: Stump = { f, t, left: child(L), right: child(R) };
    trees.push(tree);
    for (let i = 0; i < n; i++) F[i] += rate * evalTreeFlat(tree, B, i * d);
  }
  return { base, trees, rate, edges };
}

function evalTreeFlat(t: Stump | number, B: Uint8Array, off: number): number {
  return typeof t === "number" ? t : evalTreeFlat(B[off + t.f]! <= t.t ? t.left : t.right, B, off);
}

function evalTree(t: Stump | number, b: number[]): number {
  return typeof t === "number" ? t : evalTree(b[t.f]! <= t.t ? t.left : t.right, b);
}

export function gbmProb(m: Gbm, x: number[]): number {
  const b = x.map((v, j) => binOf(m.edges[j]!, v));
  return sigmoid(m.trees.reduce((s, t) => s + m.rate * evalTree(t, b), m.base));
}
