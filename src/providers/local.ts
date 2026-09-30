import { randomUUID } from "node:crypto";
import { mkdir, open, readdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { DatasetSchema, type Dataset } from "../domain/schema.js";
import { AppError } from "../errors.js";

const FILE = /^(\d{6})\.json$/;

/**
 * Local JSON dataset store: one file per KOSPI ticker (<dir>/<ticker>.json).
 * Reads hit the disk every time, so writes are visible immediately and survive restarts.
 * `synthetic` stores hold only fixtures flagged synthetic:true (demo); real stores reject them and vice versa.
 */
export class LocalStore {
  constructor(
    readonly dir: string,
    readonly synthetic: boolean,
  ) {}

  private file(ticker: string) {
    if (!/^\d{6}$/.test(ticker)) throw new Error("invalid ticker"); // callers validate; guards path traversal
    return path.join(this.dir, `${ticker}.json`);
  }

  async get(ticker: string): Promise<Dataset | null> {
    let raw: string;
    try {
      raw = await readFile(this.file(ticker), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new AppError(502, "DATA_PROVIDER_ERROR", `Cannot read dataset for ${ticker}`);
    }
    let ds: Dataset;
    try {
      ds = DatasetSchema.parse(JSON.parse(raw));
    } catch {
      throw new AppError(502, "DATA_PROVIDER_ERROR", `Stored dataset for ${ticker} is corrupt or violates the schema`, undefined, "Re-ingest it with POST /v1/datasets.");
    }
    if (ds.company.ticker !== ticker || (ds.synthetic === true) !== this.synthetic)
      throw new AppError(502, "DATA_PROVIDER_ERROR", `Stored dataset for ${ticker} does not belong in this ${this.synthetic ? "demo" : "manual"} store`);
    return ds;
  }

  async list(): Promise<Dataset[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new AppError(502, "DATA_PROVIDER_ERROR", "Cannot list datasets");
    }
    const all = await Promise.all(names.map((n) => FILE.exec(n)?.[1]).filter((t): t is string => !!t).sort().map((t) => this.get(t)));
    return all.filter((d): d is Dataset => d !== null);
  }

  /** Atomic write: temp file in the same directory, fsync, rename. Returns true if the ticker was new. */
  async put(ds: Dataset): Promise<boolean> {
    const final = this.file(ds.company.ticker);
    await mkdir(this.dir, { recursive: true });
    const created = (await this.get(ds.company.ticker).catch(() => null)) === null;
    const tmp = path.join(this.dir, `.${ds.company.ticker}.${randomUUID()}.tmp`);
    try {
      const fh = await open(tmp, "w");
      try {
        await fh.writeFile(JSON.stringify(ds, null, 2) + "\n");
        await fh.sync();
      } finally {
        await fh.close();
      }
      await rename(tmp, final);
    } catch {
      await rm(tmp, { force: true });
      throw new AppError(502, "DATA_PROVIDER_ERROR", `Cannot persist dataset for ${ds.company.ticker}`);
    }
    return created;
  }
}
