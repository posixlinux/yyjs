import { writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { LocalStore } from "../src/providers/local.js";
import { makeDataset, tmpDir } from "./fixture.js";

const write = (dir: string, ticker: string, ds: unknown) => writeFile(path.join(dir, `${ticker}.json`), JSON.stringify(ds));

describe("LocalStore (read-only demo fixtures)", () => {
  it("loads and lists synthetic fixtures", async () => {
    const dir = await tmpDir("store");
    const ds = { ...makeDataset(), synthetic: true };
    await write(dir, "111110", ds);
    const store = new LocalStore(dir);
    expect(await store.get("111110")).toEqual(ds);
    expect((await store.list()).map((d) => d.company.ticker)).toEqual(["111110"]);
    expect(await new LocalStore(path.join(dir, "missing")).list()).toEqual([]);
  });

  it("returns null for unknown tickers and 502 for corrupt files", async () => {
    const dir = await tmpDir("store");
    const store = new LocalStore(dir);
    expect(await store.get("222222")).toBeNull();
    await writeFile(path.join(dir, "333333.json"), "{ not json");
    await expect(store.get("333333")).rejects.toMatchObject({ status: 502, code: "DATA_PROVIDER_ERROR" });
    await expect(store.list()).rejects.toBeInstanceOf(AppError);
  });

  it("refuses non-synthetic data and tickers that do not match the file name", async () => {
    const dir = await tmpDir("store");
    const store = new LocalStore(dir);
    await write(dir, "111110", makeDataset());
    await expect(store.get("111110")).rejects.toMatchObject({ status: 502 }); // real data in the demo store
    await write(dir, "444444", { ...makeDataset(), synthetic: true });
    await expect(store.get("444444")).rejects.toMatchObject({ status: 502 });
    await expect(store.get("../etc")).rejects.toThrow();
  });
});
