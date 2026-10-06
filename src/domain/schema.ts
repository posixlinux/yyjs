import { z } from "zod";
import { isValidDate } from "./time.js";

// Strict (unknown keys rejected) zod schema for a full company dataset. Cross-field rules live in validate.ts.

const date = z.string().refine(isValidDate, "must be a real date in YYYY-MM-DD format");
const quarter = z.string().regex(/^\d{4}Q[1-4]$/, "must look like 2026Q2");
const text = (max: number) => z.string().trim().min(1).max(max);
const currency = z.string().regex(/^[A-Z]{3}$/, "ISO 4217 code such as USD");
const id = z.string().regex(/^[a-z0-9][a-z0-9-]{0,39}$/, "lowercase letters, digits, hyphen");

export const SourceSchema = z
  .object({
    title: text(200),
    url: z.url({ protocol: /^https?$/ }).max(500).optional(), // stored as provenance only, never fetched
    manualReference: text(300).optional(),
    publishedAt: date,
  })
  .strict()
  .refine((s) => s.url || s.manualReference, "source needs url or manualReference");

const tri = (v: z.ZodNumber) =>
  z
    .object({ bear: v, base: v, bull: v })
    .strict()
    .refine((t) => t.bear <= t.base && t.base <= t.bull, "must satisfy bear <= base <= bull");

const assumption = <T extends z.ZodType>(value: T, rationaleRequired = false) =>
  z.object({ value, source: SourceSchema, rationale: rationaleRequired ? text(500) : text(500).optional() }).strict();

// Finite, bounded magnitudes: zod rejects NaN/Infinity, the caps stop overflow to Infinity (JSON null) in later arithmetic.
const MAX_AMOUNT = 1e18;
const amount = z.number().positive().max(MAX_AMOUNT);

const growth = z.number().min(-0.5).max(1);
const margin = z.number().min(-0.5).max(0.6);
const seasonIndex = z.number().min(0.7).max(1.3);
const basis = z.enum(["quarterly", "annual"]); // "annual" exists only so it can be rejected with a clear error

// A revenue figure that was inferred instead of read from a source. Estimates are allowed for market size, product
// revenue and competitor revenue (never for price, share count, FX or company revenue); they carry their method, the
// inputs they rest on and a rationale, and every report lists them. See docs (README "추정치").
export const ESTIMATE_METHODS = [
  "share_implied", // market = product revenue / a stated revenue share
  "sum_of_players", // market = company + identified competitors + an estimated remainder
  "prior_extrapolation", // earlier reported figure rolled forward with a stated growth
  "segment_allocation", // product revenue carved out of a reported segment/company figure
  "period_allocation", // a filed half-year/annual figure split into quarters (e.g. Japanese filers report halves only)
  "article_synthesis", // differing figures from several articles (cumulative sales, revenue, ...) combined into one approximate value
  "model_knowledge", // background knowledge of the analyst/model without a supplied document (lowest grade)
] as const;
export const EstimateSchema = z
  .object({
    method: z.enum(ESTIMATE_METHODS),
    // dataset paths (e.g. "products[0].revenue[1].revenue") and/or supplied document ids the estimate rests on
    basedOn: z.array(text(200)).max(8),
    rationale: text(500),
  })
  .strict();
export type Estimate = z.infer<typeof EstimateSchema>;

export const MarketSchema = z
  .object({
    id,
    name: text(100),
    scope: text(300), // global product scope: what is (and is not) inside this market
    currency,
    observations: z
      .array(
        z
          .object({ quarter, revenue: amount, basis, source: SourceSchema, estimate: EstimateSchema.optional() })
          .strict(),
      )
      .min(4)
      .max(40),
    annualGrowth: assumption(tri(growth)), // annual CAGR fraction, 0.1 = 10%
    seasonality: assumption(
      z.object({ q1: seasonIndex, q2: seasonIndex, q3: seasonIndex, q4: seasonIndex }).strict(),
    ), // multiplicative indices, mean must be ~1
    cyclical: assumption(tri(z.number().min(0.8).max(1.2))), // one-off multiplier on target-quarter market
    drivers: z.array(z.object({ text: text(300), source: SourceSchema }).strict()).max(10).optional(),
  })
  .strict();

export const ProductSchema = z
  .object({
    id,
    name: text(100),
    marketId: id,
    revenue: z
      .array(
        z
          .object({
            quarter,
            revenue: amount,
            currency,
            basis,
            source: SourceSchema,
            estimate: EstimateSchema.optional(),
          })
          .strict(),
      )
      .min(1)
      .max(40),
    shareDelta: assumption(tri(z.number().min(-0.2).max(0.2))), // absolute change in revenue share (fraction points)
    shareBounds: z
      .object({ min: z.number().min(0).max(1), max: z.number().min(0).max(1) })
      .strict()
      .refine((b) => b.min <= b.max, "min must be <= max"),
    operatingMargin: assumption(tri(margin)),
  })
  .strict();

// A competitor's revenue inside one market (same scope, quarter and currency as the market series).
export const CompetitorSchema = z
  .object({
    id,
    name: text(100),
    marketId: id,
    revenue: z
      .array(z.object({ quarter, revenue: amount, currency, basis, source: SourceSchema, estimate: EstimateSchema.optional() }).strict())
      .min(1)
      .max(40),
    shareDelta: assumption(tri(z.number().min(-0.2).max(0.2))).optional(), // absolute change of its market share; default 0
  })
  .strict();

export const DatasetSchema = z
  .object({
    schemaVersion: z.literal(1),
    synthetic: z.boolean().optional(), // true only for bundled demo fixtures
    company: z
      .object({
        ticker: z.string().regex(/^[0-9][0-9A-Z]{5}$/, "six-character KRX ticker"),
        name: text(100),
        exchange: z.enum(["KOSPI", "KOSDAQ"]),
        sector: text(100).optional(),
        description: text(1000),
        sources: z.array(SourceSchema).min(1).max(10),
      })
      .strict(),
    quote: z
      .object({ priceKRW: z.number().positive().max(1e9), asOf: date, source: SourceSchema })
      .strict(),
    shares: z // diluted COMMON shares only; preferred claims go into earningsBridge.preferredClaimsKRW
      .object({ dilutedCommon: z.number().int().positive().max(1e13), asOf: date, source: SourceSchema })
      .strict(),
    fx: z
      .array(
        z.object({ currency, krwPerUnit: z.number().positive().max(1e9), asOf: date, source: SourceSchema }).strict(),
      )
      .max(10),
    financials: z
      .object({ quarter, totalRevenueKRW: amount, source: SourceSchema })
      .strict(),
    markets: z.array(MarketSchema).min(1).max(20),
    products: z.array(ProductSchema).min(1).max(20),
    competitors: z.array(CompetitorSchema).max(30).optional(),
    residual: assumption(
      z.object({ annualGrowth: tri(growth), operatingMargin: tri(margin) }).strict(),
    ).optional(), // required when products cover < 98% of company revenue
    earningsBridge: assumption(
      z
        .object({
          netInterestKRW: z.number().min(-MAX_AMOUNT).max(MAX_AMOUNT), // next-quarter net interest income (+) / expense (-)
          effectiveTaxRate: z.number().min(0).max(0.5),
          noncontrollingShare: z.number().min(0).max(1), // fraction of net income
          // Total next-quarter earnings allocated to preferred classes (dividends AND any participation), KRW.
          // The model does not derive capital-class rights: the author states them and justifies them in `rationale`.
          preferredClaimsKRW: z.number().min(0).max(MAX_AMOUNT),
        })
        .strict(),
      true,
    ),
    valuation: z.object({ peMultiple: assumption(tri(z.number().min(3).max(40))) }).strict(),
  })
  .strict();

export type Dataset = z.infer<typeof DatasetSchema>;
export type Market = z.infer<typeof MarketSchema>;
export type Product = z.infer<typeof ProductSchema>;
export type Competitor = z.infer<typeof CompetitorSchema>;
export type Source = z.infer<typeof SourceSchema>;
export const SCENARIOS = ["bear", "base", "bull"] as const;
export type Scenario = (typeof SCENARIOS)[number];

// Competitors for global comparison: Korea, US and Japan only ("KR:000660", "US:MU", "JP:8035"), normalized to upper case.
const competitorIds = z
  .array(z.string().trim().toUpperCase().pipe(z.string().regex(/^(KR:\d{6}|US:[A-Z][A-Z0-9.-]{0,9}|JP:[0-9][0-9A-Z]{3})$/, "KR:000660, US:MU or JP:8035 (Korea, US and Japan only)")))
  .max(6)
  .transform((a) => [...new Set(a)]);

export const AnalysisRequestSchema = z
  .object({
    ticker: z.string().regex(/^[0-9][0-9A-Z]{5}$/, "six-character KOSPI/KOSDAQ ticker"),
    asOf: date.optional(), // demo mode only; a public analysis always runs as of today (Asia/Seoul)
    mode: z.enum(["public", "demo"]).default("public"),
    competitors: competitorIds.optional(),
  })
  .strict();

export const ResearchRequestSchema = z
  .object({ ticker: z.string().regex(/^[0-9][0-9A-Z]{5}$/, "six-character KOSPI/KOSDAQ ticker"), asOf: date.optional() /* ignored: always today */, competitors: competitorIds.optional() })
  .strict();
