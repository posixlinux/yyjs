import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { z } from "zod";
import { parseResetMs } from "./availability.js";
import { buildEnv, sanitize } from "./runner.js";
import { CLAUDE_EFFORT_LEVELS, DEFAULT_CLAUDE_EFFORT, LIMITS, type ClaudeEffort, type ProviderName, type ProviderStatus, type RunResult, type Runner } from "./types.js";

export type ProviderConfig = {
  command: string;
  model?: string;
  /** Claude Code --effort level (low/medium/high/xhigh/max). Default "high". */
  effort?: string;
  timeoutMs: number;
  runner: Runner;
  env: NodeJS.ProcessEnv;
  signal?: AbortSignal;
};

export type ProviderOutcome<T> = { status: ProviderStatus; value?: T; /** how long an expired provider should be skipped (from the CLI's own reset hint) */ cooldownMs?: number };

// ---- Claude ---------------------------------------------------------------------------------------------------

/** Claude Code: no tools, no MCP, no hooks/plugins/CLAUDE.md (safe-mode), no session files. Prompt is on stdin.
 * `--effort` controls how long Claude Code reasons before producing output; default "medium" is enough for this
 * structured extraction task. Override with INTELLIGENCE_CLAUDE_EFFORT env (validated: see validateClaudeEffort). */
export const claudeArgs = (model?: string, effort?: string): string[] => [
  "--safe-mode",
  "--tools",
  "",
  "--strict-mcp-config",
  "--mcp-config",
  '{"mcpServers":{}}',
  "--no-session-persistence",
  "--output-format",
  "json",
  "--effort",
  effort || DEFAULT_CLAUDE_EFFORT,
  ...(model ? ["--model", model] : []),
  "-p",
];

/** Validates INTELLIGENCE_CLAUDE_EFFORT / IntelligenceOptions.claudeEffort against the levels Claude Code accepts;
 * an unset or unrecognised value is diagnosed (sanitized, never thrown -- a bad env value must not fail every
 * analysis) and replaced with DEFAULT_CLAUDE_EFFORT. */
export const validateClaudeEffort = (v: string | undefined): ClaudeEffort => {
  if (v === undefined || v === "") return DEFAULT_CLAUDE_EFFORT;
  if ((CLAUDE_EFFORT_LEVELS as readonly string[]).includes(v)) return v as ClaudeEffort;
  console.warn(
    `[intel] DIAGNOSTIC: INTELLIGENCE_CLAUDE_EFFORT=${JSON.stringify(sanitize(v, undefined, 40))} is not one of ` +
    `${CLAUDE_EFFORT_LEVELS.join("/")}; falling back to "${DEFAULT_CLAUDE_EFFORT}".`,
  );
  return DEFAULT_CLAUDE_EFFORT;
};

// ---- Antigravity CLI (agy) ------------------------------------------------------------------------------------
//
// Headless use of `agy`: `agy --print=<prompt> --output-format json`, which prints ONE
// JSON envelope {status:"SUCCESS"|"ERROR", response, error?, denied_actions?, ...} and exits 0 even on API errors, so
// the envelope (not the exit code) carries quota/login problems. There is no separate login command: the operator
// signs in once by starting `agy` interactively (`npm run agy:login`); the token lives in the OS keyring, so a login
// cannot be checked cheaply from here and is detected when a call fails.
//
// Isolation: an empty throwaway cwd, no --dangerously-skip-permissions (headless mode auto-denies every tool that
// needs confirmation and reports it in `denied_actions`, which we treat as a violation), slash commands disabled, and
// an environment allowlist without any API key. The prompt travels as one argv element (agy does not read it from
// stdin), so it is size-bounded below the OS argument limit.

/** Independent Gemini-family model for the audit/draft role; override with INTELLIGENCE_AGY_MODEL (see `agy models`). */
export const AGY_DEFAULT_MODEL = "gemini-3.8-flash-high";
/** macOS ARG_MAX is 1 MiB for argv+environment; stay well below it. */
export const MAX_ARGV_PROMPT_BYTES = 900_000;

export const agyArgs = (prompt: string, timeoutMs: number, model?: string): string[] => [
  `--print=${prompt}`, // attached with "=": a prompt can never be mistaken for a flag
  "--output-format",
  "json",
  "--disable-slash-commands",
  // agy keeps running until ITS deadline even after an API error (a quota error is reported after ~45 s of retries, the
  // process exits only at --print-timeout + ~5 s), so that deadline must be clearly earlier than our kill timer:
  // otherwise the kill wins and the error envelope (which says "quota") is lost.
  "--print-timeout",
  `${Math.max(10, Math.floor(timeoutMs / 1000) - 20)}s`,
  "--model",
  model || AGY_DEFAULT_MODEL,
];

// ---- envelope handling --------------------------------------------------------------------------------------

const status = (provider: ProviderName, code: string, message: string, t0: number, st: ProviderStatus["status"] = "error"): ProviderOutcome<never> => ({
  status: { provider, status: st, code, message, durationMs: Date.now() - t0 },
});
const fail = (provider: ProviderName, code: string, message: string, t0: number) => status(provider, code, message, t0);

const AUTH_RE = /log ?in|sign ?in|not authenticated|unauthenticated|authenticat|auth method|oauth|credential|api key|401|403/i;
// "hit your (session|weekly|daily|...) limit" covers observed phrasing such as "You've hit your session limit ·
// resets 2:20pm" as well as the bare "hit your limit"; kept alongside the other known quota/rate-limit phrasings.
const QUOTA_RE = /quota|rate.?limit|429|resource.?exhausted|too many requests|usage limit|limit reached|hit your (?:\w+\s+)?limit|session limit|weekly limit|credit balance|out of (?:extra )?usage/i;

/** Best human-readable reason from stderr/stdout: prefer the CLI's JSON {"error":{"message"}} form. */
const errorDetail = (r: RunResult): string => {
  const raw = (r.stderr || r.stdout).trim();
  try {
    const j = JSON.parse(raw) as { error?: { message?: unknown } | string };
    const m = typeof j.error === "string" ? j.error : j.error?.message;
    if (typeof m === "string") return sanitize(m);
  } catch {
    /* not JSON */
  }
  return sanitize(raw);
};

const classify = (provider: ProviderName, r: RunResult, command: string, t0: number): ProviderOutcome<never> | null => {
  if (r.aborted) return status(provider, "ABORTED", `${provider} CLI cancelled by caller`, t0);
  if (r.spawnError === "ENOENT" || r.spawnError === "EACCES")
    return fail(provider, "CLI_NOT_FOUND", `${provider} CLI not runnable at "${sanitize(command)}" (${r.spawnError}); check server configuration`, t0);
  if (r.spawnError) return fail(provider, "EXIT_NONZERO", `${provider} CLI failed to start (${r.spawnError})`, t0);
  if (r.timedOut) return fail(provider, "TIMEOUT", `${provider} CLI timed out and was terminated`, t0);
  if (r.outputLimitExceeded) return fail(provider, "OUTPUT_LIMIT", `${provider} CLI output exceeded ${LIMITS.maxStdoutBytes} bytes and was terminated`, t0);
  if (r.exitCode !== 0) {
    const detail = errorDetail(r);
    if (QUOTA_RE.test(detail)) return { ...fail(provider, "QUOTA", `${provider} quota or rate limit reached: ${detail}`, t0), cooldownMs: parseResetMs(detail) };
    if (AUTH_RE.test(detail)) return fail(provider, "AUTH_REQUIRED", `${provider} CLI is not authenticated; an operator must log in interactively (not attempted here): ${detail}`, t0);
    return fail(provider, "EXIT_NONZERO", `${provider} CLI exited with code ${r.exitCode}: ${detail}`, t0);
  }
  return null;
};

const parseEnvelope = (raw: string): unknown => {
  try {
    return JSON.parse(raw);
  } catch {
    return undefined;
  }
};

/** Pull a JSON object out of model text: tolerate ```json fences and leading/trailing prose. */
export const extractJson = (text: string): unknown => {
  const t = text.trim();
  const fenced = /^```(?:json)?\s*([\s\S]*?)\s*```$/i.exec(t)?.[1] ?? t;
  for (const candidate of [fenced, fenced.slice(fenced.indexOf("{"), fenced.lastIndexOf("}") + 1)]) {
    try {
      return JSON.parse(candidate);
    } catch {
      /* try next */
    }
  }
  return undefined;
};

type Envelope = { text: string } | { code: string; message: string; cooldownMs?: number };

/** Quota / login problems reported inside an envelope (agy and Claude both exit 0 for some of them). */
const expiredFrom = (detail: string, who: string): Envelope | null => {
  if (QUOTA_RE.test(detail)) return { code: "QUOTA", message: `${who} quota or rate limit reached: ${detail}`, cooldownMs: parseResetMs(detail) };
  if (AUTH_RE.test(detail)) return { code: "AUTH_REQUIRED", message: `${who} is not authenticated; an operator must log in interactively (not attempted here): ${detail}` };
  return null;
};

const claudeEnvelope = (raw: string): Envelope => {
  const e = parseEnvelope(raw) as Record<string, unknown> | undefined;
  if (!e || typeof e !== "object" || Array.isArray(e)) return { code: "BAD_ENVELOPE", message: "claude output is not a JSON envelope" };
  if (e.is_error === true || (e.subtype !== undefined && e.subtype !== "success")) {
    const detail = typeof e.result === "string" ? sanitize(e.result) : "";
    return expiredFrom(detail, "claude") ?? { code: "BAD_ENVELOPE", message: `claude reported an error (${sanitize(String(e.subtype ?? "unknown"), undefined, 60)})` };
  }
  if (Array.isArray(e.permission_denials) && e.permission_denials.length > 0)
    return { code: "TOOL_USE_DETECTED", message: "claude attempted a tool call; result discarded" };
  if (typeof e.result !== "string") return { code: "BAD_ENVELOPE", message: "claude envelope has no string result" };
  return { text: e.result };
};

const agyEnvelope = (raw: string): Envelope => {
  const e = parseEnvelope(raw) as { status?: unknown; response?: unknown; error?: unknown; denied_actions?: unknown } | undefined;
  if (!e || typeof e !== "object" || Array.isArray(e)) return { code: "BAD_ENVELOPE", message: "agy output is not a JSON envelope" };
  if (e.status !== "SUCCESS" || e.error) {
    const detail = sanitize(typeof e.error === "string" ? e.error : e.error && typeof e.error === "object" ? String((e.error as { message?: unknown }).message ?? "unknown") : `status ${String(e.status)}`);
    return expiredFrom(detail, "agy") ?? { code: "BAD_ENVELOPE", message: `agy reported an error: ${detail}` };
  }
  // Headless agy auto-denies tools that need confirmation and lists them here: the model tried to use a tool.
  if (Array.isArray(e.denied_actions) && e.denied_actions.length > 0) return { code: "TOOL_USE_DETECTED", message: "agy attempted a tool call; result discarded" };
  if (typeof e.response !== "string" || !e.response.trim()) return { code: "BAD_ENVELOPE", message: "agy envelope has no response text (it may have hit its print timeout)" };
  return { text: e.response };
};

// ---- one guarded CLI call -----------------------------------------------------------------------------------

/** Which half of an analysis a call belongs to; used only for safe diagnostics (never affects behavior). */
export type CallStage = "draft" | "audit" | "strategy";

/** One provider call, with safe diagnostics: stage, prompt size, configured timeout, duration and failure reason are
 * logged to stderr (never the prompt/source text or any secret). Distinguishes a provider-level TIMEOUT (this call's
 * own deadline) from an ABORTED call (the outer job/request was cancelled -- see JOB_TIMEOUT in research/jobs.ts,
 * which aborts the shared AbortSignal rather than timing out an individual call). */
export async function callProvider<S extends z.ZodType>(
  provider: ProviderName,
  cfg: ProviderConfig,
  prompt: string,
  schema: S,
  stage: CallStage = "draft",
): Promise<ProviderOutcome<z.infer<S>>> {
  const promptChars = prompt.length;
  const promptBytes = Buffer.byteLength(prompt);
  const outcome = await callProviderInner(provider, cfg, prompt, schema, promptChars, promptBytes);
  console.log(
    `[intel/${provider}/${stage}] chars=${promptChars} bytes=${promptBytes} timeoutMs=${cfg.timeoutMs} ` +
    `durationMs=${outcome.status.durationMs} status=${outcome.status.status} code=${outcome.status.code}`,
  );
  return outcome;
}

async function callProviderInner<S extends z.ZodType>(
  provider: ProviderName,
  cfg: ProviderConfig,
  prompt: string,
  schema: S,
  promptChars: number,
  promptBytes: number,
): Promise<ProviderOutcome<z.infer<S>>> {
  const t0 = Date.now();
  if (cfg.signal?.aborted) return status(provider, "ABORTED", `${provider} call cancelled by caller`, t0);
  if (promptChars > LIMITS.maxPromptChars) return fail(provider, "OUTPUT_LIMIT", "prompt exceeds the configured bound", t0);
  if (provider === "agy" && promptBytes > MAX_ARGV_PROMPT_BYTES)
    return fail(provider, "OUTPUT_LIMIT", `prompt is larger than the ${MAX_ARGV_PROMPT_BYTES}-byte argument limit for agy`, t0);

  const dir = await mkdtemp(join(tmpdir(), `intel-${provider}-`)); // empty cwd: nothing to read even if a tool leaked
  try {
    const args = provider === "claude" ? claudeArgs(cfg.model, cfg.effort) : agyArgs(prompt, cfg.timeoutMs, cfg.model);

    let result: RunResult;
    try {
      result = await cfg.runner({
        command: cfg.command,
        args,
        stdin: provider === "claude" ? prompt : "",
        env: buildEnv(cfg.env),
        cwd: dir,
        timeoutMs: cfg.timeoutMs,
        maxStdoutBytes: LIMITS.maxStdoutBytes,
        signal: cfg.signal,
      });
    } catch (e) {
      return fail(provider, "EXIT_NONZERO", `${provider} runner failed: ${sanitize(String((e as Error)?.message ?? e))}`, t0);
    }

    // An agy killed at our deadline may still have printed an envelope that says why (quota / login): prefer it.
    if (provider === "agy" && (result.timedOut || result.exitCode !== 0) && result.stdout.trimStart().startsWith("{")) {
      const late = agyEnvelope(result.stdout);
      if ("code" in late && (late.code === "QUOTA" || late.code === "AUTH_REQUIRED")) return { ...fail(provider, late.code, late.message, t0), cooldownMs: late.cooldownMs };
    }
    const bad = classify(provider, result, cfg.command, t0);
    if (bad) return bad;

    const env = provider === "claude" ? claudeEnvelope(result.stdout) : agyEnvelope(result.stdout);
    if ("code" in env) return { ...fail(provider, env.code, env.message, t0), cooldownMs: env.cooldownMs };

    const json = extractJson(env.text);
    if (json === undefined) return fail(provider, "BAD_JSON", `${provider} reply did not contain a JSON object`, t0);
    const parsed = schema.safeParse(json);
    if (!parsed.success) {
      const first = parsed.error.issues[0];
      return fail(provider, "SCHEMA_INVALID", `${provider} reply failed schema validation at ${sanitize(first?.path.join(".") || "(root)", undefined, 80)}: ${sanitize(first?.message ?? "", undefined, 100)}`, t0);
    }
    return { status: { provider, status: "ok", code: "OK", message: "ok", durationMs: Date.now() - t0 }, value: parsed.data };
  } finally {
    await rm(dir, { recursive: true, force: true }).catch(() => {});
  }
}

export const abortedStatus = (provider: ProviderName): ProviderStatus => status(provider, "ABORTED", `${provider} call cancelled by caller`, Date.now()).status;

export const skipped = (provider: ProviderName, message: string): ProviderStatus => ({
  provider,
  status: "skipped",
  code: "SKIPPED",
  message,
  durationMs: 0,
});
