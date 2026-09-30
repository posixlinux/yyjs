import { collectPublicEvidence } from "../src/collection/index.js";
import { loadConfig } from "../src/config.js";
import { buildApp } from "../src/http/app.js";
import { LocalStore } from "../src/providers/local.js";
import { ResearchService } from "../src/research/service.js";
import { Service } from "../src/service.js";

const config = { ...loadConfig({}), logLevel: "silent" };
const service = new Service({ manual: new LocalStore(config.dataDir, false), demo: new LocalStore(config.demoDir, true) }, config);
const research = new ResearchService(
  {
    collect: (input, { signal }) => collectPublicEvidence(input, { signal, env: { ...process.env, DART_API_KEY: "" } }),
    intelligence: async () => {
      throw new Error("LLM must not run in evidence-only e2e");
    },
    now: config.now,
    secrets: config.secrets,
  },
  config.jobs,
  (a) => service.resolveAsOf(a),
);
const app = buildApp(service, research, config);
const res = await app.inject({ method: "POST", url: "/v1/research", payload: { ticker: "005930" } });
console.log(res.statusCode, res.body);
const { statusUrl } = res.json();
for (let i = 0; i < 100; i++) {
  const r = (await app.inject({ url: statusUrl })).json();
  if (!["queued", "running"].includes(r.status)) {
    console.log(r.status, r.result?.evidence?.status, r.result?.evidence?.market?.quote?.close, r.result?.documents?.sentToModelsIfAnalysed?.length, JSON.stringify(r.result?.missingInputs?.slice(0, 2)));
    break;
  }
  await new Promise((r) => setTimeout(r, 500));
}
await app.close();
