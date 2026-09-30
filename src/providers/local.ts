import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import { DatasetSchema, type Dataset } from "../domain/schema.js";
import { AppError } from "../errors.js";

const FILE = /^(\d{6})\.json$/;

/**
 * Read-only store of the bundled demo fixtures: one file per ticker (<dir>/<ticker>.json), each flagged synthetic:true.
 */
export class LocalStore {
  constructor(readonly dir: string) {}

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
      throw new AppError(502, "DATA_PROVIDER_ERROR", `Stored dataset for ${ticker} is corrupt or violates the schema`);
    }
    if (ds.company.ticker !== ticker || ds.synthetic !== true)
      throw new AppError(502, "DATA_PROVIDER_ERROR", `Stored dataset for ${ticker} does not belong in the demo store`);
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
}
