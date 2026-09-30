import { DatasetSchema, type Dataset } from "../domain/schema.js";
import type { Issue } from "../errors.js";
import { listEstimates } from "../domain/market-structure.js";
import type { Citation, EvidenceDocument, Proposal } from "./types.js";

// Exact-match verification only: it proves a quote exists in a supplied document and that a number is derivable from
// it. It cannot prove the number means what the model says it means (that is what the independent audit is for).

export const MODEL_ASSUMPTION_PREFIX = "MODEL_ASSUMPTION:";
/** Source label of an inferred revenue figure (market size, product or competitor revenue); needs an `estimate` object. */
export const MODEL_ESTIMATE_PREFIX = "MODEL_ESTIMATE:";

// The unit word must directly follow the quoted number, and the run of Korean numeral characters after it must be
// exactly one of these tokens ("백만" is 1e6 and never "만" 1e4; unlisted compounds such as "천만" or "백억" match
// nothing, so they fail closed). Compound amounts like "1조 2,345억" are unsupported: cite a single-number quote.
const UNIT_TOKENS = new Map<string, number>([
  ["천", 1e3], ["만", 1e4], ["백만", 1e6], ["억", 1e8], ["십억", 1e9], ["조", 1e12],
  ["thousand", 1e3], ["million", 1e6], ["billion", 1e9], ["trillion", 1e12],
]);

// Strategy-owned citation fieldPaths (forecast/currentConsensus/priorConsensus/catalyst, see strategyVerify.ts) are
// a completely separate verification pool: a malformed or unverifiable strategy citation must never null out the
// unrelated product-market Dataset. They are skipped here entirely and re-checked independently by strategyVerify.ts.
const STRATEGY_FIELD_PREFIX = /^(forecast|currentConsensus|priorConsensus|catalyst)\./;

const ASSUMPTION_SOURCE_PATH =
  /^(markets\[\d+\]\.(annualGrowth|seasonality|cyclical)|products\[\d+\]\.(shareDelta|operatingMargin)|competitors\[\d+\]\.shareDelta|residual|earningsBridge|valuation\.peMultiple)\.source$/;
const ESTIMATE_SOURCE_PATH = /^(markets\[\d+\]\.observations\[\d+\]|products\[\d+\]\.revenue\[\d+\]|competitors\[\d+\]\.revenue\[\d+\])\.source$/;

const issue = (code: string, path: string, message: string): Issue => ({ code, path, message });
const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/**
 * Paths of every observed (non-assumption) numeric field the dataset carries. Revenue figures marked as ESTIMATES are not
 * "observed": they need no citation (they are checked by the estimate rules and reviewed by the auditor instead).
 */
export const observedNumericPaths = (d: Dataset): string[] => [
  "quote.priceKRW",
  "shares.dilutedCommon",
  ...d.fx.map((_, i) => `fx[${i}].krwPerUnit`),
  "financials.totalRevenueKRW",
  ...d.markets.flatMap((m, i) => m.observations.flatMap((o, j) => (o.estimate ? [] : [`markets[${i}].observations[${j}].revenue`]))),
  ...d.products.flatMap((p, i) => p.revenue.flatMap((r, j) => (r.estimate ? [] : [`products[${i}].revenue[${j}].revenue`]))),
  ...(d.competitors ?? []).flatMap((c, i) => c.revenue.flatMap((r, j) => (r.estimate ? [] : [`competitors[${i}].revenue[${j}].revenue`]))),
];

/** Paths of the ESTIMATED revenue figures (the auditor must review each one). */
export const estimatedPaths = (d: Dataset): string[] => listEstimates(d).map((e) => e.path);

const getPath = (root: unknown, path: string): unknown =>
  path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .reduce<any>((o, k) => (o == null ? undefined : o[k]), root);

const parseNumber = (s: string): number | null => {
  const t = s.replace(/,/g, "").trim();
  return /^-?\d+(\.\d+)?$/.test(t) ? Number(t) : null;
};

/** Structural check of one citation against the supplied documents. Returns null when valid. */
export function checkCitation(c: Citation, docs: Map<string, EvidenceDocument>, asOf: string): Issue | null {
  const at = `citations:${c.fieldPath}`;
  const doc = docs.get(c.documentId);
  if (!doc) return issue("CITATION_UNKNOWN_DOCUMENT", at, `documentId "${c.documentId}" is not a supplied (eligible) document`);
  if (c.url !== doc.url) return issue("CITATION_URL_MISMATCH", at, "citation url differs from the supplied document url");
  if (c.publishedAt !== doc.publishedAt) return issue("CITATION_DATE_MISMATCH", at, "citation publishedAt differs from the supplied document");
  if (doc.publishedAt > asOf) return issue("CITATION_FUTURE_SOURCE", at, "document is published after asOf");
  if (!doc.text.includes(c.evidenceQuote)) return issue("CITATION_QUOTE_NOT_FOUND", at, "evidenceQuote does not occur verbatim in the document text");
  return null;
}

/**
 * Multipliers the quote itself authorises for each standalone occurrence of `num`: the unit token right after the
 * number (optional whitespace), 1 when none follows, undefined when a Korean numeral run is not a known unit.
 */
export function unitMultipliers(quote: string, num: string): (number | undefined)[] {
  const re = new RegExp(`(?<![\\d,.])${escapeRe(num)}(?!\\d|[,.]\\d)\\s*([천백십만억조]+|[A-Za-z]+)?`, "g");
  return [...quote.matchAll(re)].map((m) => {
    const run = m[1]?.toLowerCase();
    if (run === undefined) return 1;
    if (UNIT_TOKENS.has(run)) return UNIT_TOKENS.get(run);
    return /^[천백십만억조]+$/.test(run) ? undefined : 1; // an English word that is not a scale (won, shares...) adds none
  });
}

/** value must equal quotedNumber * multiplier, with the multiplier being exactly the unit written after the number. */
export function numericSupport(c: Citation, value: number): string | null {
  const mult = c.multiplier ?? 1;
  if (!c.quotedNumber) return "citation has no quotedNumber";
  const seen = unitMultipliers(c.evidenceQuote, c.quotedNumber);
  if (!seen.length) return "quotedNumber does not stand alone inside evidenceQuote";
  if (!seen.includes(mult)) return `multiplier ${mult} is not the unit written after ${c.quotedNumber} in evidenceQuote`;
  const n = parseNumber(c.quotedNumber);
  if (n === null) return "quotedNumber is not a plain number";
  if (Math.abs(n * mult - value) > 1e-9 * Math.max(1, Math.abs(value))) return `${c.quotedNumber} x ${mult} does not equal ${value}`;
  return null;
}

export type Verified = {
  dataset: Dataset | null;
  citations: Citation[]; // structurally valid ones only
  issues: Issue[];
  observedPaths: string[];
  estimatedPaths: string[];
};

export function verifyProposal(asOf: string, ticker: string, docs: EvidenceDocument[], p: Proposal): Verified {
  const byId = new Map(docs.map((d) => [d.id, d]));
  const issues: Issue[] = [];
  const citations: Citation[] = [];
  for (const c of p.citations) {
    if (STRATEGY_FIELD_PREFIX.test(c.fieldPath)) continue;
    const bad = checkCitation(c, byId, asOf);
    if (bad) issues.push(bad);
    else citations.push(c);
  }

  const finish = (dataset: Dataset | null, observedPaths: string[] = [], estPaths: string[] = []): Verified => ({
    dataset: issues.length ? null : dataset,
    citations,
    issues,
    observedPaths,
    estimatedPaths: estPaths,
  });

  if (p.dataset === null) {
    if (!p.missingFields.length) issues.push(issue("NO_DATASET_NO_REASON", "dataset", "dataset is null but missingFields is empty"));
    return finish(null);
  }
  if (p.missingFields.length) issues.push(issue("DATASET_WITH_MISSING_FIELDS", "missingFields", "dataset supplied although the model lists missing fields"));

  const parsed = DatasetSchema.safeParse(p.dataset);
  if (!parsed.success) {
    for (const i of parsed.error.issues.slice(0, 20)) issues.push(issue("DATASET_SCHEMA", i.path.join(".") || "(root)", i.message));
    return finish(null);
  }
  const d = parsed.data;

  if (d.synthetic) issues.push(issue("SYNTHETIC_DATASET", "synthetic", "synthetic datasets are never accepted"));
  if (d.company.ticker !== ticker) issues.push(issue("TICKER_MISMATCH", "company.ticker", `dataset ticker differs from requested ${ticker}`));
  for (const [path, date] of [["quote.asOf", d.quote.asOf], ["shares.asOf", d.shares.asOf], ...d.fx.map((f, i) => [`fx[${i}].asOf`, f.asOf])] as [string, string][])
    if (date > asOf) issues.push(issue("FUTURE_DATE", path, `${date} is after asOf ${asOf}`));
  for (const [i, m] of d.markets.entries())
    for (const [j, o] of m.observations.entries())
      if (o.basis !== "quarterly") issues.push(issue("NOT_QUARTERLY", `markets[${i}].observations[${j}].basis`, "only quarterly observations are accepted"));

  // Every Source object: a supplied doc (url + date match) or, on assumption fields only, a labelled model assumption.
  const walk = (node: unknown, path: string) => {
    if (Array.isArray(node)) return node.forEach((v, i) => walk(v, `${path}[${i}]`));
    if (!node || typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      const child = path ? `${path}.${k}` : k;
      if (k === "source") checkSource(v as any, child);
      else walk(v, child);
    }
  };
  const checkSource = (s: { url?: string; manualReference?: string; publishedAt: string }, path: string) => {
    if (s.publishedAt > asOf) issues.push(issue("FUTURE_SOURCE", path, `source date ${s.publishedAt} is after asOf`));
    if (s.url) {
      const same = docs.filter((x) => x.url === s.url);
      if (!same.length) issues.push(issue("UNKNOWN_SOURCE_URL", path, "source url is not among the supplied documents"));
      else if (!same.some((x) => x.publishedAt === s.publishedAt)) issues.push(issue("SOURCE_DATE_MISMATCH", path, "source publishedAt differs from the supplied document"));
      return;
    }
    const owner = getPath(d, path.replace(/\.source$/, "")) as { rationale?: string; estimate?: unknown } | undefined;
    if (s.manualReference?.startsWith(MODEL_ESTIMATE_PREFIX)) {
      if (!ESTIMATE_SOURCE_PATH.test(path)) issues.push(issue("MODEL_ESTIMATE_ON_OBSERVED_FIELD", path, "MODEL_ESTIMATE is only allowed on market, product and competitor revenue figures"));
      else if (!owner?.estimate) issues.push(issue("ESTIMATE_MISSING", path, "a MODEL_ESTIMATE source needs an `estimate` object (method, basedOn, rationale) on the same entry"));
      return;
    }
    const rationale = owner?.rationale;
    if (!s.manualReference?.startsWith(MODEL_ASSUMPTION_PREFIX)) issues.push(issue("SOURCE_NOT_SUPPLIED", path, "source must reference a supplied document url"));
    else if (!ASSUMPTION_SOURCE_PATH.test(path)) issues.push(issue("MODEL_ASSUMPTION_ON_OBSERVED_FIELD", path, "MODEL_ASSUMPTION is only allowed on assumption fields"));
    else if (!rationale?.trim()) issues.push(issue("ASSUMPTION_WITHOUT_RATIONALE", path, "model assumptions need a rationale"));
  };
  walk(d, "");
  d.company.sources.forEach((s, i) => checkSource(s, `company.sources[${i}]`)); // key is "sources", not "source"

  // Estimated figures: allowed, but labelled (source), reasoned (estimate) and rooted in something checkable.
  const docIds = new Set(docs.map((x) => x.id));
  for (const e of listEstimates(d)) {
    const at = e.path;
    const src = getPath(d, at.replace(/\.revenue$/, ".source")) as { url?: string; manualReference?: string } | undefined;
    if (!src?.url && !src?.manualReference?.startsWith(MODEL_ESTIMATE_PREFIX))
      issues.push(issue("ESTIMATE_NOT_LABELLED", at, `an estimated figure needs a source that is a supplied document or "${MODEL_ESTIMATE_PREFIX} ..."`));
    if (e.estimate.method !== "model_knowledge" && !e.estimate.basedOn.length) issues.push(issue("ESTIMATE_WITHOUT_BASIS", at, "only method model_knowledge may have an empty basedOn"));
    for (const b of e.estimate.basedOn) {
      if (b === at) issues.push(issue("ESTIMATE_SELF_REFERENCE", at, "an estimate cannot be based on itself"));
      else if (!docIds.has(b) && typeof getPath(d, b) !== "number") issues.push(issue("ESTIMATE_BASIS_UNKNOWN", at, `basedOn "${b}" is neither a supplied document id nor a numeric dataset path`));
    }
    if (e.estimate.method === "share_implied" && !e.estimate.basedOn.some((b) => /^products\[\d+\]\.revenue\[\d+\]\.revenue$/.test(b)))
      issues.push(issue("ESTIMATE_BASIS_MISMATCH", at, "share_implied must be based on a product revenue path (market = product revenue / stated share)"));
    if (e.estimate.method === "prior_extrapolation" && !e.estimate.basedOn.some((b) => /^(markets\[\d+\]\.observations\[\d+\]|competitors\[\d+\]\.revenue\[\d+\]|products\[\d+\]\.revenue\[\d+\])\.revenue$/.test(b) || docIds.has(b)))
      issues.push(issue("ESTIMATE_BASIS_MISMATCH", at, "prior_extrapolation must be based on an earlier figure (dataset path or supplied document)"));
  }

  // Observed numbers: citation on the same path, same doc as the field's own source, and numeric support.
  const observedPaths = observedNumericPaths(d);
  for (const path of observedPaths) {
    const value = getPath(d, path) as number;
    const src = getPath(d, path.replace(/\.[^.]+$/, ".source")) as { url?: string } | undefined;
    const cands = citations.filter((c) => c.fieldPath === path);
    if (!cands.length) {
      issues.push(issue("NUMBER_UNCITED", path, "observed number has no valid citation"));
      continue;
    }
    const reasons: string[] = [];
    const ok = cands.some((c) => {
      const why = c.url !== src?.url ? "citation url differs from the field's source url" : numericSupport(c, value);
      if (why) reasons.push(why);
      return !why;
    });
    if (!ok) issues.push(issue("NUMBER_UNSUPPORTED", path, reasons[0] ?? "no supporting citation"));
  }
  return finish(d, observedPaths, estimatedPaths(d));
}
