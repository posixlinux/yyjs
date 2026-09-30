// One-time interactive sign-in for the Antigravity CLI (`agy`).
// Run: npm run agy:login   -> agy starts; complete the browser sign-in with your Google account, then type /quit.
// agy has no separate login command and keeps its token in the OS keyring; `npm run doctor` then confirms it.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const local = path.join(os.homedir(), ".local/bin/agy");
const bin = process.env.INTELLIGENCE_AGY_PATH || (existsSync(local) ? local : "agy");

// The child gets an ALLOWLISTED environment (same idea as src/intelligence/runner.ts): no API key, Vertex or billing-project
// variable can steer agy to a paid route, whatever the shell exports.
const ENV_ALLOWLIST = ["PATH", "HOME", "USER", "LOGNAME", "LANG", "LC_ALL", "LC_CTYPE", "TMPDIR", "TERM", "XDG_CONFIG_HOME", "XDG_DATA_HOME", "XDG_CACHE_HOME", "XDG_STATE_HOME", "HTTPS_PROXY", "HTTP_PROXY", "NO_PROXY", "ALL_PROXY", "https_proxy", "http_proxy", "no_proxy", "all_proxy", "SSL_CERT_FILE", "NODE_EXTRA_CA_CERTS", "SSH_CONNECTION", "SSH_CLIENT", "SSH_TTY", "DISPLAY", "BROWSER"];
const env = Object.fromEntries(ENV_ALLOWLIST.filter((k) => typeof process.env[k] === "string").map((k) => [k, process.env[k]]));

const cwd = path.join(root, ".tools", "login-cwd"); // empty, git-ignored: agy must not load project files
await mkdir(cwd, { recursive: true });

console.log("agy(Antigravity CLI)를 대화형으로 시작합니다. 브라우저에서 Google 계정으로 로그인하세요.");
console.log("로그인이 끝나면 agy에서 /quit 를 입력해 종료하세요. 이후 `npm run doctor`로 확인합니다.");
console.log("(agy가 없다면: curl -fsSL https://antigravity.google/cli/install.sh | bash)\n");

const child = spawn(bin, [], { stdio: "inherit", env, cwd, shell: false });
child.on("error", (e) => {
  console.error(`agy를 실행할 수 없습니다 (${e.code ?? e.message}). 설치 후 다시 시도하세요.`);
  process.exit(1);
});
child.on("close", (code) => process.exit(code ?? 0));
