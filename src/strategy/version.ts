// "earnings-gap-auto/v1" is a historical version identifier only. The original v1 design restricted candidates to
// a single declared sector; that restriction was removed (candidates and their sectors are user-chosen; see
// config.ts StrategyConfigSchema.sector and schema.ts EarningsForecastSnapshotSchema.sector). The string is kept
// unchanged so old saved records/configDigest values stay reproducible.
export const STRATEGY_VERSION = "earnings-gap-auto/v1";
