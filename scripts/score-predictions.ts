// Scores the analysis prediction log (data/records/predictions.jsonl) against reported quarterly EPS and the latest
// close from Naver (no DART, no LLM):  npm run predictions:score [-- --json]
import { collectPublicEvidence } from "../src/collection/index.js";
import { loadConfig } from "../src/config.js";
import { seoulToday } from "../src/domain/time.js";
import { fileRecorder, scorePrediction, summarizeScores, type PredictionScore } from "../src/research/predictions.js";

const config = loadConfig();
const log = fileRecorder(config.dataDir);
const records = await log.readAll();
const today = seoulToday(new Date());
const rows: PredictionScore[] = [];
for (const ticker of new Set(records.map((r) => r.ticker))) {
  let actuals: Awaited<ReturnType<typeof collectPublicEvidence>>["market"]["quarterlyActuals"] = [];
  let close: { date: string; closeKRW: number } | null = null;
  try {
    const ev = await collectPublicEvidence({ ticker, asOf: today }, { env: { ...process.env, DART_API_KEY: "", NAVER_CLIENT_ID: "", NAVER_CLIENT_SECRET: "" }, cacheDir: config.cacheDir });
    actuals = ev.market.quarterlyActuals ?? [];
    const latest = ev.market.dailyCloses?.[0];
    close = latest ? { date: latest.date, closeKRW: latest.closeKRW } : null;
  } catch (e) {
    console.error(`${ticker}: ${(e as Error).message}`);
  }
  for (const r of records.filter((x) => x.ticker === ticker)) rows.push(...scorePrediction(r, actuals ?? [], close));
}
const summary = summarizeScores(rows);
if (process.argv.includes("--json")) console.log(JSON.stringify({ rows, summary }, null, 2));
else {
  const pct = (v: number | null) => (v === null ? "-" : `${v.toFixed(1)}%`);
  const share = (s: { hits: number; of: number; rate: number } | null) => (s ? `${s.hits}/${s.of} (${(s.rate * 100).toFixed(0)}%)` : "-");
  console.log(`예측 기록 ${records.length}건 → 채점 ${summary.scored}행, 대기 ${summary.pending}행 (${log.file})`);
  console.log(`가치 계산(기본 시나리오) 분기 EPS 평균 절대 오차 ${pct(summary.valuation.meanAbsEpsErrorPct)} · 실제가 비관~낙관 범위 안 ${share(summary.valuation.actualWithinScenarioRange)}`);
  console.log(`한 분기 추정 EPS 평균 절대 오차 ${pct(summary.quarterEstimate.meanAbsEpsErrorPct)} vs 컨센서스 ${pct(summary.quarterEstimate.consensusMeanAbsEpsErrorPct)} · 컨센서스보다 정확 ${share(summary.quarterEstimate.moreAccurateThanConsensus)}`);
  console.log(`목표가 방향(상승여력 부호) vs 이후 주가 방향 적중 ${share(summary.priceDirectionHit)}`);
}
