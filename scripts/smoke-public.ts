// Real-network smoke test of the evidence collector (NO LLM, no model quota): npm run smoke:public -- 005930
// DART is only used if DART_API_KEY is set (from .env). Prints a redacted summary, never key values.
import { collectPublicEvidence } from "../src/collection/index.js";
import { buildDocuments } from "../src/research/evidence.js";
import { seoulToday } from "../src/domain/time.js";

const args = process.argv.slice(2).filter((a) => !a.startsWith("--"));
const noDart = process.argv.includes("--no-dart"); // simulate a missing DART key even if .env has one
const ticker = args[0] ?? "005930";
const asOf = args[1] ?? seoulToday(new Date());
const ev = await collectPublicEvidence({ ticker, asOf }, noDart ? { env: { ...process.env, DART_API_KEY: "" } } : {});
const built = buildDocuments(ev);
console.log(
  JSON.stringify(
    {
      ticker,
      asOf,
      status: ev.status,
      providers: Object.fromEntries(Object.entries(ev.providers).map(([k, v]) => [k, v.status])),
      company: ev.company,
      quote: ev.market.quote && { close: ev.market.quote.close, tradedAt: ev.market.quote.tradedAt, tradedOnAsOfDate: ev.market.quote.tradedOnAsOfDate },
      news: ev.market.news.length,
      filings: ev.filings.list.length,
      statements: ev.filings.statements.length,
      documentsForModels: built.refs.map((r) => `${r.kind}:${r.id}(${r.chars})`),
      issues: ev.issues.map((i) => `${i.provider}/${i.code}/${i.severity}`),
      requiredInputs: ev.requiredInputs.map((r) => `${r.field}:${r.status}`),
    },
    null,
    2,
  ),
);
