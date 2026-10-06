import { setup } from "./test/app.js";
const s = await setup({}, undefined, { collect: async () => { throw new Error("stop"); } });
await s.app.listen({ port: 8798, host: "127.0.0.1" });
