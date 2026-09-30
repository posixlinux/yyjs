import { z } from "zod";
import { AppError } from "../errors.js";
import { StrategyConfigSchema } from "./config.js";
import { CatalystSchema, ConsensusSnapshotSchema, DiagnosticInputSchema, EarningsForecastSnapshotSchema, EVIDENCE_MODES, StrategySourceSchema, type CandidateInput, type Catalyst, type ConsensusSnapshot, type EarningsForecastSnapshot, type EvidenceMode } from "./schema.js";
import { JournalStore, RECORD_MODES, type JournalRecord, type RecordMode } from "./journal.js";
import { screen, type ScreenResult } from "./screen.js";
import { replay as runReplay, ReplayInputSchema, type ReplayResult } from "./replay.js";
import { epoch } from "./time.js";
import { isoDateTime } from "./schema.js";

// Wires the pure strategy modules (screen.ts, replay.ts, earnings.ts) to the immutable journal, matching the
// Service/ResearchService pattern used by the product-market slice (src/service.ts, src/research/service.ts).
// Screening and replay are synchronous, deterministic, and never call an LLM or the network, so no job queue is
// needed here (unlike the public-collection analysis pipeline).

export type RecordKind = "forecast" | "consensus" | "catalyst";

const RecordRequestSchema = <T extends z.ZodType>(payload: T) =>
  z
    .object({ mode: z.enum(RECORD_MODES), payload, archiveSource: StrategySourceSchema.optional(), synthetic: z.boolean().optional(), supersedes: z.uuid().optional() })
    .strict()
    .refine((r) => (r.mode === "historical_import_unverified" ? !!r.archiveSource : true), { message: "historical_import_unverified records require archiveSource", path: ["archiveSource"] });

export const RecordForecastRequestSchema = RecordRequestSchema(EarningsForecastSnapshotSchema);
export const RecordConsensusRequestSchema = RecordRequestSchema(ConsensusSnapshotSchema);
export const RecordCatalystRequestSchema = RecordRequestSchema(CatalystSchema);

const refOrInline = <T extends z.ZodType>(inline: T) => z.union([z.object({ recordId: z.uuid() }).strict(), inline]);

export const CandidateRequestSchema = z
  .object({
    ticker: z.string().regex(/^\d{6}$/),
    evidenceMode: z.enum(EVIDENCE_MODES),
    forecast: refOrInline(EarningsForecastSnapshotSchema),
    currentConsensus: refOrInline(ConsensusSnapshotSchema),
    priorConsensus: refOrInline(ConsensusSnapshotSchema),
    catalyst: refOrInline(CatalystSchema),
    diagnostic: DiagnosticInputSchema.optional(),
  })
  .strict();

export const ScreenRequestSchema = z.object({ config: StrategyConfigSchema, decisionAt: isoDateTime, candidates: z.array(CandidateRequestSchema).min(1).max(50) }).strict();

export type ScreenRequest = z.infer<typeof ScreenRequestSchema>;
export type CandidateRequest = z.infer<typeof CandidateRequestSchema>;

const evidenceModeOf = (rec: JournalRecord<unknown>): EvidenceMode => rec.synthetic ? "synthetic" : rec.mode;

export class StrategyService {
  readonly forecasts: JournalStore<EarningsForecastSnapshot>;
  readonly consensus: JournalStore<ConsensusSnapshot>;
  readonly catalysts: JournalStore<Catalyst>;

  constructor(
    dirs: { forecasts: string; consensus: string; catalysts: string },
    private opts: { now: () => Date },
  ) {
    this.forecasts = new JournalStore(dirs.forecasts, EarningsForecastSnapshotSchema);
    this.consensus = new JournalStore(dirs.consensus, ConsensusSnapshotSchema);
    this.catalysts = new JournalStore(dirs.catalysts, CatalystSchema);
  }

  private store(kind: RecordKind) {
    return kind === "forecast" ? this.forecasts : kind === "consensus" ? this.consensus : this.catalysts;
  }

  private async recordInternal<T>(store: JournalStore<T>, schema: z.ZodType<{ mode: RecordMode; payload: T; archiveSource?: z.infer<typeof StrategySourceSchema>; synthetic?: boolean; supersedes?: string }>, kind: RecordKind, req: unknown) {
    const parsed = schema.parse(req);
    const now = this.opts.now();
    if (parsed.mode === "forward") {
      // Only observation/creation times, not the future fiscal periods/event dates being predicted.
      const checkKnown = (v: unknown): void => {
        if (!v || typeof v !== "object") return;
        for (const [key, value] of Object.entries(v)) {
          if (["knownAt", "generatedAt", "asOf"].includes(key) && typeof value === "string" && epoch(value) > now.getTime())
            throw new AppError(422, "RECORD_FROM_FUTURE", "Forward records cannot contain observations or forecasts not yet created");
          checkKnown(value);
        }
      };
      checkKnown(parsed.payload);
    }
    if (parsed.supersedes) {
      const prior = await store.get(parsed.supersedes);
      if (!prior) throw new AppError(404, "RECORD_NOT_FOUND", `Cannot supersede unknown ${kind} record ${parsed.supersedes}`);
      if ((prior.payload as { ticker?: string }).ticker !== (parsed.payload as { ticker?: string }).ticker)
        throw new AppError(422, "REVISION_TICKER_MISMATCH", "A revision must refer to the same ticker");
    }
    return store.append({ mode: parsed.mode, payload: parsed.payload, archiveSource: parsed.archiveSource, synthetic: parsed.synthetic, supersedes: parsed.supersedes, now });
  }

  record(kind: RecordKind, req: unknown) {
    if (kind === "forecast") return this.recordInternal(this.forecasts, RecordForecastRequestSchema, kind, req);
    if (kind === "consensus") return this.recordInternal(this.consensus, RecordConsensusRequestSchema, kind, req);
    return this.recordInternal(this.catalysts, RecordCatalystRequestSchema, kind, req);
  }

  async getRecord(kind: RecordKind, id: string) {
    const rec = await this.store(kind).get(id);
    if (!rec) throw new AppError(404, "RECORD_NOT_FOUND", `No ${kind} record ${id}`);
    return rec;
  }

  listRecords(kind: RecordKind) {
    return this.store(kind).list();
  }

  /** Resolves a recordId-or-inline field, enforcing the forward-record lookahead guard against decisionAt. */
  private async resolve<T>(store: JournalStore<T>, ref: { recordId: string } | T, decisionAt: string): Promise<{ value: T; recordEvidenceMode?: EvidenceMode; recordRef?: NonNullable<CandidateInput["recordRefs"]>[string] }> {
    if (!(typeof ref === "object" && ref !== null && "recordId" in ref)) return { value: ref as T };
    const rec = await store.get((ref as { recordId: string }).recordId);
    if (!rec) throw new AppError(404, "RECORD_NOT_FOUND", `No journal record ${(ref as { recordId: string }).recordId}`);
    if (rec.mode === "forward" && epoch(decisionAt) < epoch(rec.recordedAt))
      throw new AppError(422, "FORWARD_RECORD_NOT_YET_AVAILABLE", `Record ${rec.id} was recorded at ${rec.recordedAt}, after the decision time ${decisionAt}; a forward snapshot is only eligible for decisions at or after it was recorded`);
    return { value: rec.payload, recordEvidenceMode: evidenceModeOf(rec), recordRef: { id: rec.id, contentHash: rec.contentHash, recordedAt: rec.recordedAt, mode: evidenceModeOf(rec) } };
  }

  private async resolveCandidate(req: CandidateRequest, decisionAt: string): Promise<CandidateInput> {
    const [forecast, currentConsensus, priorConsensus, catalyst] = await Promise.all([
      this.resolve(this.forecasts, req.forecast, decisionAt),
      this.resolve(this.consensus, req.currentConsensus, decisionAt),
      this.resolve(this.consensus, req.priorConsensus, decisionAt),
      this.resolve(this.catalysts, req.catalyst, decisionAt),
    ]);
    // The forecast record is the authoritative provenance for the candidate's evidence label when it came from the
    // journal; a declared evidenceMode that contradicts it is rejected rather than silently trusted.
    const modes = [forecast, currentConsensus, priorConsensus, catalyst].map((r) => r.recordEvidenceMode ?? (req.evidenceMode === "synthetic" ? "synthetic" : "historical_import_unverified"));
    const effective = modes.includes("synthetic") ? "synthetic" : modes.includes("historical_import_unverified") ? "historical_import_unverified" : "forward";
    if (effective !== req.evidenceMode)
      throw new AppError(422, "EVIDENCE_MODE_MISMATCH", `Candidate ${req.ticker} has ${effective} evidence; all signal inputs must support the declared mode`);
    const recordRefs = Object.fromEntries(Object.entries({ forecast, currentConsensus, priorConsensus, catalyst }).flatMap(([key, r]) => r.recordRef ? [[key, r.recordRef]] : []));
    return { ticker: req.ticker, evidenceMode: req.evidenceMode, forecast: forecast.value, currentConsensus: currentConsensus.value, priorConsensus: priorConsensus.value, catalyst: catalyst.value, diagnostic: req.diagnostic, recordRefs };
  }

  async screen(req: unknown): Promise<ScreenResult> {
    // Validated here (not just at the HTTP boundary): the CLI calls this method directly with raw parsed JSON.
    const parsed = ScreenRequestSchema.parse(req);
    const candidates = await Promise.all(parsed.candidates.map((c) => this.resolveCandidate(c, parsed.decisionAt)));
    return screen(candidates, parsed.config, parsed.decisionAt);
  }

  /**
   * Replay always re-derives the selection from the same screen request rather than trusting a client-echoed
   * ScreenResult: otherwise a caller could tamper with `selected` between screen and replay and silently swap in a
   * ticker that was never actually eligible. This is the only replay entry point for exactly that reason.
   */
  async screenAndReplay(screenReq: unknown, replayInput: unknown): Promise<{ selection: ScreenResult; result: ReplayResult }> {
    const config = StrategyConfigSchema.parse((screenReq as { config: unknown }).config);
    const selection = await this.screen(screenReq);
    const result = runReplay(ReplayInputSchema.parse(replayInput), selection, config, this.opts.now());
    return { selection, result };
  }
}
