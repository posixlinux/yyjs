import path from "node:path";
import { loadConfig, type Config } from "../src/config.js";
import { buildApp } from "../src/http/app.js";
import { LocalStore } from "../src/providers/local.js";
import { ResearchService, type ResearchDeps } from "../src/research/service.js";
import { Service } from "../src/service.js";
import { NOW, tmpDir } from "./fixture.js";

export const demoDir = path.join(process.cwd(), "data/demo");

/** Full app with fake collector/intelligence by default (they throw: tests that need them inject their own). */
export async function setup(over: Partial<Config> = {}, now = NOW, deps: Partial<ResearchDeps> = {}) {
  const dataDir = await tmpDir("http");
  const config: Config = { ...loadConfig({}), dataDir, demoDir, logLevel: "silent", now: () => now, ...over };
  const service = new Service({ demo: new LocalStore(config.demoDir) }, config);
  const research = new ResearchService(
    {
      collect: async () => {
        throw new Error("collector not injected");
      },
      intelligence: async () => {
        throw new Error("intelligence not injected");
      },
      now: config.now,
      secrets: config.secrets,
      ...deps,
    },
    config.jobs,
    (asOf) => service.resolveAsOf(asOf),
  );
  return { app: buildApp(service, research, config), dataDir, research, service, config };
}
export type TestApp = Awaited<ReturnType<typeof setup>>["app"];
