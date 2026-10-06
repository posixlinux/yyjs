import { spawn } from "node:child_process";
import { LIMITS, type RunRequest, type RunResult } from "./types.js";

// Only these variables reach a CLI child: enough for auth/PATH/proxies, nothing that carries data-provider keys
// (DART/NAVER) or paid fallbacks (ANTHROPIC_API_KEY, OPENAI_API_KEY, GOOGLE_API_KEY, GOOGLE_CLOUD_PROJECT...).
const ENV_ALLOWLIST = [
  "PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TEMP", "TMP", "TERM",
  "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "CLAUDE_CONFIG_DIR", "CODEX_HOME",
  "SystemRoot", "USERPROFILE", "APPDATA", "LOCALAPPDATA", "COMSPEC", "PATHEXT",
  "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "no_proxy", "all_proxy",
  "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS",
  // Claude Code's output-token cap for one reply; a large draft dataset can exceed the default.
  "CLAUDE_CODE_MAX_OUTPUT_TOKENS",
];

export const buildEnv = (source: NodeJS.ProcessEnv, extra: Record<string, string> = {}): Record<string, string> => {
  const env: Record<string, string> = {};
  for (const k of ENV_ALLOWLIST) if (typeof source[k] === "string") env[k] = source[k]!;
  return { ...env, ...extra };
};

/** Real runner: shell:false, prompt on stdin, kills the whole process group on timeout / output overflow. */
export const spawnRunner = (req: RunRequest): Promise<RunResult> =>
  new Promise((resolve) => {
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let outBytes = 0;
    let errBytes = 0;
    let timedOut = false;
    let outputLimitExceeded = false;
    let aborted = false;
    let settled = false;
    let killTimer: NodeJS.Timeout | undefined;

    if (req.signal?.aborted)
      return resolve({ stdout: "", stderr: "", exitCode: null, timedOut, outputLimitExceeded, aborted: true });

    const child = spawn(req.command, req.args, {
      shell: false,
      cwd: req.cwd,
      env: req.env,
      stdio: ["pipe", "pipe", "pipe"],
      detached: process.platform !== "win32",
      windowsHide: true,
    });

    const kill = (sig: NodeJS.Signals) => {
      try {
        if (child.pid && process.platform !== "win32") process.kill(-child.pid, sig);
        else child.kill(sig);
      } catch {
        /* already gone */
      }
    };
    const abort = () => {
      kill("SIGTERM");
      killTimer = setTimeout(() => kill("SIGKILL"), 2_000);
    };
    const onAbort = () => {
      aborted = true;
      abort();
    };
    const finish = (r: Partial<RunResult>) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      clearTimeout(killTimer);
      req.signal?.removeEventListener("abort", onAbort);
      resolve({
        stdout: Buffer.concat(out).toString("utf8"),
        stderr: Buffer.concat(err).toString("utf8"),
        exitCode: null,
        timedOut,
        outputLimitExceeded,
        aborted,
        ...r,
      });
    };

    const timer = setTimeout(() => {
      timedOut = true;
      abort();
    }, req.timeoutMs);
    req.signal?.addEventListener("abort", onAbort, { once: true });

    child.stdout.on("data", (c: Buffer) => {
      outBytes += c.length;
      if (outBytes > req.maxStdoutBytes) {
        if (!outputLimitExceeded) {
          outputLimitExceeded = true;
          abort();
        }
        return;
      }
      out.push(c);
    });
    child.stderr.on("data", (c: Buffer) => {
      if (errBytes < LIMITS.maxStderrBytes) err.push(c);
      errBytes += c.length;
    });
    child.on("error", (e: NodeJS.ErrnoException) => finish({ spawnError: e.code ?? "SPAWN_FAILED" }));
    child.on("close", (code) => finish({ exitCode: code }));
    child.stdin.on("error", () => {}); // EPIPE when the child exits before reading stdin
    child.stdin.end(req.stdin);
  });

/** Bounded semaphore; limit is read on every acquire so config changes take effect. */
export class Semaphore {
  private active = 0;
  private waiters: (() => void)[] = [];

  /** Rejects with signal.reason if aborted while queued (a queued waiter never starts a child). */
  async run<T>(limit: number, fn: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    while (this.active >= Math.max(1, limit)) {
      signal?.throwIfAborted();
      await new Promise<void>((resolve) => {
        const wake = () => {
          signal?.removeEventListener("abort", onAbort);
          resolve();
        };
        const onAbort = () => {
          const i = this.waiters.indexOf(wake);
          if (i >= 0) this.waiters.splice(i, 1);
          wake();
        };
        this.waiters.push(wake);
        signal?.addEventListener("abort", onAbort, { once: true });
      });
    }
    signal?.throwIfAborted();
    this.active++;
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiters.shift()?.();
    }
  }
}

const SECRET_PATTERNS = [/AIza[\w-]{20,}/g, /\bsk-[\w-]{10,}/g, /ya29\.[\w.-]+/g, /Bearer\s+\S+/gi, /[\w-]{24,}\.[\w-]{6,}\.[\w-]{20,}/g];

/** Bounded single-line text with secrets, control characters and the home directory removed. */
export const sanitize = (s: string, home = process.env.HOME, max = 200): string => {
  let t = s.replace(/[\u0000-\u001f\u007f]+/g, " ");
  if (home && home.length > 1) t = t.split(home).join("~");
  t = t.replace(/(?:\/Users|\/home)\/[^/\s]+/g, "~"); // home dirs of whichever user runs the CLI
  for (const p of SECRET_PATTERNS) t = t.replace(p, "[redacted]");
  t = t.replace(/\s+/g, " ").trim();
  return t.length > max ? `${t.slice(0, max)}…` : t;
};
