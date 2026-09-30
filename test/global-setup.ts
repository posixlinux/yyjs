import { rm } from "node:fs/promises";

// Workspace-local scratch dirs (see fixture.tmpDir) are wiped before and after each run.
const clean = () => rm(".test-tmp", { recursive: true, force: true });

export default async function setup() {
  await clean();
  return clean;
}
