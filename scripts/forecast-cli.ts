// Short-term forecast from the command line (live Naver data):
//   npm run forecast -- 005930                      forecast + backtest, pooled with the 20 largest peers
//   npm run forecast -- 005930 --peers 000660,035420  explicit peers   (--peer-count N, --json)
//   npm run forecast -- --rank [--exchange KOSDAQ] [--count 30] [--horizon 1]   stocks most likely to rise
//   npm run forecast -- --score                     score every logged forecast against later closes
//   npm run forecast -- --check [ticker]            check each data source and which fields it really returns
import { loadConfig } from "../src/config.js";
import { ForecastService } from "../src/forecast/service.js";
import { UniverseProvider } from "../src/research/universe.js";
import { createHttp } from "../src/collection/http.js";
import { loadIndex, loadStock, loadUsdKrw } from "../src/forecast/history.js";

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const config = loadConfig();
const svc = new ForecastService({ universe: new UniverseProvider(), logDir: config.dataDir });
const pct = (v: number | null | undefined, d = 1) => (v === null || v === undefined ? "-" : `${v >= 0 ? "+" : ""}${v.toFixed(d)}%`);
const rate = (v: number | null | undefined) => (v === null || v === undefined ? "-" : `${(v * 100).toFixed(1)}%`);

if (argv.includes("--check")) {
  const ticker = argv.find((a) => /^[0-9][0-9A-Z]{5}$/i.test(a))?.toUpperCase() ?? "005930";
  const http = createHttp({ fetch, timeoutMs: 15_000, maxBytes: 5 * 1024 * 1024, maxRequests: 20, secrets: [] });
  const share = (n: number, of: number) => `${n}/${of}`;
  try {
    const s = await loadStock(http, ticker, { maxPages: 2 });
    const b = s.bars;
    console.log(`✔ 종목 시세 ${ticker} ${s.name ?? ""} (${s.exchange}): ${b.length}거래일 ${b[0]?.date}~${b.at(-1)?.date}`);
    console.log(`  시가 ${share(b.filter((x) => x.open !== null).length, b.length)} · 고가 ${share(b.filter((x) => x.high !== null).length, b.length)} · 저가 ${share(b.filter((x) => x.low !== null).length, b.length)} · 거래량 ${share(b.filter((x) => x.volume !== null).length, b.length)} (없으면 해당 특징만 비어 있고 예측은 계속됩니다)`);
    try {
      const idx = await loadIndex(http, s.exchange, { maxPages: 1 });
      console.log(idx.length ? `✔ ${s.exchange} 지수: ${idx.length}거래일, 최근 ${idx.at(-1)?.date} ${idx.at(-1)?.close}` : `✘ ${s.exchange} 지수: 응답은 왔지만 시세 행이 없습니다`);
    } catch (e) {
      console.log(`✘ ${s.exchange} 지수: ${(e as Error).message} (지수 특징 없이 예측합니다)`);
    }
    try {
      const fx = await loadUsdKrw(http, b[0]!.date, b.at(-1)!.date);
      console.log(fx.length ? `✔ 원/달러(ECB): ${fx.length}일, 최근 ${fx.at(-1)?.date} ${fx.at(-1)?.close}` : "✘ 원/달러: 환율 행이 없습니다");
    } catch (e) {
      console.log(`✘ 원/달러(ECB): ${(e as Error).message} (환율 특징 없이 예측합니다)`);
    }
  } catch (e) {
    console.log(`✘ 종목 시세 ${ticker}: ${(e as Error).message} — 예측할 수 없습니다(네트워크·방화벽을 확인하세요)`);
    process.exit(1);
  }
  try {
    const u = await new UniverseProvider().get();
    console.log(`✔ 종목 목록: ${u.items.length}개 보통주 (순위·동종 학습에 사용)`);
  } catch (e) {
    console.log(`✘ 종목 목록: ${(e as Error).message} (순위 기능과 자동 동종 선택을 쓸 수 없습니다)`);
  }
} else if (argv.includes("--rank")) {
  const r = await svc.rank({ exchange: flag("--exchange") === "KOSDAQ" ? "KOSDAQ" : "KOSPI", count: flag("--count") ? Number(flag("--count")) : undefined, horizon: (Number(flag("--horizon")) || 1) as 1 | 2 | 3 }).catch((e: Error) => {
    console.error(`순위 계산 실패: ${e.message}`);
    process.exit(1);
  });
  if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else {
    const b = r.pooledBacktest;
    console.log(`${r.exchange} 상위 종목 ${r.horizon}거래일 상승 확률 순위 · 종목군 백테스트 적중 ${rate(b.accuracy)} (n=${b.n}, 항상상승 ${rate(b.alwaysUpAccuracy)}, 모멘텀 ${rate(b.momentumAccuracy)}, 80% 범위 실제 적중 ${rate(b.range80Coverage)}) · 우위 ${b.edge === "detected" ? "있음" : "없음"}`);
    console.log(`보정표(예측 상승확률 → 실제 상승 비율): ${b.calibration.map((c) => `${(c.from * 100).toFixed(0)}~${(c.to * 100).toFixed(0)}%: ${rate(c.actualUpRate)} (n=${c.n})`).join(" · ")}`);
    r.ranked.forEach((x, i) => console.log(`${String(i + 1).padStart(2)}. ${x.ticker} ${(x.name ?? "").padEnd(12)} 상승확률 ${rate(x.probabilityUp)} 예상 ${pct(x.expectedReturnPct, 2)} (80% ${pct(x.range80Pct[0])}~${pct(x.range80Pct[1])}) 신뢰도 ${x.confidence}${x.actionable ? " ★" : ""}`));
    for (const n of r.notes) console.log(`- ${n}`);
  }
} else if (argv.includes("--score")) {
  const { scores, summary } = await svc.scoreLog();
  if (argv.includes("--json")) console.log(JSON.stringify({ scores, summary }, null, 2));
  else {
    console.log(`채점 완료 ${summary.all.n}건, 대기 ${summary.pending}건`);
    console.log(`방향 적중률 ${rate(summary.all.directionAccuracy)} · 평균 절대 오차 ${summary.all.meanAbsErrorPct?.toFixed(2) ?? "-"}%p · 80% 구간 적중 ${rate(summary.all.range80Coverage)}`);
    for (const [h, s] of Object.entries(summary.byHorizon)) console.log(`  ${h}거래일: n=${s.n} 적중 ${rate(s.directionAccuracy)}`);
    for (const [c, s] of Object.entries(summary.byConfidence)) console.log(`  신뢰도 ${c}: n=${s.n} 적중 ${rate(s.directionAccuracy)}`);
  }
} else {
  const ticker = argv.find((a) => /^[0-9][0-9A-Z]{5}$/i.test(a))?.toUpperCase();
  if (!ticker) {
    console.error("usage: npm run forecast -- <ticker> [--peers t1,t2] [--peer-count N] [--json] | --score");
    process.exit(2);
  }
  const peers = flag("--peers")?.split(",").map((x) => x.trim().toUpperCase()).filter(Boolean);
  const peerCount = flag("--peer-count") ? Number(flag("--peer-count")) : undefined;
  const r = await svc.run(ticker, { peers, peerCount }).catch((e: Error) => {
    console.error(`예측 실패: ${e.message}`);
    process.exit(1);
  });
  if (argv.includes("--json")) console.log(JSON.stringify(r, null, 2));
  else {
    console.log(`${r.ticker} 기준일 ${r.asOfDate} 종가 ${r.lastCloseKRW.toLocaleString("ko-KR")}원 · 학습 종목 ${r.trainedOn.tickers.length}개, 표본 ${r.trainedOn.samples}개`);
    for (const h of r.horizons) {
      const b = h.backtest;
      console.log(
        `  ${h.horizon}거래일 후: ${h.direction === "up" ? "상승" : "하락"} 확률 ${rate(h.direction === "up" ? h.probabilityUp : 1 - h.probabilityUp)} · 예상 ${pct(h.expectedReturnPct, 2)} (80% 범위 ${pct(h.range80Pct[0], 1)} ~ ${pct(h.range80Pct[1], 1)}) · 신뢰도 ${h.confidence}${h.actionable ? " · 비용 넘는 기대수익" : ""}`,
      );
      console.log(`      백테스트 ${b.from}~${b.to} n=${b.n}: 적중 ${rate(b.accuracy)} (항상상승 ${rate(b.alwaysUpAccuracy)}, 모멘텀 ${rate(b.momentumAccuracy)}) · 상위30% 확신 적중 ${rate(b.confidentAccuracy)} · 80% 범위 실제 적중 ${rate(b.range80Coverage)} · 우위 ${b.edge === "detected" ? "있음" : "없음"}`);
      console.log(`      보정표(예측 상승확률 → 실제 상승 비율): ${b.calibration.map((c) => `${(c.from * 100).toFixed(0)}~${(c.to * 100).toFixed(0)}%: ${rate(c.actualUpRate)} (n=${c.n})`).join(" · ")}`);
    }
    for (const n of r.notes) console.log(`  - ${n}`);
  }
}
