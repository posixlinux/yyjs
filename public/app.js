"use strict";
// All server/evidence text is untrusted: it is only ever inserted with textContent, never as HTML.

const $ = (id) => document.getElementById(id);
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === "class") n.className = v;
    else if (k === "text") n.textContent = v;
    else n.setAttribute(k, v === true ? "" : String(v));
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};
const safeLink = (url, label) => {
  try {
    const u = new URL(url);
    if (u.protocol === "https:") return el("a", { href: u.href, target: "_blank", rel: "noopener noreferrer", text: label });
  } catch { /* fall through */ }
  return document.createTextNode(label);
};

const won = (n) => (typeof n === "number" && Number.isFinite(n) ? `${Math.round(n).toLocaleString("ko-KR")}원` : "-");
const big = (n) => {
  if (typeof n !== "number" || !Number.isFinite(n)) return "-";
  const a = Math.abs(n);
  const s = n < 0 ? "-" : "";
  if (a >= 1e12) return `${s}${(a / 1e12).toLocaleString("ko-KR", { maximumFractionDigits: 2 })}조원`;
  if (a >= 1e8) return `${s}${(a / 1e8).toLocaleString("ko-KR", { maximumFractionDigits: 0 })}억원`;
  return `${s}${Math.round(a).toLocaleString("ko-KR")}원`;
};
const pct = (n) => (typeof n === "number" && Number.isFinite(n) ? `${n >= 0 ? "+" : ""}${n.toFixed(1)}%` : "-");

// ---- API ----------------------------------------------------------------------------------------------------------

let apiKeyRequired = false;
const headers = () => {
  const h = { "content-type": "application/json" };
  const k = $("apiKey").value.trim();
  if (k) h["x-api-key"] = k;
  return h;
};
async function api(path, init) {
  const res = await fetch(path, init);
  let body = null;
  try { body = await res.json(); } catch { /* non-JSON */ }
  if (!res.ok) {
    const e = body && body.error ? body.error : { code: `HTTP_${res.status}`, message: `요청 실패 (HTTP ${res.status})` };
    throw Object.assign(new Error(e.message), { code: e.code, status: res.status, hint: e.hint });
  }
  return body;
}

// ---- stock picker -------------------------------------------------------------------------------------------------
// The full KOSPI/KOSDAQ common-stock list is fetched once and searched locally (name, 초성, ticker); the dropdown
// renders matches in chunks as it scrolls so every stock is reachable without drawing thousands of rows at once.

const CHO = "ㄱㄲㄴㄷㄸㄹㅁㅂㅃㅅㅆㅇㅈㅉㅊㅋㅌㅍㅎ";
const norm = (s) => String(s || "").toLowerCase().replace(/\s+/g, "");
const choseong = (s) => Array.from(String(s || "")).map((ch) => {
  const c = ch.charCodeAt(0) - 0xac00;
  return c >= 0 && c < 11172 ? CHO[Math.floor(c / 588)] : ch.toLowerCase();
}).join("").replace(/\s+/g, "");

const CHUNK = 150;
let universe = [];
let universeError = null;
let matches = [];
let shown = 0;
let active = -1;
let pickedLabel = ""; // the search box shows the picked stock; treat that text as an empty query

const exLabel = (ex) => (ex === "KOSDAQ" ? "코스닥" : "코스피");
const isOpen = () => !$("list").hidden;
function setOpen(open) {
  $("list").hidden = !open;
  $("q").setAttribute("aria-expanded", String(open));
  if (!open) { active = -1; $("q").setAttribute("aria-activedescendant", ""); }
}

async function loadUniverse() {
  $("listInfo").textContent = "KOSPI·KOSDAQ 종목 목록을 불러오는 중…";
  try {
    const r = await api("/v1/universe?limit=5000");
    const items = Array.isArray(r && r.items) ? r.items : [];
    universe = items.map((it) => ({ ...it, key: norm(it.name), cho: choseong(it.name) }));
    universeError = universe.length ? null : "빈 목록";
  } catch (e) {
    universeError = e.message || "알 수 없는 오류";
  }
  refresh();
}

function search(qRaw) {
  const q = norm(qRaw);
  const market = $("market").value;
  const sort = $("sort").value;
  const choOnly = q && /^[ㄱ-ㅎ]+$/.test(q);
  const out = [];
  for (const it of universe) {
    if (market && it.exchange !== market) continue;
    let rank = 0;
    if (q) {
      const t = it.ticker.toLowerCase();
      if (t === q) rank = 0;
      else if (t.startsWith(q)) rank = 1;
      else if (it.key === q) rank = 2;
      else if (it.key.startsWith(q)) rank = 3;
      else if (it.key.includes(q)) rank = 4;
      else if (choOnly && it.cho.startsWith(q)) rank = 5;
      else if (choOnly && it.cho.includes(q)) rank = 6;
      else continue;
    }
    out.push([rank, it]);
  }
  const by = sort === "name" ? (a, b) => a.name.localeCompare(b.name, "ko")
    : sort === "ticker" ? (a, b) => a.ticker.localeCompare(b.ticker)
    : (a, b) => b.marketCapKRW - a.marketCapKRW || a.ticker.localeCompare(b.ticker);
  out.sort((a, b) => a[0] - b[0] || by(a[1], b[1]));
  return out.map((x) => x[1]);
}

function optionNode(it, i) {
  const cap = it.marketCapKRW > 0 ? big(it.marketCapKRW) : "";
  return el("div", { class: "item", role: "option", id: `opt-${i}`, "data-idx": i, "aria-selected": $("ticker").value === it.ticker },
    el("span", {}, el("strong", { text: it.name }), " ", el("span", { class: "code", text: `${it.ticker} · ${exLabel(it.exchange)}` })),
    el("span", { class: "cap", text: cap }));
}
function renderMore() {
  const next = matches.slice(shown, shown + CHUNK);
  $("list").append(...next.map((it, k) => optionNode(it, shown + k)));
  shown += next.length;
}

function refresh() {
  matches = search($("q").value === pickedLabel ? "" : $("q").value);
  shown = 0;
  active = -1;
  $("list").replaceChildren();
  $("list").scrollTop = 0;
  renderMore();
  if (!matches.length) $("list").append(el("div", { class: "empty", text: universe.length ? "검색 결과가 없습니다." : "목록을 불러오지 못했습니다." }));
  const kospi = universe.filter((i) => i.exchange === "KOSPI").length;
  $("listInfo").textContent = universeError
    ? `종목 목록을 불러오지 못했습니다 (${universeError}). 아래에 6자리 종목 번호를 직접 입력하세요.`
    : `KOSPI 보통주 ${kospi.toLocaleString("ko-KR")} · KOSDAQ 보통주 ${(universe.length - kospi).toLocaleString("ko-KR")}종목 중 ${matches.length.toLocaleString("ko-KR")}종목 해당`;
}

function setActive(i) {
  if (!matches.length) return;
  active = Math.max(0, Math.min(matches.length - 1, i));
  while (active >= shown) renderMore();
  for (const n of $("list").children) if (n.dataset && n.dataset.idx !== undefined) n.classList.toggle("active", Number(n.dataset.idx) === active);
  $("q").setAttribute("aria-activedescendant", `opt-${active}`);
  const node = document.getElementById(`opt-${active}`);
  if (node && node.scrollIntoView) node.scrollIntoView({ block: "nearest" });
}

function pick(i) {
  const it = matches[i];
  if (!it) return;
  $("ticker").value = it.ticker;
  $("q").value = pickedLabel = `${it.name} (${it.ticker})`;
  $("listInfo").textContent = `선택: ${it.name} · ${it.ticker} · ${exLabel(it.exchange)}${it.marketCapKRW > 0 ? ` · 시가총액 ${big(it.marketCapKRW)}` : ""}`;
  setOpen(false);
}

$("list").addEventListener("mousedown", (e) => e.preventDefault()); // keep focus in the search box
$("list").addEventListener("click", (e) => {
  const n = e.target.closest(".item");
  if (n) pick(Number(n.dataset.idx));
});
$("list").addEventListener("scroll", () => {
  const l = $("list");
  if (shown < matches.length && l.scrollTop + l.clientHeight >= l.scrollHeight - 200) renderMore();
});
$("q").addEventListener("input", () => {
  const q = $("q").value.trim();
  if (/^[0-9][0-9A-Za-z]{5}$/.test(q)) $("ticker").value = q.toUpperCase(); // typing a full ticker selects it
  refresh();
  setOpen(true);
  if (q && matches.length) setActive(0);
});
$("q").addEventListener("focus", () => { $("q").select(); refresh(); setOpen(true); });
$("q").addEventListener("blur", () => setOpen(false));
$("q").addEventListener("keydown", (e) => {
  if (e.key === "ArrowDown" || e.key === "ArrowUp") {
    e.preventDefault();
    if (!isOpen()) { refresh(); setOpen(true); }
    setActive(active < 0 ? 0 : active + (e.key === "ArrowDown" ? 1 : -1));
  } else if (e.key === "PageDown" || e.key === "PageUp") {
    if (!isOpen()) return;
    e.preventDefault();
    setActive(active + (e.key === "PageDown" ? 10 : -10));
  } else if (e.key === "Enter") {
    if (isOpen() && active >= 0) { e.preventDefault(); pick(active); }
  } else if (e.key === "Escape") {
    if (isOpen()) { e.preventDefault(); setOpen(false); }
  }
});
$("qToggle").addEventListener("mousedown", (e) => e.preventDefault());
$("qToggle").addEventListener("click", () => {
  if (isOpen()) return setOpen(false);
  $("q").focus(); // focus handler opens the list; open explicitly too in case the box already had focus
  refresh();
  setOpen(true);
});
for (const id of ["market", "sort"]) $(id).addEventListener("change", () => { refresh(); if (document.activeElement === $("q")) setOpen(true); });

// ---- rendering ----------------------------------------------------------------------------------------------------

const STATUS = {
  queued: ["대기 중", ""], running: ["진행 중", ""], completed: ["완료", "ok"], partial: ["부분 결과", "warn"], failed: ["실패", "bad"],
};
const PROVIDER = { ok: ["정상", "ok"], error: ["오류", "bad"], skipped: ["건너뜀", "warn"], not_configured: ["미설정", "warn"], partial: ["일부", "warn"], failed: ["실패", "bad"] };
const badge = (map, key) => { const [t, c] = map[key] || [String(key), ""]; return el("span", { class: `badge ${c}`, text: t }); };

function section(title, ...kids) { return el("div", {}, el("h3", { text: title }), ...kids); }

function renderEvidence(ev) {
  if (!ev) return null;
  const quote = ev.quote || (ev.market && ev.market.quote) || null;
  const news = ev.news || [...((ev.market && ev.market.news) || []), ...((ev.market && ev.market.searchNews) || [])];
  const filings = (ev.filings && ev.filings.list) || [];
  const statements = (ev.filings && ev.filings.statements) || [];
  const parts = [];
  const company = ev.company || {};
  parts.push(el("dl", { class: "kv" },
    el("dt", { text: "회사" }), el("dd", { text: `${company.name || "-"} (${ev.ticker || ""})${company.exchange ? ` · ${company.exchange}` : ""}` }),
    el("dt", { text: "현재가" }), el("dd", { text: quote ? `${won(quote.close)} (체결 ${quote.tradedAt})` : "수집되지 않음" }),
    el("dt", { text: "DART 공시" }), el("dd", { text: ev.providers?.dart?.status === "not_configured"
      ? "수집 안 함 — 서버에 DART_API_KEY가 설정되지 않았습니다"
      : `정기보고서 ${filings.length}건 · 재무제표 ${statements.length}건` }),
    el("dt", { text: "뉴스" }), el("dd", { text: `${news.length}건` }),
    ...(ev.competitors ? [el("dt", { text: "경쟁사 공시 매출" }), el("dd", { text: ev.competitors.length ? `${ev.competitorSelection === "naver_industry" ? "[자동 선정 · 네이버 동종업종] " : ""}${ev.competitors.map((c) => `${c.market}:${c.code}${c.name ? ` ${c.name}` : ""} (${c.system}, ${c.periods.length}개 기간)`).join(" · ")}` : "수집되지 않음" })] : []),
  ));
  const prov = ev.providers || {};
  if (prov.dart?.status === "not_configured")
    parts.push(el("div", { class: "box warn", text: "DART 공시·재무제표를 수집하지 않았습니다. 서버 폴더의 .env 파일에 DART_API_KEY(OpenDART 무료 인증키)를 넣고 서버를 다시 시작하세요. 키가 없으면 가치 계산도 할 수 없습니다." }));
  parts.push(el("p", { class: "small" }, "수집 상태: ", ...["naver", "dart", "naverSearch"].filter((k) => prov[k]).flatMap((k) => [`${k} `, badge(PROVIDER, prov[k].status), "  "]),
    ...Object.entries(prov.competitors || {}).flatMap(([m, r]) => [`경쟁사 ${m} `, badge(PROVIDER, r.status), "  "])));
  const issues = (ev.issues || []).filter((i) => i.severity !== "info");
  if (issues.length) parts.push(el("ul", { class: "plain" }, issues.slice(0, 8).map((i) => el("li", { text: `[${i.provider}] ${i.code}: ${i.message}` }))));
  if (filings.length) parts.push(el("details", {}, el("summary", { text: `DART 정기보고서 ${filings.length}건` }),
    el("ul", { class: "plain" }, filings.map((f) => el("li", {}, safeLink(f.receiptUrl, f.reportName), ` (${f.receivedDate})`)))));
  if (news.length) parts.push(el("details", {}, el("summary", { text: `뉴스 ${Math.min(news.length, 12)}건` }),
    el("ul", { class: "plain" }, news.slice(0, 12).map((n) => el("li", {}, safeLink(n.url, n.title), ` (${(n.publishedAt || "").slice(0, 10)}${n.officeName ? `, ${n.officeName}` : ""})`)))));
  return section("수집된 증거", ...parts);
}

const MODEL_LABEL = { claude: "Claude", codex: "Codex", agy: "agy" };
function renderResearch(r) {
  if (!r) return null;
  const parts = [];
  parts.push(el("p", {}, "검토 결과: ", badge({ accepted: ["교차검증 통과", "ok"], single_model: ["단일 모델 (교차검증 없음)", "warn"], partial: ["부분", "warn"], unavailable: ["사용 불가", "bad"], rejected: ["거부", "bad"] }, r.status)));
  for (const [name, p] of Object.entries(r.providers || {})) {
    parts.push(el("p", { class: "small" }, `${name}: `, badge(PROVIDER, p.status), ` ${p.code || ""} ${p.status === "ok" ? "" : "— " + (p.message || "")}`));
  }
  const n = r.narrative || {};
  if (n.product) parts.push(el("div", { class: "box" }, el("strong", { text: "제품 " }), n.product));
  if (n.industry) parts.push(el("div", { class: "box" }, el("strong", { text: "산업 " }), n.industry));
  if (n.marketSizing) parts.push(el("div", { class: "box" }, el("strong", { text: "시장 규모 산출 " }), n.marketSizing));
  if (n.competition) parts.push(el("div", { class: "box" }, el("strong", { text: "경쟁 구도 " }), n.competition));
  if (r.status === "single_model") parts.push(el("div", { class: "box warn" }, el("strong", { text: "교차검증 없음: " }), Object.keys(r.providers || {}).length > 1
    ? "한쪽 모델의 로그인/쿼터가 만료되어 나머지 모델의 결과만 사용했습니다. 인용·숫자·날짜의 결정론적 검사는 모두 적용되었습니다."
    : "모델 하나만 선택해 그 모델이 별도 호출로 자체 감사했습니다(독립 교차검증 아님). 인용·숫자·날짜의 결정론적 검사는 모두 적용되었습니다."));
  else if (!r.narrativeReviewed && (n.product || n.industry)) parts.push(el("p", { class: "small", text: "※ 서술은 두 모델의 교차검토를 통과하지 못한 초안입니다." }));
  const d = r.draftDataset;
  if (d) {
    const label = { reviewed: "검토 통과", provisional: "잠정 (소프트 문제만)", rejected: "거부된 원본 초안" }[d.status] || d.status;
    parts.push(el("details", {}, el("summary", { text: `초안 데이터셋 JSON — ${label}${d.serverRepaired ? ", 서버 보정 적용" : ""}` }),
      el("pre", { class: "json", text: JSON.stringify(d.dataset, null, 2) })));
  }
  return section(`모델 검토 (${Object.keys(r.providers || {}).map((p) => MODEL_LABEL[p] || p).join(" + ") || "-"})`, ...parts);
}

function renderReport(rep) {
  if (!rep) return null;
  const parts = [];
  parts.push(el("ul", { class: "plain" }, rep.lines.map((l) => el("li", { text: l }))));
  for (const p of rep.players || []) {
    const o = p.observed;
    const pb = p.projected.base;
    const rows = [];
    const share = (v) => (typeof v === "number" ? `${(v * 100).toFixed(1)}%` : "-");
    rows.push(el("tr", {}, el("td", { text: `회사${o.company.estimated ? " (추정)" : ""}` }), el("td", { text: share(o.company.share) }), el("td", { text: share(pb.company.share) })));
    for (const c of o.competitors) {
      const next = pb.competitors.find((x) => x.name === c.name);
      rows.push(el("tr", {}, el("td", { text: `${c.name}${c.estimated ? " (추정)" : ""}` }), el("td", { text: share(c.share) }), el("td", { text: share(next && next.share) })));
    }
    rows.push(el("tr", {}, el("td", { text: "기타 업체" }), el("td", { text: share(o.others.share) }), el("td", { text: share(pb.others.share) })));
    rows.push(el("tr", {}, el("th", { text: "합계 = 시장 규모" }), el("th", { text: "100%" }), el("th", { text: "100%" })));
    parts.push(el("h3", { text: `업체별 점유 — ${p.marketId} (${p.currency})` }),
      el("div", { class: "tablewrap" }, el("table", {}, el("thead", {}, el("tr", {}, el("th", { text: "" }), el("th", { text: `${o.quarter} (최근 확정)` }), el("th", { text: `${rep.valuation.targetQuarter} 전망 (기본 시나리오)` }))), el("tbody", {}, rows))));
  }
  const q = rep.quality;
  if (q.dataGrounding === "low" || q.dataGrounding === "medium")
    parts.unshift(el("div", { class: q.dataGrounding === "low" ? "box bad" : "box warn" }, el("strong", { text: `데이터 근거 수준: ${q.dataGrounding === "low" ? "낮음" : "보통"} ` }), `매출 입력 ${q.totalInputs}개 중 ${q.estimatedInputs}개가 추정치입니다. 아래 수치는 참고용 추정이며 시나리오 범위가 매우 넓을 수 있습니다.`));
  if (q.estimates && q.estimates.length)
    parts.push(el("details", {}, el("summary", { text: `추정치 ${q.estimates.length}건 (입력의 ${((1 - q.groundedRatio) * 100).toFixed(0)}%)` }),
      el("ul", { class: "plain" }, q.estimates.map((e) => el("li", { text: `${e.path} = ${Math.round(e.value).toLocaleString("ko-KR")} ${e.currency} — ${e.method}${e.review ? ` [감사: ${e.review}]` : ""}: ${e.rationale}` })))));
  return section("분석 보고", ...parts);
}

function renderAnalysis(a, valuation) {
  if (!a) return null;
  const sc = a.scenarios || [];
  const th = el("tr", {}, el("th", { text: "" }), ...sc.map((s) => el("th", { text: { bear: "비관", base: "기본", bull: "낙관" }[s.scenario] || s.scenario })));
  const line = (label, f) => el("tr", {}, el("th", { text: label }), ...sc.map((s) => el("td", { text: f(s) })));
  const v = (s) => s.valuation || {};
  const table = el("div", { class: "tablewrap" }, el("table", {},
    el("thead", {}, th),
    el("tbody", {},
      line("귀속 매출", (s) => big(s.totals && s.totals.revenueKRW)),
      line("영업이익", (s) => big(s.totals && s.totals.operatingProfitKRW)),
      line("보통주 귀속이익", (s) => big(s.totals && s.totals.commonEarningsKRW)),
      line("연간 EPS(PER 적용)", (s) => (v(s).status === "available" ? `${won(v(s).annualizedEpsKRW)}${v(s).epsBasis === "quarter_x4" ? " (분기×4)" : " (최근 3분기 실적+예측)"}` : "-")),
      line("적용 PER", (s) => (v(s).status === "available" ? `${v(s).peMultiple}배` : "-")),
      line("목표가(프록시)", (s) => (v(s).status === "available" ? won(v(s).targetPriceKRW) : "산출 불가")),
      line("현재가 대비", (s) => (v(s).status === "available" ? pct(v(s).upsidePct) : "-")),
    )));
  return section(`가치 계산 — 목표 분기 ${a.targetQuarter || ""}`,
    el("p", { class: "small", text: `현재가 ${won(a.facts && a.facts.quote && a.facts.quote.priceKRW)} 기준 · 밸류에이션 상태: ${valuation ? valuation.status : "-"}` }),
    valuation && valuation.grade === "provisional"
      ? el("div", { class: "box warn" }, el("strong", { text: "잠정 가격: " }), "일부 검증을 통과하지 못했거나 서버가 보정한 입력으로 계산했습니다. 아래 '주의 사항'을 확인하세요.")
      : null,
    table,
    el("p", { class: "small", text: "목표가는 (다음 분기 EPS × 4) × 시나리오 PER 이며 실제 주가 예측이 아닌 밸류에이션 프록시입니다." }),
    (a.dataQuality && a.dataQuality.warnings || []).length ? el("ul", { class: "plain" }, a.dataQuality.warnings.map((w) => el("li", { text: w }))) : null,
    el("details", {}, el("summary", { text: "한계" }), el("ul", { class: "plain" }, (a.limitations || []).map((w) => el("li", { text: w })))));
}

const STRATEGY_STATUS = { eligible: ["적합", "ok"], ineligible: ["부적합", "warn"], estimate_only: ["추정 완료(컨센서스 판정 없음)", "ok"], insufficient_data: ["데이터 부족", "warn"] };
const STRATEGY_MODE = { live: ["실시간(오늘 기준)", "ok"], retrospective_research: ["과거 재현(리서치, 실거래 신호 아님)", "warn"] };

// Readable Korean labels for strategy assumption fieldPaths (e.g. "forecast.quarters[0].segments[0].assumptions",
// "forecast.funding.assumptions") -- these are internal API field paths, not something a non-developer should see.
const FIELD_PATH_LABEL = {
  forecast: "전망", quarters: "분기", segments: "세그먼트", funding: "자금계획", assumptions: "가정",
  revenueKRW: "매출", operatingProfitKRW: "영업이익", commonEarningsKRW: "보통주 귀속이익", epsKRW: "EPS",
  volume: "판매량", price: "단가", share: "점유율",
  currentConsensus: "현재 컨센서스", priorConsensus: "이전 컨센서스", epsPerShare: "주당순이익", horizonQuarters: "전망 기간(분기)",
  catalyst: "촉매", eventAt: "이벤트 시점",
  risk: "자금 위험", investmentPlan: "투자계획", workingCapital: "운전자본", borrowing: "차입금",
};
function humanizeFieldPath(fieldPath) {
  const labels = String(fieldPath || "").split(".").map((raw) => {
    const m = /^(\w+)(?:\[(\d+)\])?$/.exec(raw);
    if (!m) return raw;
    const [, key, idxStr] = m;
    const idx = idxStr !== undefined ? Number(idxStr) + 1 : null;
    if (key === "quarters" && idx) return `${idx}분기`;
    if (key === "segments" && idx) return `세그먼트 ${idx}`;
    const label = FIELD_PATH_LABEL[key] || key;
    return idx ? `${label} ${idx}` : label;
  });
  return labels.join(" · ");
}

function renderAssumption(a) {
  const src = a.source || {};
  const srcNode = src.url ? safeLink(src.url, src.title || src.url) : document.createTextNode(src.title || src.manualReference || "출처 미상");
  return el("li", {},
    el("strong", { text: `${humanizeFieldPath(a.fieldPath)}: ` }), a.rationale,
    el("div", { class: "small" }, "출처: ", srcNode, a.isModelEstimate === false ? " · 공시 재무제표 기반 결정론적 파생 가정(모델 추정 아님)" : " · 모델 추정 · 별도 모델 검토 없음"));
}

function renderStrategyAuto(sa) {
  if (!sa) return null;
  const parts = [];
  parts.push(el("p", {}, "한 분기 실적 추정(단기, 최장 3개월): ", badge(STRATEGY_STATUS, sa.status), " · ", badge(STRATEGY_MODE, sa.mode)));
  parts.push(el("p", { class: "small", text: `생성 시각(전망 추출): ${sa.generatedAt || "없음 — 검증된 전망을 추출하지 못했습니다"} · 판단 시각: ${sa.decisionAt}` }));
  parts.push(el("p", { class: "small", text: `독립 감사: ${sa.independentlyAudited ? "받음" : "받지 않음"}` }));
  if (sa.mode === "retrospective_research")
    parts.push(el("div", { class: "box warn", text: "과거 특정 시점 기준의 재현 분석입니다. 오늘의 실시간 판단이 아니며, 매매 지시나 주문이 아닙니다." }));
  parts.push(el("div", { class: "box warn", text: "모델 추정 · 별도 모델 검토 없음 — 이 자동 신호는 모델이 산출한 추정치이며, 두 번째 모델의 재검증을 받지 않았습니다. 분석 참고용이며 매매 주문이나 지시가 아닙니다." }));
  (sa.notes || []).forEach((n) => parts.push(el("p", { class: "small", text: n })));

  if (sa.bridge) {
    parts.push(el("p", {}, el("strong", { text: `${sa.bridge.quarters.map((q) => q.quarter).join(", ")} 추정 EPS: ` }), won(sa.bridge.ntmEpsKRW)));
    const rows = sa.bridge.quarters.map((q) => el("tr", {}, el("td", { text: q.quarter }), el("td", { text: big(q.revenueKRW) }), el("td", { text: big(q.operatingProfitKRW) }), el("td", { text: won(q.epsKRW) })));
    parts.push(el("div", { class: "tablewrap" }, el("table", {},
      el("thead", {}, el("tr", {}, el("th", { text: "분기" }), el("th", { text: "매출" }), el("th", { text: "영업이익" }), el("th", { text: "보통주 EPS" }))),
      el("tbody", {}, rows))));
  } else {
    parts.push(el("p", { class: "small", text: "한 분기 실적 추정을 만들지 못했습니다." }));
  }

  const np = sa.nextQuarterPrice;
  if (np) {
    parts.push(el("h3", { text: "다음 분기 적정 주가 (PER 유지)" }));
    if (np.status === "available") {
      parts.push(el("p", {}, el("strong", { text: `${np.targetQuarter} 적정 주가: ${won(np.fairPriceKRW)}` }),
        ` · ${np.baseQuarter} 평균 종가 ${won(np.base.averageCloseKRW)} 대비 ${pct(np.changeVsBaseAveragePct)}`,
        np.latestClose ? ` · 최근 종가 ${won(np.latestClose.closeKRW)}(${np.latestClose.date}) 대비 ${pct(np.latestClose.changeToFairPct)}` : ""));
      parts.push(el("p", { class: "small", text: `${np.baseQuarter} PER ${np.impliedPer.toFixed(2)}배 = 평균 종가 ${won(np.base.averageCloseKRW)}(${np.base.tradingDays}거래일) ÷ 최근 4분기 EPS ${won(np.baseTtmEpsKRW)} → ${np.targetQuarter}까지 4분기 EPS ${won(np.targetTtmEpsKRW)} × PER` }));
      const rows = np.ttmComponents.map((c) => el("tr", {}, el("td", { text: c.quarter }), el("td", { text: won(c.epsKRW) }), el("td", { text: c.kind === "forecast" ? "자체 추정" : "실적(네이버)" })));
      parts.push(el("div", { class: "tablewrap" }, el("table", {},
        el("thead", {}, el("tr", {}, ...["분기", "EPS", "구분"].map((text) => el("th", { text })))),
        el("tbody", {}, rows))));
    } else {
      parts.push(el("p", { class: "small", text: "계산할 수 없습니다." }));
      parts.push(el("ul", { class: "plain" }, (np.reasons || []).map((r) => el("li", { text: r.message }))));
    }
    (np.notes || []).forEach((n) => parts.push(el("p", { class: "small", text: n })));
  }

  if ((sa.quarterlyConsensus || []).length) {
    parts.push(el("h3", { text: "분기 컨센서스" }));
    parts.push(el("p", { class: "small", text: "자체 추정과 나란히 보는 참고값입니다. 네이버 증권의 컨센서스 표시값이며, 조회 시점의 스냅샷입니다. EPS는 주식수 산정 기준이 확인되지 않았습니다." }));
    const rows = sa.quarterlyConsensus.map(({ consensus: c }) => el("tr", {},
      el("td", { text: c.quarter }), el("td", { text: big(c.revenueKRW) }), el("td", { text: big(c.operatingProfitKRW) }),
      el("td", { text: big(c.netIncomeKRW) }), el("td", { text: won(c.epsKRW) })));
    parts.push(el("div", { class: "tablewrap" }, el("table", {},
      el("thead", {}, el("tr", {}, ...["대상 분기", "매출", "영업이익", "순이익", "EPS(참고)"].map((text) => el("th", { text })))),
      el("tbody", {}, rows))));
    for (const item of sa.quarterlyConsensus) {
      const c = item.consensus;
      parts.push(el("p", { class: "small" }, `${c.quarter} · 조회 ${c.observedAt} · `, safeLink(c.sourceUrl, "네이버 원자료")));
      parts.push(el("p", { class: "small", text: item.note }));
      for (const [label, diff] of [["매출", item.revenue], ["영업이익", item.operatingProfit]]) {
        if (diff) parts.push(el("p", { class: "small", text: `${c.quarter} ${label}: 자체 전망 ${big(diff.forecastKRW)}, 컨센서스 대비 차이 ${big(diff.differenceKRW)}${diff.differencePct === null ? " (적자·0 기준 비율 미계산)" : ` (${pct(diff.differencePct)})`}` }));
      }
    }
  } else {
    parts.push(el("p", { class: "small", text: "조회 가능한 분기 컨센서스가 없습니다. 과거 기준일에는 현재 스냅샷을 사용하지 않습니다." }));
  }

  if (sa.risk) {
    const b = sa.risk.base;
    parts.push(el("p", {}, el("strong", { text: "자금 상태(기본 시나리오): " }),
      `분기 경계 최저 현금 ${big(b.minimumQuarterBoundaryCashKRW)}, 추가 자금 필요액 ${big(b.peakAdditionalFundingRequiredKRW)}`));
    parts.push(el("p", { class: "small", text: `하방 시나리오: 분기 경계 최저 현금 ${big(sa.risk.stress.minimumQuarterBoundaryCashKRW)}, 추가 자금 필요액 ${big(sa.risk.stress.peakAdditionalFundingRequiredKRW)}` }));
    parts.push(el("p", { class: "small", text: sa.fundingOrigin === "derived_from_filings"
      ? "자금 계획 출처: 모델 자금 계획을 확보하지 못해 수집된 DART 연결 재무제표(재무상태표·현금흐름표 누적액)에서 결정론적으로 파생한 가정입니다. 공시된 미래 계획이 아니며 산식·한계는 아래 '근거로 쓰인 가정'에 있습니다. 분기 중 현금 부족은 계산 범위에 포함되지 않습니다."
      : "공시 자료에 근거한 자금 계획 추정치(모델 작성, 출처 검증)입니다. 분기 중 현금 부족은 계산 범위에 포함되지 않습니다." }));
    const fundingRows = b.quarters.map((q) => el("tr", {}, el("td", { text: q.quarter }),
      ...[q.openingCashKRW, q.capexKRW, q.deltaWorkingCapitalKRW, q.debtPrincipalDueKRW, q.endingCashKRW, q.additionalFundingRequiredKRW].map((n) => el("td", { text: big(n) }))));
    parts.push(el("div", { class: "tablewrap" }, el("table", {},
      el("thead", {}, el("tr", {}, ...["분기", "기초 현금", "설비·무형자산 투자", "운전자본 증가", "차입 상환", "기말 현금", "추가 자금 필요"].map((text) => el("th", { text })))),
      el("tbody", {}, fundingRows))));
    const nr = sa.noRefinancingBound;
    if (nr)
      parts.push(el("p", { class: "small", text: `차환 없음 보수적 경우: 1년 내 만기 차입 ${big(nr.currentDebtKRW)}이 이번 분기에 전액 도래하면(위 표는 4개 분기 균등 도래 가정 ${big(nr.assumedPrincipalDueKRW)}) 기말 현금 기본 ${big(nr.baseEndingCashKRW)}, 하방 ${big(nr.stressEndingCashKRW)}, 추가 자금 필요액 기본 ${big(nr.baseAdditionalFundingRequiredKRW)}, 하방 ${big(nr.stressAdditionalFundingRequiredKRW)}` }));
  } else {
    parts.push(el("p", { class: "small", text: "자금 위험을 계산할 수 있는 검증된 자금 계획을 확보하지 못했습니다." }));
    const fundingReasons = (sa.missing || []).filter((m) => m.field === "funding" || m.code.startsWith("FUNDING_") || m.code === "INVALID_DEBT_SCHEDULE");
    if (fundingReasons.length)
      parts.push(el("ul", { class: "plain" }, fundingReasons.map((m) => el("li", { text: m.message }))));
  }

  if (sa.evaluation && sa.evaluation.eligible) {
    const e = sa.evaluation;
    parts.push(el("p", {}, el("strong", { text: "기대 차이(gap): " }), pct(e.gapPct * 100), " · ", el("strong", { text: "수정률(revision): " }), pct(e.revisionPct * 100), " · ", el("strong", { text: "촉매 " }), `${e.catalyst.daysAhead.toFixed(0)}일 후`));
  } else if (sa.evaluation) {
    parts.push(el("ul", { class: "plain" }, sa.evaluation.reasons.map((r) => el("li", {}, el("strong", { text: `${r.code} ` }), r.message))));
  }

  if ((sa.assumptions || []).length)
    parts.push(el("details", {}, el("summary", { text: `근거로 쓰인 가정 ${sa.assumptions.length}건 (${sa.assumptions.every((a) => a.isModelEstimate !== false) ? "모두 모델 추정치" : "모델 추정치·공시 파생 가정"}, 출처 연결)` }),
      el("ul", { class: "plain" }, sa.assumptions.map(renderAssumption))));

  if ((sa.missing || []).length)
    parts.push(el("details", {}, el("summary", { text: `자동 추출 불가/누락 항목 ${sa.missing.length}건` }),
      el("ul", { class: "plain" }, sa.missing.map((m) => el("li", {}, el("strong", { text: `${m.field} ` }), `[${m.code}] ${m.message}`)))));

  parts.push(el("p", { class: "small", text: "이 섹션은 실적 전망과 투자(자금) 위험에 대한 분석 참고 자료일 뿐이며, 투자 권고나 매매 주문/지시가 아닙니다. 종목/기간/설정에 따라 자동으로 재계산되며, 자금 여력 관련 임계값은 서버에 설정되지 않은 경우 0으로 처리됩니다." }));
  return section("실적 전망·투자 위험", ...parts);
}

function renderJob(job, startedAt) {
  const out = $("out");
  out.hidden = false;
  const title = el("h2");
  const statusBadge = badge(STATUS, job.status);
  const elapsed = el("span");
  const content = el("div");
  const hint = el("p", { class: "hint", text: job.kind === "analysis"
    ? "공시·시세 수집 후 Claude·agy 검토가 이어집니다. 완료되면 결과가 자동으로 표시됩니다."
    : "공개 자료를 수집하는 중입니다. 완료되면 결과가 자동으로 표시됩니다." });
  content.append(hint);
  out.replaceChildren(el("div", { class: "head" }, title, el("span", {}, statusBadge, elapsed)), content);
  const kind = job.kind;
  const ticker = job.request?.ticker || "";
  const setText = (node, text) => { if (node.textContent !== text) node.textContent = text; };

  // Keep the same nodes throughout the job. Only changed status/time text is patched during polling;
  // the result container is populated once when the job reaches a terminal state.
  const update = (job) => {
    const r = job.result || {};
    const [label, color] = STATUS[job.status] || [String(job.status), ""];
    setText(statusBadge, label);
    const badgeClass = `badge ${color}`;
    if (statusBadge.className !== badgeClass) statusBadge.className = badgeClass;
    setText(title, `${r.evidence?.company?.name || ""} ${job.request?.ticker || ticker} · ${(job.kind || kind) === "research" ? "증거 수집" : `전체 분석${job.request?.models?.length ? ` (${job.request.models.map((m) => MODEL_LABEL[m] || m).join(" → ")})` : ""}`}`.trim());
    if (["queued", "running"].includes(job.status)) return;
    const kids = [];
    if (job.error) kids.push(el("div", { class: "box bad" }, el("strong", { text: `${job.error.code}: ` }), job.error.message));
    if (r.note) kids.push(el("p", { class: "hint", text: r.note }));

    const reasons = r.partialReasons || [];
    const blocking = reasons.filter((x) => x.severity !== "warning");
    const warnings = reasons.filter((x) => x.severity === "warning");
    const reasonList = (xs) => el("ul", { class: "plain" }, xs.map((x) => el("li", {}, el("strong", { text: `${x.code} ` }), x.message)));
    if (blocking.length) kids.push(section("가치 산정이 되지 않은 이유", reasonList(blocking)));
    if (warnings.length) kids.push(section("주의 사항 (가격은 산출됨)", reasonList(warnings)));
    (r.notes || []).forEach((n) => kids.push(el("p", { class: "small", text: n })));

    const rep = renderReport(r.report);
    if (rep) kids.push(rep);
    const a = renderAnalysis(r.analysis, r.valuation);
    if (a) kids.push(a);
    for (const x of [renderStrategyAuto(r.strategyAuto), renderResearch(r.research), renderEvidence(r.evidence)]) if (x) kids.push(x);

    const missing = (r.missingInputs || []).filter((m) => m.status !== "available_unverified");
    if (missing.length)
      kids.push(el("details", {}, el("summary", { text: `부족/미검증 입력 ${missing.length}건` }),
        el("ul", { class: "plain" }, missing.map((m) => el("li", { text: `${m.field}${m.status ? ` [${m.status}]` : ""}${m.detail ? `: ${m.detail}` : ""}` })))));
    kids.push(el("p", { class: "small", text: "작업은 서버 메모리에만 보관되며 재시작하면 사라집니다." }));
    content.replaceChildren(...kids);
  };
  // Elapsed time is computed locally every second and frozen once the terminal response has arrived.
  const tick = () => setText(elapsed, ` ${Math.round((Date.now() - startedAt) / 1000)}초`);
  tick();
  const timer = setInterval(tick, 1000);
  const updateAndMaybeStop = (job) => {
    update(job);
    if (!["queued", "running"].includes(job.status)) { tick(); clearInterval(timer); }
  };
  updateAndMaybeStop.stop = () => { tick(); clearInterval(timer); };
  updateAndMaybeStop(job);
  return updateAndMaybeStop;
}

// ---- short-term forecast ----------------------------------------------------------------------------------------

const CONF = { high: ["신뢰도 높음", "ok"], medium: ["신뢰도 보통", "warn"], low: ["신뢰도 낮음 (검증된 우위 없음)", "bad"] };
const rate = (v) => (typeof v === "number" && Number.isFinite(v) ? `${(v * 100).toFixed(1)}%` : "-");
function renderForecast(r) {
  const rows = r.horizons.map((h) => {
    const up = h.direction === "up";
    const b = h.backtest;
    return el("tr", {},
      el("td", { text: `${h.horizon}거래일 후` }),
      el("td", {}, el("strong", { text: up ? "▲ 상승" : "▼ 하락" }), ` ${rate(up ? h.probabilityUp : 1 - h.probabilityUp)}`),
      el("td", { text: `${pct(h.expectedReturnPct)} (${won(h.expectedPriceKRW)})` }),
      el("td", { text: `${pct(h.range80Pct[0])} ~ ${pct(h.range80Pct[1])}` }),
      el("td", {}, badge(CONF, h.confidence)),
      el("td", { text: `${rate(b.accuracy)} (n=${b.n}; 항상상승 ${rate(b.alwaysUpAccuracy)}, 모멘텀 ${rate(b.momentumAccuracy)}; 확신 상위30% ${rate(b.confidentAccuracy)})` }));
  });
  return el("div", {},
    el("h2", { text: `${r.ticker} 단기 주가 예측` }),
    el("p", { class: "small", text: `기준일 ${r.asOfDate} 종가 ${won(r.lastCloseKRW)} · 학습 종목 ${r.trainedOn.tickers.length}개 · 표본 ${r.trainedOn.samples.toLocaleString("ko-KR")}개` }),
    el("table", {},
      el("thead", {}, el("tr", {}, ...["기간", "방향·확률", "예상 등락(가격)", "80% 범위", "신뢰도", "백테스트 적중률"].map((t) => el("th", { text: t })))),
      el("tbody", {}, ...rows)),
    el("ul", { class: "small" }, ...r.notes.map((n) => el("li", { text: n }))),
    el("p", { class: "small", text: "확률은 과거 표본 외(out-of-sample) 예측으로 보정한 값입니다. 백테스트에서 단순 기준(항상 상승·모멘텀)을 유의하게 넘지 못하면 신뢰도 '낮음'이며, 그 방향은 동전 던지기와 다르지 않습니다. 투자 권고가 아닙니다." }));
}

// ---- run ----------------------------------------------------------------------------------------------------------

// The model choice only applies to a full analysis.
$("form").addEventListener("change", (e) => {
  if (e.target && e.target.name === "mode") $("models").disabled = e.target.value !== "analysis";
});

let running = false;
// Long-poll: the server holds each status request until the job finishes or this many seconds pass, so the result
// shows up as soon as it exists without fixed-interval polling.
const JOB_WAIT_SECONDS = 55;
$("form").addEventListener("submit", async (ev) => {
  ev.preventDefault();
  if (running) return;
  const ticker = $("ticker").value.trim().toUpperCase();
  if (!/^[0-9][0-9A-Z]{5}$/.test(ticker)) { $("ticker").focus(); return; }
  const mode = new FormData($("form")).get("mode");
  const body = { ticker };
  const models = $("models").value.split(",").filter(Boolean);
  if (apiKeyRequired) { try { sessionStorage.setItem("yyKey", $("apiKey").value); } catch { /* storage unavailable */ } }

  running = true;
  $("go").disabled = true;
  const startedAt = Date.now();
  const out = $("out");
  let updateJob = null;
  try {
    if (mode === "forecast") {
      out.hidden = false;
      out.replaceChildren(el("p", { class: "small", text: "시세 이력을 내려받아 학습·백테스트하는 중입니다 (동종 대형주 20개 포함, 30초~1분)…" }));
      out.replaceChildren(renderForecast(await api(`/v1/forecast/${ticker}`, { headers: headers() })));
      return;
    }
    const started = await api(mode === "research" ? "/v1/research" : "/v1/analyses", { method: "POST", headers: headers(), body: JSON.stringify(mode === "research" ? body : { ...body, mode: "public", models }) });
    out.hidden = false;
    // Render once while waiting. Status updates must not replace the DOM (or reset selection/expanded details).
    updateJob = renderJob({ ...started, status: started.status || "queued", kind: mode === "research" ? "research" : "analysis", request: mode === "research" ? body : { ...body, models } }, startedAt);
    // No client-side ceiling: the server owns job lifetime (per-call/whole-job timeouts), so this follows
    // queued/running through to whatever terminal status (completed/partial/failed) the server eventually reports.
    // A job that disappears (evicted after its retention TTL) surfaces as a normal JOB_NOT_FOUND error below.
    for (;;) {
      const job = await api(`${started.statusUrl}?wait=${JOB_WAIT_SECONDS}`, { headers: headers() });
      updateJob(job);
      if (!["queued", "running"].includes(job.status)) break;
    }
  } catch (e) {
    updateJob?.stop();
    out.hidden = false;
    out.replaceChildren(el("div", { class: "box bad" }, el("strong", { text: `${e.code || "ERROR"}: ` }), e.message, e.hint ? el("div", { class: "small", text: e.hint }) : null));
  } finally {
    running = false;
    $("go").disabled = false;
  }
});

(async function init() {
  try {
    const h = await api("/health");
    apiKeyRequired = !!h.apiKeyRequired;
    $("keyRow").hidden = !apiKeyRequired;
    if (apiKeyRequired) { try { $("apiKey").value = sessionStorage.getItem("yyKey") || ""; } catch { /* ignore */ } }
    // Preselect the server's default models (INTELLIGENCE_MODELS) when it is one of the listed choices.
    const def = Array.isArray(h.defaultModels) ? h.defaultModels.join(",") : "";
    if (def && Array.from($("models").options || []).some((o) => o.value === def)) $("models").value = def;
  } catch { /* health unavailable: keep defaults */ }
  loadUniverse();
})();
