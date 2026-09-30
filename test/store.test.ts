import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { AppError } from "../src/errors.js";
import { LocalStore } from "../src/providers/local.js";
import { makeDataset, tmpDir } from "./fixture.js";

describe("LocalStore atomic persistence", () => {
  it("persists, reloads from a fresh instance, and leaves no temp files", async () => {
    const dir = await tmpDir("store");
    const ds = makeDataset();
    expect(await new LocalStore(dir, false).put(ds)).toBe(true);
    expect(await readdir(dir)).toEqual(["111110.json"]);
    const reloaded = await new LocalStore(dir, false).get("111110");
    expect(reloaded).toEqual(ds);
    expect((await new LocalStore(dir, false).list()).map((d) => d.company.ticker)).toEqual(["111110"]);
  });

  it("replaces an existing dataset and reports created=false", async () => {
    const store = new LocalStore(await tmpDir("store"), false);
    await store.put(makeDataset());
    const ds = makeDataset();
    ds.quote.priceKRW = 12_345;
    expect(await store.put(ds)).toBe(false);
    expect((await store.get("111110"))!.quote.priceKRW).toBe(12_345);
  });

  it("concurrent writes never leave a partial or corrupt file", async () => {
    const dir = await tmpDir("store");
    const store = new LocalStore(dir, false);
    const versions = [1, 2, 3, 4, 5, 6].map((p) => {
      const d = makeDataset();
      d.quote.priceKRW = p * 1000;
      return d;
    });
    await Promise.all(versions.map((d) => store.put(d)));
    const final = await store.get("111110");
    expect(versions.map((d) => d.quote.priceKRW)).toContain(final!.quote.priceKRW);
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("returns null for unknown tickers and 502 for corrupt files", async () => {
    const dir = await tmpDir("store");
    const store = new LocalStore(dir, false);
    expect(await store.get("222222")).toBeNull();
    await writeFile(path.join(dir, "333333.json"), "{ not json");
    await expect(store.get("333333")).rejects.toMatchObject({ status: 502, code: "DATA_PROVIDER_ERROR" });
    await expect(store.list()).rejects.toBeInstanceOf(AppError);
  });

  it("keeps synthetic and real datasets apart and refuses tickers that do not match the file name", async () => {
    const dir = await tmpDir("store");
    const real = new LocalStore(dir, false);
    await real.put(makeDataset());
    await expect(new LocalStore(dir, true).get("111110")).rejects.toMatchObject({ status: 502 }); // real data in a demo store
    const raw = JSON.parse(await readFile(path.join(dir, "111110.json"), "utf8"));
    await writeFile(path.join(dir, "444444.json"), JSON.stringify(raw));
    await expect(real.get("444444")).rejects.toMatchObject({ status: 502 });
    await expect(real.get("../etc")).rejects.toThrow();
  });
});
