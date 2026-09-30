import { formatDoctor, runDoctor } from "./research/doctor.js";

const report = await runDoctor();
console.log(process.argv.includes("--json") ? JSON.stringify(report, null, 2) : formatDoctor(report));
process.exitCode = report.ok ? 0 : 1;
