// earnings-gap-auto/v1 CLI (docs/STRATEGY_SPEC.md). Local-only: no network, no LLM. Reads/writes the same journal
// files as the HTTP API (under DATA_DIR/strategy/*), so records made via one are visible to the other.
//
// Usage:
//   npm run strategy -- record-forecast <payload.json> [--mode=forward|historical_import_unverified] [--archive-source=<file.json>] [--synthetic] [--supersedes=<id>]
//   npm run strategy -- record-consensus <payload.json> [same flags]
//   npm run strategy -- record-catalyst  <payload.json> [same flags]
//   npm run strategy -- list <forecasts|consensus|catalysts>
//   npm run strategy -- get <forecasts|consensus|catalysts> <id>
//   npm run strategy -- screen <screen-request.json>
//   npm run strategy -- replay <screen-request.json> <replay-input.json>
import { readFile } from "node:fs/promises";
import path from "node:path";
import { loadConfig } from "../src/config.js";
import { StrategyService, type RecordKind } from "../src/strategy/service.js";

const config = loadConfig();
const strategy = new StrategyService(
  { forecasts: path.join(config.dataDir, "strategy/forecasts"), consensus: path.join(config.dataDir, "strategy/consensus"), catalysts: path.join(config.dataDir, "strategy/catalysts") },
  { now: () => new Date() },
);

const [cmd, ...rest] = process.argv.slice(2);
const flags = rest.filter((a) => a.startsWith("--"));
const args = rest.filter((a) => !a.startsWith("--"));
const flag = (name: string): string | undefined => flags.find((f) => f.startsWith(`--${name}=`))?.slice(name.length + 3);
const readJson = async (p: string): Promise<unknown> => JSON.parse(await readFile(p, "utf8"));
const print = (v: unknown) => console.log(JSON.stringify(v, null, 2));

const RECORD_KIND_ROUTE: Record<string, RecordKind> = { forecasts: "forecast", consensus: "consensus", catalysts: "catalyst" };

async function recordCommand(kind: RecordKind) {
  const file = args[0];
  if (!file) throw new Error(`usage: record-${kind} <payload.json> [--mode=forward|historical_import_unverified] [--archive-source=<file.json>] [--synthetic] [--supersedes=<id>]`);
  const payload = await readJson(file);
  const archiveSourceFile = flag("archive-source");
  const rec = await strategy.record(kind, {
    mode: flag("mode") ?? "forward",
    payload,
    archiveSource: archiveSourceFile ? await readJson(archiveSourceFile) : undefined,
    synthetic: flags.includes("--synthetic") ? true : undefined,
    supersedes: flag("supersedes"),
  });
  print(rec);
}

async function main() {
  switch (cmd) {
    case "record-forecast":
      return recordCommand("forecast");
    case "record-consensus":
      return recordCommand("consensus");
    case "record-catalyst":
      return recordCommand("catalyst");
    case "list": {
      const kind = RECORD_KIND_ROUTE[args[0] ?? ""];
      if (!kind) throw new Error("usage: list <forecasts|consensus|catalysts>");
      return print({ records: await strategy.listRecords(kind) });
    }
    case "get": {
      const kind = RECORD_KIND_ROUTE[args[0] ?? ""];
      if (!kind || !args[1]) throw new Error("usage: get <forecasts|consensus|catalysts> <id>");
      return print(await strategy.getRecord(kind, args[1]));
    }
    case "screen": {
      if (!args[0]) throw new Error("usage: screen <screen-request.json>");
      return print(await strategy.screen((await readJson(args[0])) as Parameters<typeof strategy.screen>[0]));
    }
    case "replay": {
      if (!args[0] || !args[1]) throw new Error("usage: replay <screen-request.json> <replay-input.json>");
      const [screenReq, replayInput] = await Promise.all([readJson(args[0]), readJson(args[1])]);
      return print(await strategy.screenAndReplay(screenReq as Parameters<typeof strategy.screenAndReplay>[0], replayInput as Parameters<typeof strategy.screenAndReplay>[1]));
    }
    default:
      console.log("commands: record-forecast, record-consensus, record-catalyst, list, get, screen, replay");
      process.exitCode = cmd ? 1 : 0;
  }
}

await main();
