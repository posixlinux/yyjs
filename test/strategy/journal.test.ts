import { randomUUID } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import { AppError } from "../../src/errors.js";
import { JournalStore, contentHashOf } from "../../src/strategy/journal.js";
import { EarningsForecastSnapshotSchema } from "../../src/strategy/schema.js";
import { makeForecast, tmpDir } from "./fixture.js";

vi.mock("node:crypto", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:crypto")>();
  return { ...actual, randomUUID: vi.fn(actual.randomUUID) };
});

const NOW = new Date("2026-01-10T00:00:00+09:00");

describe("JournalStore: immutability and persistence", () => {
  it("appends a forward record with a server-assigned id/recordedAt and reloads it after a fresh instance (restart)", async () => {
    const dir = await tmpDir("journal");
    const store = new JournalStore(dir, EarningsForecastSnapshotSchema);
    const rec = await store.append({ mode: "forward", payload: makeForecast(), now: NOW });
    expect(rec.recordedAt).toBe(NOW.toISOString());
    expect(rec.contentHash).toBe(contentHashOf(makeForecast()));

    const reloaded = await new JournalStore(dir, EarningsForecastSnapshotSchema).get(rec.id);
    expect(reloaded).toEqual(rec);
    const listed = await new JournalStore(dir, EarningsForecastSnapshotSchema).list();
    expect(listed.map((r) => r.id)).toEqual([rec.id]);
  });

  it("never overwrites an existing id: a forced id collision is rejected and the original record survives untouched", async () => {
    const dir = await tmpDir("journal");
    const store = new JournalStore(dir, EarningsForecastSnapshotSchema);
    const fixedId = "11111111-1111-4111-8111-111111111111" as const; // valid UUID v4 form (version/variant nibbles set)
    const mocked = vi.mocked(randomUUID);
    mocked.mockReturnValue(fixedId);
    try {
      const first = await store.append({ mode: "forward", payload: makeForecast(), now: NOW });
      expect(first.id).toBe(fixedId);
      await expect(store.append({ mode: "forward", payload: { ...makeForecast(), analyst: "second write, should never land" }, now: NOW })).rejects.toMatchObject({ status: 422, code: "RECORD_ID_CONFLICT" });
    } finally {
      mocked.mockRestore();
    }
    // the original record is untouched by the rejected second write
    expect((await store.get(fixedId))!.payload.analyst).toBe("test analyst");
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]); // no leftover temp files
  });

  it("labels historical imports distinctly, requires archiveSource, and supports the synthetic flag", async () => {
    const dir = await tmpDir("journal");
    const store = new JournalStore(dir, EarningsForecastSnapshotSchema);
    await expect(store.append({ mode: "historical_import_unverified", payload: makeForecast(), now: NOW })).rejects.toBeInstanceOf(AppError); // no archiveSource -> rejected before anything is written
    expect(await readdir(dir).catch(() => [])).toEqual([]); // nothing persisted
    const rec = await store.append({
      mode: "historical_import_unverified",
      payload: makeForecast(),
      archiveSource: { title: "archived report", manualReference: "test-fixture", kind: "archive", knownAt: "2025-01-01T00:00:00+09:00" },
      synthetic: true,
      now: NOW,
    });
    expect(rec.mode).toBe("historical_import_unverified");
    expect(rec.synthetic).toBe(true);
    const reloaded = await store.get(rec.id);
    expect(reloaded!.archiveSource!.title).toBe("archived report");
  });

  it("detects a corrupted/tampered record on read (contentHash mismatch)", async () => {
    const dir = await tmpDir("journal");
    const store = new JournalStore(dir, EarningsForecastSnapshotSchema);
    const rec = await store.append({ mode: "forward", payload: makeForecast(), now: NOW });
    const file = path.join(dir, `${rec.id}.json`);
    const raw = JSON.parse(await readFile(file, "utf8"));
    raw.payload.analyst = "tampered after the fact";
    await writeFile(file, JSON.stringify(raw));
    await expect(store.get(rec.id)).rejects.toMatchObject({ status: 502 });
  });

  it("returns null for unknown ids and lists nothing for an empty/missing directory", async () => {
    const dir = await tmpDir("journal");
    const store = new JournalStore(dir, EarningsForecastSnapshotSchema);
    expect(await store.get("00000000-0000-0000-0000-000000000000")).toBeNull();
    expect(await store.list()).toEqual([]);
    expect(await readdir(dir).catch(() => [])).toBeDefined();
  });

  it("concurrent appends never corrupt the directory and each gets a distinct file", async () => {
    const dir = await tmpDir("journal");
    const store = new JournalStore(dir, EarningsForecastSnapshotSchema);
    const recs = await Promise.all(Array.from({ length: 8 }, () => store.append({ mode: "forward", payload: makeForecast(), now: NOW })));
    expect(new Set(recs.map((r) => r.id)).size).toBe(8);
    expect((await readdir(dir)).filter((f) => f.endsWith(".tmp"))).toEqual([]);
    expect(await store.list()).toHaveLength(8);
  });
});
