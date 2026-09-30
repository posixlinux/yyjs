import { mkdir, mkdtemp } from "node:fs/promises";
import path from "node:path";
import type { Dataset } from "../src/domain/schema.js";

// Round-number dataset: asOf 2026-01-15, results reported through 2025Q4 -> target 2026Q1 (first unreported quarter;
// one quarter after the latest observations, across a year boundary).
export const AS_OF = "2026-01-15";
export const NOW = new Date("2026-01-15T12:00:00Z");

const src = (title: string, publishedAt: string) => ({ title, manualReference: "test-fixture", publishedAt });
const tri = (bear: number, base: number, bull: number) => ({ bear, base, bull });
const QUARTERS = ["2025Q1", "2025Q2", "2025Q3", "2025Q4"];
const PUBLISHED = ["2025-05-15", "2025-08-15", "2025-11-15", "2026-01-10"];

export function makeDataset(): Dataset {
  return {
    schemaVersion: 1,
    company: { ticker: "111110", name: "Test Co", exchange: "KOSPI", description: "fixture", sources: [src("profile", "2025-12-01")] },
    quote: { priceKRW: 50_000, asOf: "2026-01-10", source: src("quote", "2026-01-10") },
    shares: { dilutedCommon: 10_000_000, asOf: "2025-12-31", source: src("shares", "2026-01-05") },
    fx: [{ currency: "USD", krwPerUnit: 1000, asOf: "2026-01-10", source: src("fx", "2026-01-10") }],
    financials: { quarter: "2025Q4", totalRevenueKRW: 1.25e11, source: src("report", "2026-01-10") },
    markets: [
      {
        id: "m1",
        name: "Market 1",
        scope: "Global widgets, revenue, USD",
        currency: "USD",
        observations: QUARTERS.map((q, i) => ({ quarter: q, revenue: 1e9, basis: "quarterly" as const, source: src(`obs ${q}`, PUBLISHED[i]) })),
        annualGrowth: { value: tri(0, 0.1, 0.2), source: src("growth", "2025-12-20") },
        seasonality: { value: { q1: 1, q2: 1, q3: 1, q4: 1 }, source: src("season", "2025-12-20") },
        cyclical: { value: tri(1, 1, 1), source: src("cycle", "2025-12-20") },
      },
    ],
    products: [
      {
        id: "p1",
        name: "Product 1",
        marketId: "m1",
        revenue: QUARTERS.map((q, i) => ({ quarter: q, revenue: 1e8, currency: "USD", basis: "quarterly" as const, source: src(`rev ${q}`, PUBLISHED[i]) })),
        shareDelta: { value: tri(0, 0, 0), source: src("share", "2025-12-20") },
        shareBounds: { min: 0.05, max: 0.2 },
        operatingMargin: { value: tri(0.1, 0.2, 0.3), source: src("margin", "2025-12-20") },
      },
    ],
    residual: { value: { annualGrowth: tri(0, 0, 0), operatingMargin: tri(0.1, 0.1, 0.1) }, source: src("residual", "2025-12-20") },
    earningsBridge: { value: { netInterestKRW: 0, effectiveTaxRate: 0.2, noncontrollingShare: 0, preferredClaimsKRW: 0 }, source: src("bridge", "2025-12-20"), rationale: "no preferred shares" },
    valuation: { peMultiple: { value: tri(5, 10, 15), source: src("pe", "2025-12-20") } },
  };
}

/** Temp dir inside the workspace (gitignored); tests never touch anything outside it. */
export async function tmpDir(name = "t"): Promise<string> {
  const base = path.join(process.cwd(), ".test-tmp");
  await mkdir(base, { recursive: true });
  return mkdtemp(path.join(base, `${name}-`));
}
