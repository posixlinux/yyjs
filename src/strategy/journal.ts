import { createHash, randomUUID } from "node:crypto";
import { link, mkdir, open, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";
import { z } from "zod";
import { AppError } from "../errors.js";
import { StrategySourceSchema, isoDateTime, type StrategySource } from "./schema.js";
import { epoch } from "./time.js";
import { STRATEGY_VERSION } from "./version.js";

// Immutable append-only journal (STRATEGY_SPEC.md "Time integrity and persistence" record modes). One file per
// record, named by its server-assigned id, created with an OS-level exclusive link (never a plain rename, which
// would silently overwrite): a duplicate id always fails rather than replacing the old record. Revisions are new
// records with `supersedes` pointing at the old id; nothing is ever edited or deleted in place.

export const RECORD_MODES = ["forward", "historical_import_unverified"] as const;
export type RecordMode = (typeof RECORD_MODES)[number];

const canonicalize = (v: unknown): unknown => {
  if (Array.isArray(v)) return v.map(canonicalize);
  if (v && typeof v === "object") return Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, x]) => [k, canonicalize(x)]));
  return v;
};
export const contentHashOf = (payload: unknown): string => createHash("sha256").update(JSON.stringify(canonicalize(payload))).digest("hex");

// The envelope's `payload` is validated separately (via .transform below) rather than embedded generically in the
// z.object shape: zod's generic-mapped-type inference cannot resolve a still-open type parameter T at this point, so
// embedding it directly breaks the object's inferred output type. z.unknown() keeps the envelope's own shape concrete.
const RecordEnvelopeSchema = z
  .object({
    id: z.uuid(),
    strategyVersion: z.literal(STRATEGY_VERSION),
    mode: z.enum(RECORD_MODES),
    recordedAt: isoDateTime, // server clock at the moment this record was written (create OR import); never client-supplied
    supersedes: z.uuid().optional(), // id of a prior record this revises; the prior record is untouched
    // Required only for historical_import_unverified: the archive's own provenance for the whole record, plus the
    // forecast/consensus/catalyst payload's own claimed generatedAt/knownAt fields remain as originally imported.
    archiveSource: StrategySourceSchema.optional(),
    // A historical_import_unverified record whose content is fictional (the bundled example / tests), never real
    // archived evidence. STRATEGY_SPEC.md: "Synthetic example/test can use historical mode plus synthetic:true."
    synthetic: z.boolean().optional(),
    contentHash: z.string().regex(/^[0-9a-f]{64}$/),
    payload: z.unknown(),
  })
  .strict()
  .refine((r) => (r.mode === "historical_import_unverified" ? !!r.archiveSource : true), { message: "historical_import_unverified records require archiveSource", path: ["archiveSource"] })
  .refine((r) => (r.synthetic ? r.mode === "historical_import_unverified" : true), { message: "synthetic:true is only valid on historical_import_unverified records", path: ["synthetic"] })
  .refine((r) => r.contentHash === contentHashOf(r.payload), { message: "contentHash does not match payload", path: ["contentHash"] });

export function journalRecordSchema<T extends z.ZodType>(payload: T) {
  return RecordEnvelopeSchema.transform((r, ctx) => {
    const parsed = payload.safeParse(r.payload);
    if (!parsed.success) {
      for (const issue of parsed.error.issues) ctx.addIssue({ ...issue, path: ["payload", ...issue.path] });
      return z.NEVER;
    }
    return { ...r, payload: parsed.data } as JournalRecord<z.infer<T>>;
  });
}

export type JournalRecord<T> = {
  id: string;
  strategyVersion: string;
  mode: RecordMode;
  recordedAt: string;
  supersedes?: string;
  archiveSource?: StrategySource;
  synthetic?: boolean;
  contentHash: string;
  payload: T;
};

const ID_FILE = /^([0-9a-f-]{36})\.json$/;

export class JournalStore<T> {
  private schema;
  constructor(
    readonly dir: string,
    payloadSchema: z.ZodType<T>,
  ) {
    this.schema = journalRecordSchema(payloadSchema);
  }

  private file(id: string) {
    if (!/^[0-9a-f-]{36}$/.test(id)) throw new Error("invalid record id"); // guards path traversal
    return path.join(this.dir, `${id}.json`);
  }

  /** Server assigns id + recordedAt; payload's own contentHash is computed here. Never overwrites an existing id. */
  async append(input: { mode: RecordMode; payload: T; supersedes?: string; archiveSource?: StrategySource; synthetic?: boolean; now: Date }): Promise<JournalRecord<T>> {
    const record: JournalRecord<T> = {
      id: randomUUID(),
      strategyVersion: STRATEGY_VERSION,
      mode: input.mode,
      recordedAt: input.now.toISOString(),
      ...(input.supersedes && { supersedes: input.supersedes }),
      ...(input.archiveSource && { archiveSource: input.archiveSource }),
      ...(input.synthetic !== undefined && { synthetic: input.synthetic }),
      contentHash: contentHashOf(input.payload),
      payload: input.payload,
    };
    const check = this.schema.safeParse(record);
    if (!check.success) throw new AppError(422, "RECORD_INVALID", "Record fails validation and was not persisted", check.error.issues.map((i) => ({ path: i.path.join("."), message: i.message })));
    await mkdir(this.dir, { recursive: true });
    const tmp = path.join(this.dir, `.${record.id}.${randomUUID()}.tmp`);
    try {
      const fh = await open(tmp, "w");
      try {
        await fh.writeFile(JSON.stringify(record, null, 2) + "\n");
        await fh.sync();
      } finally {
        await fh.close();
      }
      try {
        await link(tmp, this.file(record.id)); // exclusive: fails EEXIST if the id already exists, unlike rename
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code === "EEXIST") throw new AppError(422, "RECORD_ID_CONFLICT", `Record id ${record.id} already exists; records are immutable and cannot be overwritten`);
        throw e;
      }
    } catch (e) {
      if (e instanceof AppError) throw e;
      throw new AppError(502, "STRATEGY_STORE_ERROR", "Cannot persist journal record");
    } finally {
      await rm(tmp, { force: true });
    }
    return record;
  }

  async get(id: string): Promise<JournalRecord<T> | null> {
    let raw: string;
    try {
      raw = await readFile(this.file(id), "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new AppError(502, "STRATEGY_STORE_ERROR", `Cannot read journal record ${id}`);
    }
    const parsed = this.schema.safeParse(JSON.parse(raw));
    if (!parsed.success) throw new AppError(502, "STRATEGY_STORE_ERROR", `Journal record ${id} is corrupt or violates the schema`);
    return parsed.data as JournalRecord<T>;
  }

  async list(): Promise<JournalRecord<T>[]> {
    let names: string[];
    try {
      names = await readdir(this.dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw new AppError(502, "STRATEGY_STORE_ERROR", "Cannot list journal records");
    }
    const ids = names.map((n) => ID_FILE.exec(n)?.[1]).filter((id): id is string => !!id);
    const records = await Promise.all(ids.map((id) => this.get(id)));
    return records.filter((r): r is JournalRecord<T> => r !== null).sort((a, b) => epoch(a.recordedAt) - epoch(b.recordedAt));
  }
}
