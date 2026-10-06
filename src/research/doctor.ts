import { tmpdir } from "node:os";
import path from "node:path";
import { checkReadiness } from "../intelligence/index.js";
import { buildEnv, sanitize, spawnRunner } from "../intelligence/runner.js";
import type { Runner } from "../intelligence/types.js";
import { defaultAgyPath } from "../config.js";

export type DoctorItem = { name: string; status: "ok" | "warn" | "fail"; detail: string };
/** ok = nothing is broken (no ✘). readiness = what can actually run: evidence-only jobs, a full analysis with at least one usable model, and the cross-checked dual-model analysis. */
export type DoctorReport = { ok: boolean; readiness: { evidence: boolean; fullAnalysis: boolean; dualModel: boolean }; items: DoctorItem[] };

// Paid/alternative model auth routes. They are NEVER forwarded to the CLI (see intelligence/runner.ts env allowlist),
// so they cannot cause paid usage; the doctor only names them (never prints values).
const PAID_ENV = ["OPENAI_API_KEY", "GOOGLE_API_KEY", "GOOGLE_GENAI_USE_VERTEXAI", "GOOGLE_CLOUD_PROJECT", "GOOGLE_APPLICATION_CREDENTIALS"];

/**
 * Presence/config diagnostics. It never sends a model prompt (no quota use) and never prints secret values:
 * only `--version` and `claude auth status`-style probes are run, credential files are only stat()'d.
 */
export async function runDoctor(opts: { env?: NodeJS.ProcessEnv; runner?: Runner; home?: string } = {}): Promise<DoctorReport> {
  const env = opts.env ?? process.env;
  const runner = opts.runner ?? spawnRunner;
  const home = opts.home ?? env.HOME ?? "";
  const items: DoctorItem[] = [];
  const add = (name: string, status: DoctorItem["status"], detail: string) => items.push({ name, status, detail });

  const major = Number(process.versions.node.split(".")[0]);
  add("node", major >= 22 ? "ok" : "fail", `Node.js ${process.versions.node} (>=22 required)`);

  const agyPath = env.INTELLIGENCE_AGY_PATH || defaultAgyPath(home);
  const readiness = await checkReadiness({ runner, env, agyPath, claudePath: env.INTELLIGENCE_CLAUDE_PATH || undefined, codexPath: env.INTELLIGENCE_CODEX_PATH || undefined });

  if (readiness.claude.available) add("claude-cli", "ok", `${readiness.claude.command} ${readiness.claude.version ?? ""}`.trim());
  else add("claude-cli", "warn", `${readiness.claude.error ?? "not runnable"} — install Claude Code and log in (analysis can still run with agy alone)`);

  let claudeLoggedIn = false;
  if (readiness.claude.available) {
    try {
      const r = await runner({ command: readiness.claude.command, args: ["auth", "status"], stdin: "", env: buildEnv(env), cwd: tmpdir(), timeoutMs: 15_000, maxStdoutBytes: 20_000 });
      // Exit 0 alone is not proof of a login: read the JSON `loggedIn` flag (only that boolean is used, nothing echoed).
      let loggedIn: boolean | undefined;
      try {
        loggedIn = (JSON.parse(r.stdout) as { loggedIn?: unknown }).loggedIn === true;
      } catch {
        loggedIn = undefined;
      }
      claudeLoggedIn = !r.spawnError && loggedIn === true;
      if (claudeLoggedIn) add("claude-login", "ok", "`claude auth status` reports loggedIn=true");
      else if (loggedIn === false) add("claude-login", "warn", "`claude auth status` reports loggedIn=false; run `claude` once to log in");
      else add("claude-login", "warn", "could not confirm a Claude login (`claude auth status` gave no parsable loggedIn flag); run `claude` once to log in");
    } catch (e) {
      add("claude-login", "warn", `login probe failed: ${sanitize(String((e as Error)?.message ?? e), home)}`);
    }
  }

  let agyLoggedIn = false;
  if (readiness.agy.available) {
    add("agy-cli", "ok", `${readiness.agy.command} ${readiness.agy.version ?? ""}`.trim());
    // `agy models` lists the account's models: it needs the login but sends no prompt (no model quota is used).
    try {
      const r = await runner({ command: readiness.agy.command, args: ["models"], stdin: "", env: buildEnv(env), cwd: tmpdir(), timeoutMs: 20_000, maxStdoutBytes: 20_000 });
      agyLoggedIn = !r.spawnError && !r.timedOut && r.exitCode === 0 && r.stdout.split("\n").some((l) => l.includes("\t"));
    } catch {
      agyLoggedIn = false;
    }
    add("agy-login", agyLoggedIn ? "ok" : "warn", agyLoggedIn ? "`agy models` lists models for the signed-in account (no prompt sent). Quota is only known at first use; an expired quota is skipped automatically." : "could not confirm an agy login (`agy models` returned no models); run `npm run agy:login` and sign in with Google");
  } else add("agy-cli", "warn", `${readiness.agy.error ?? "not runnable"} — install: curl -fsSL https://antigravity.google/cli/install.sh | bash, or set INTELLIGENCE_AGY_PATH (analysis can still run with Claude alone)`);

  let codexLoggedIn = false;
  if (readiness.codex.available) {
    add("codex-cli", "ok", `${readiness.codex.command} ${readiness.codex.version ?? ""}`.trim());
    // `codex login status` reads the stored credentials only (no prompt, no quota). Exit 0 = logged in.
    try {
      const r = await runner({ command: readiness.codex.command, args: ["login", "status"], stdin: "", env: buildEnv(env), cwd: tmpdir(), timeoutMs: 15_000, maxStdoutBytes: 20_000 });
      codexLoggedIn = !r.spawnError && !r.timedOut && r.exitCode === 0 && !/not logged in/i.test(`${r.stdout}\n${r.stderr}`);
    } catch {
      codexLoggedIn = false;
    }
    add("codex-login", codexLoggedIn ? "ok" : "warn", codexLoggedIn ? "`codex login status` reports a login (no prompt sent)" : "could not confirm a Codex login; run `codex login` and sign in with your ChatGPT account (OPENAI_API_KEY is never used)");
  } else add("codex-cli", "warn", `${readiness.codex.error ?? "not runnable"} — optional: npm i -g @openai/codex, or set INTELLIGENCE_CODEX_PATH (needed only to analyse with Codex)`);

  if (!readiness.ready) add("model-cli", "fail", "none of the Claude, Codex or agy CLIs is runnable: no model analysis is possible (evidence-only jobs still work)");

  const paid = PAID_ENV.filter((k) => env[k]);
  add("paid-env", paid.length ? "warn" : "ok", paid.length ? `${paid.join(", ")} set in the environment — ignored: never forwarded to the Claude/agy CLI, so no paid fallback` : "no paid-route variables set");
  add("anthropic-api-key", env.ANTHROPIC_API_KEY ? "warn" : "ok", env.ANTHROPIC_API_KEY ? "ANTHROPIC_API_KEY is set but never forwarded to the Claude CLI" : "not set");

  add("dart-key", env.DART_API_KEY?.trim() ? "ok" : "warn", env.DART_API_KEY?.trim() ? "DART_API_KEY configured (value hidden)" : "DART_API_KEY not set: Naver quote/news still work, but filings/statements are skipped and no valuation can be produced");
  add("naver-search", env.NAVER_CLIENT_ID?.trim() && env.NAVER_CLIENT_SECRET?.trim() ? "ok" : "warn", env.NAVER_CLIENT_ID?.trim() && env.NAVER_CLIENT_SECRET?.trim() ? "Naver Open API search configured (values hidden)" : "optional NAVER_CLIENT_ID/NAVER_CLIENT_SECRET not set: product-market news search skipped");
  add("api-key", env.API_KEY ? "ok" : "warn", env.API_KEY ? "API_KEY set: mutations and public jobs require x-api-key" : "API_KEY not set: fine on localhost; required if HOST is not loopback");

  const dartKey = !!env.DART_API_KEY?.trim();
  const evidence = dartKey; // Naver quote/news need no key; filings/statements (needed for any valuation) need DART
  const claudeOk = readiness.claude.available && claudeLoggedIn;
  const agyOk = readiness.agy.available && agyLoggedIn;
  const codexOk = readiness.codex.available && codexLoggedIn;
  const usable = [claudeOk && "Claude", codexOk && "Codex", agyOk && "agy"].filter((x): x is string => !!x);
  const dualModel = evidence && usable.length >= 2;
  const fullAnalysis = evidence && usable.length >= 1; // one usable model is enough (no cross-check)
  add("ready-evidence", evidence ? "ok" : "warn", evidence ? "evidence collection (POST /v1/research) is fully configured" : "evidence collection runs with Naver only; set DART_API_KEY for filings/statements");
  add(
    "ready-analysis",
    dualModel ? "ok" : "warn",
    dualModel
      ? `full analysis (POST /v1/analyses) is ready with ${usable.join(", ")}; any two of them can cross-check`
      : fullAnalysis
        ? `analysis runs with ${usable[0]} only (no cross-check possible)`
        : `full analysis not ready: ${[!dartKey && "DART key", !claudeOk && !codexOk && !agyOk && "a model CLI with a login (Claude, Codex: codex login, or agy: npm run agy:login)"].filter(Boolean).join(", ")}`,
  );
  return { ok: !items.some((i) => i.status === "fail"), readiness: { evidence, fullAnalysis, dualModel }, items };
}

export function formatDoctor(r: DoctorReport): string {
  const icon = { ok: "✔", warn: "!", fail: "✘" } as const;
  return [...r.items.map((i) => `${icon[i.status]} ${i.name.padEnd(18)} ${i.detail}`), "", `증거 수집: ${r.readiness.evidence ? "준비됨" : "DART 키 필요"} / 전체 분석: ${r.readiness.dualModel ? "두 모델 교차검증 가능 (쿼터는 호출 시 확인, 만료되면 자동 제외)" : r.readiness.fullAnalysis ? "단일 모델만 가능(교차검증 없음)" : "미준비 (위 ! 항목 조치)"}`, r.ok ? "" : "설치/구성 실패: 위 ✘ 항목을 해결하세요"].join("\n");
}
