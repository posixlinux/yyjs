# Runtime intelligence (Claude CLI + agy / Antigravity CLI)

`src/intelligence/**` turns supplied public documents (filings/news) into a *proposed* `Dataset` plus Korean product/industry
narrative. Two local CLIs cooperate; `agy` is the Google Antigravity CLI (Gemini models):

1. **Claude** (`claude -p`) drafts: `dataset | null`, `missingFields`, narrative, citations, explicit assumptions.
2. **agy** (`agy --print=… --output-format json`, Google login) independently audits the same documents + the draft, confirming or
   rejecting every observed number.
3. Deterministic code verifies citations and numbers (below). Any failure => `dataset: null`, partial research is still returned.

**Expired providers are skipped, not failed.** A provider whose login/quota has expired (`QUOTA`, `AUTH_REQUIRED`) or whose CLI is
missing (`CLI_NOT_FOUND`) is not used any more for a cooldown (`availability.ts`: the CLI's own "Resets in 17h9m35s" hint, else 30 min for
quota / 5 min for login problems; clamped to 1 min..24 h). Effects:

| situation | result |
|---|---|
| both ok | `accepted` (`crossChecked: true`) when the audit approves and every observed number is confirmed |
| agy expired | Claude drafts, then **audits its own draft in a separate call** (adversarial prompt): `single_model` (`crossChecked: false`, `audit.independentAudit: false`) if every check passes |
| Claude expired | agy drafts (same draft prompt), then self-audits: `single_model` |
| the self-audit call also expires | deterministic checks only: `single_model`, `audit.auditedBy: null` |
| both expired | `unavailable`, `dataset: null` |
| one-off failure (`TIMEOUT`, `BAD_JSON`, `SCHEMA_INVALID`, `TOOL_USE_DETECTED`, `OUTPUT_LIMIT`, disagreement…) | not an expiry: no cooldown, no takeover, `partial` |

**Estimates.** The draft may INFER market size, product revenue and competitor revenue (`estimate: {method, basedOn, rationale}`, source
`MODEL_ESTIMATE: …`). Such figures need no citation but must pass the estimate rules in `verify.ts` (`ESTIMATE_MISSING`, `ESTIMATE_NOT_LABELLED`,
`ESTIMATE_WITHOUT_BASIS`, `ESTIMATE_BASIS_UNKNOWN`, `ESTIMATE_BASIS_MISMATCH`, `ESTIMATE_SELF_REFERENCE`, `MODEL_ESTIMATE_ON_OBSERVED_FIELD`), the auditor
returns `estimateReviews[]` (`unreasonable` blocks the dataset), and `AnalysisResult.estimates[]` lists them with their review. Price, share count, FX and
company revenue can never be estimates. Competitors (`competitors[]`) and the company + competitors + others = market identity are handled by
`src/domain/market-structure.ts` and `src/model/model.ts` (see README, "추정치와 경쟁사 합계").

`AnalysisResult.unavailable[]` names each skipped provider with `code`, sanitized `message`, `retryAfter` (ISO) and `skippedWithoutCall`.
Results with an expired provider are never cached.

## Integration API

```ts
import { analyzeEvidence, checkReadiness, intelligenceOptionsFromEnv, clearIntelligenceCache } from "./intelligence/index.js";

const result = await analyzeEvidence(
  { ticker: "005930", asOf: "2026-06-30",
    documents: [{ id: "d1", title, url, publishedAt: "2026-05-15", text }] },   // <= 30 docs, 100k chars each, 300k total
  options?,                                                                     // IntelligenceOptions, all optional
);
const ready = await checkReadiness(options?);   // `<cli> --version` only: {ready (one CLI runnable), dual (both), claude, agy}; not login or quota

// Cancellation (HTTP shutdown / client disconnect): pass any AbortSignal.
const ac = new AbortController();
server.addHook("onClose", async () => ac.abort(new Error("server closing")));
await analyzeEvidence(input, { signal: ac.signal });      // rejects with signal.reason once aborted
```

`AnalysisResult`:

| field | meaning |
|---|---|
| `status` | `accepted` (both providers approved, verified dataset) · `single_model` (verified dataset, only one provider usable: audited by itself in a separate call or by the deterministic checks only, **not cross-checked**) · `partial` (a draft exists, dataset withheld) · `unavailable` (no draft / no eligible documents) |
| `crossChecked`, `unavailable[]` | whether both providers ran; expired providers that were skipped (see above) |
| `dataset` | `Dataset \| null`. Passed `DatasetSchema` + this module's grounding checks only. **Caller must still run `src/domain/validate.ts`** (temporal/coverage). Never synthetic. Null means: no valuation / target price |
| `missingFields`, `narrative` (`{product, industry}` Korean, unreviewed unless `accepted`), `assumptions`, `citations` (verified only) | partial research |
| `disagreements` | auditor disagreements + every non-`confirmed` claim |
| `providers.{claude,agy}` | `{status: ok/error/skipped, code, message (sanitized), durationMs}`; codes: `CLI_NOT_FOUND TIMEOUT OUTPUT_LIMIT AUTH_REQUIRED QUOTA CONFIG_ERROR ABORTED EXIT_NONZERO BAD_ENVELOPE BAD_JSON SCHEMA_INVALID TOOL_USE_DETECTED SKIPPED` |
| `audit` | `issues[]` (`{code,path,message}` — every reason the dataset was withheld), `excludedDocuments` (dated after `asOf`, never sent to models), `auditSummary`, `limitations` |

Provider problems never throw. `AppError` is thrown only for bad input: `400 INTELLIGENCE_INPUT_INVALID`, `413 INTELLIGENCE_INPUT_TOO_LARGE`.
The only other rejection is cancellation: `signal.reason` (an `AbortError` if you abort without a reason).
Suggested HTTP mapping: return the result as-is; treat `dataset === null` as "no prediction".

### Cancellation (`AbortSignal`)

* `IntelligenceOptions.signal` and `RunRequest.signal` (custom runners must honour it and resolve `{aborted: true}`; the built-in `spawnRunner` does).
* Abort while a CLI runs: the child's process group gets SIGTERM, then SIGKILL after 2 s; its temp dir is removed after it exits.
  Abort while queued behind `maxConcurrent`: no child is ever started. An already-aborted signal rejects before any work.
* Identical concurrent requests share one run. That shared run is cancelled only when **every** waiting caller has aborted; one caller
  aborting just rejects that caller. Cancelled/aborted results are never cached (`providers.*.code = ABORTED`).
* `checkReadiness({signal})` cancels its `--version` probes the same way.

### Preferred-share schema

The prompt follows the current `DatasetSchema`: `earningsBridge.value.preferredClaimsKRW` is the total next-quarter earnings allocated to
preferred classes (dividends **and** participation), `earningsBridge` needs a `rationale`, and the model is told it must not derive capital-class
rights itself. `preferredDividendsKRW` no longer appears anywhere in this module.

### Options / server configuration (never request-controlled)

| option | env (`intelligenceOptionsFromEnv`) | default |
|---|---|---|
| `claudePath` | `INTELLIGENCE_CLAUDE_PATH` | `claude` (via PATH) |
| `agyPath` | `INTELLIGENCE_AGY_PATH` | `~/.local/bin/agy` if present, else `agy` on PATH |
| `claudeModel` / `agyModel` | `INTELLIGENCE_CLAUDE_MODEL` / `INTELLIGENCE_AGY_MODEL` | Claude CLI default / `gemini-3.8-flash-high` (`agy models` lists the account's models) |
| `timeoutMs` | `INTELLIGENCE_TIMEOUT_MS` | 300000 per CLI call |
| `maxConcurrent` | `INTELLIGENCE_MAX_CONCURRENT` | 4 CLI processes process-wide (audit + separate strategy call in parallel, × 2 running jobs) |
| `cache`, `cacheTtlMs` | – | on, 15 min (successes only; provider errors are never cached) |
| `runner`, `env`, `now` | – | real spawn, `process.env`, `new Date()` (tests inject) |
| `signal` | – | none |

`analyzeEvidence(input, options)` merges `options` over the env config. Cache, in-flight de-duplication (identical input+config
share one run) and the semaphore are process-wide.

### Dependencies

None added. Uses `zod` (already installed; `z.toJSONSchema` embeds `DatasetSchema` in the prompt), `node:*`, and the existing
`src/domain/{schema,time}.ts`, `src/errors.ts`. Runtime needs at least one of the two CLIs; tests need nothing external (mock runner + a few
real `node` child processes for the spawn tests). Tests live in `tests/intelligence.test.ts` (vitest default glob picks it up).

## Isolation

* `spawn(..., {shell:false})`, args are constants (+ optional `--model`). Children run in a fresh empty temp dir removed afterwards; on timeout
  (default 300 s) or stdout > 2 MB the whole process group gets SIGTERM then SIGKILL.
* Env is an allowlist (PATH, HOME, locale, tmp, XDG, proxies, CA certs, `CLAUDE_CONFIG_DIR`). DART/Naver keys, `ANTHROPIC_API_KEY`,
  `GOOGLE_API_KEY`, Google/Vertex project vars are **not** passed: no paid API-key fallback. HOME is unchanged so CLI logins work.
* Claude: prompt on **stdin**; `--safe-mode --tools "" --strict-mcp-config --mcp-config '{"mcpServers":{}}' --no-session-persistence --output-format json -p`;
  a non-empty `permission_denials` discards the result. An `is_error` envelope whose text says quota/limit/login is classified as expiry.
* agy (1.2.12; behaviour observed against the real binary):
  * `agy --print=<prompt> --output-format json --disable-slash-commands --print-timeout <n>s --model <m>`. agy does **not** read the prompt from stdin
    (`-p -` and stdin were tried), so the prompt is one argv element attached with `=` (never parsed as a flag) and is limited to 900,000 bytes
    (macOS `ARG_MAX` is 1 MiB for argv + environment; Linux limits a single argument to 128 KiB, so large prompts need macOS or a different transport).
  * No `--dangerously-skip-permissions`: headless agy auto-denies every tool that needs confirmation and lists them in `denied_actions`; a non-empty list
    discards the result (`TOOL_USE_DETECTED`). The cwd is an empty temp dir.
  * The envelope is `{status: "SUCCESS"|"ERROR", response, error?, denied_actions?, usage}` and **the exit code is 0 even for API errors**, so quota
    (`RESOURCE_EXHAUSTED`/429, with "Resets in …") and login problems are read from the envelope. agy keeps retrying a quota error for ~45 s and only exits at
    `--print-timeout` (+~5 s), so that deadline is set 20 s before our kill timer; if the kill timer fires anyway, a quota/login envelope already printed is
    still honoured.
  * Login: there is no login command and no credential file to check on macOS (the token is in the Keychain, "Antigravity Safe Storage"). Sign in once with
    `npm run agy:login`; an expired login/quota is detected when a call fails. `npm run doctor` runs `agy models` (needs the login, sends no prompt).
* Untrusted text: documents and the draft are embedded as JSON inside `<evidence>`/`<draft>`, and the prompt says to treat them as data.

## Verification rules (`verify.ts`)

* Citation: `documentId` must be a supplied document, `url` and `publishedAt` equal it, doc not after `asOf`, `evidenceQuote` occurs verbatim in its text.
* Dataset sources: `url` must be a supplied document with the same `publishedAt` (≤ `asOf`). `manualReference: "MODEL_ASSUMPTION: …"` is allowed
  only on assumption fields (`annualGrowth, seasonality, cyclical, shareDelta, operatingMargin, residual, earningsBridge, peMultiple`) and only with a `rationale`.
* Every observed number (`quote.priceKRW`, `shares.dilutedCommon`, `fx[i].krwPerUnit`, `financials.totalRevenueKRW`, market `observations[j].revenue`,
  product `revenue[j].revenue`) needs a citation on its exact path, from the same URL as the field's `source`, whose `quotedNumber` stands alone in the quote and
  satisfies `value = quotedNumber × multiplier`. The multiplier must be exactly the unit written **directly after that number** in the quote
  (optional whitespace): 천=1e3, 만=1e4, 백만=1e6, 억=1e8, 십억=1e9, 조=1e12, thousand/million/billion/trillion; no unit means 1. The whole
  run of Korean numeral characters must match one token, so `5백만` is 1e6 and can never be justified as `만` (1e4), and unlisted compounds
  (`천만`, `백억`, `1조 2,345억`) match nothing and fail closed. A trailing non-scale word (`원`, `won`, `주`) adds no unit.
  Otherwise the dataset is withheld (fail closed). Also rejected: `synthetic`, ticker mismatch, dates after `asOf`, non-quarterly observations, dataset + `missingFields`.
* The auditor must set `approved`, list no disagreements/missing fields, and mark every observed path `confirmed` (skipped when the auditor is expired: `single_model`).

## Honest limitations

* Exact matching proves a quote exists and a number is arithmetically derivable from it — **not** that it is the right number (wrong quarter, segment,
  consolidated vs. separate). That semantic check is only the second model's audit, itself an LLM (and absent in `single_model` results). Human review remains necessary.
* Compound amounts ("1조 2,345억") are not parsed; the model must cite a single-number quote, else the dataset is withheld.
* Logins/quotas are the operator's own (Claude subscription, Google account for agy); there is no paid fallback. agy's personal quota can be exhausted for many hours
  (observed: "Resets in 17h").
* Verified against the real binaries: Claude draft call; agy envelope parsing for quota errors (`RESOURCE_EXHAUSTED`, "Resets in …"), the `--print=` argument form, a 900 KB argument,
  and the `denied_actions` field (seen when a Claude model behind agy asked to run a command). **Not verified:** a successful audit by a Gemini model through agy — the account's Gemini
  quota was exhausted during development, so that path is covered by mock-runner tests only.
* Two sequential CLI calls per analysis (up to 2 × 300 s; the first call that discovers an expired agy quota costs ~50–100 s, later ones none until the cooldown ends). Callers should treat this as a slow, background-style operation.
