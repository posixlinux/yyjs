export type Issue = { code: string; path: string; message: string };

/** Error with a stable HTTP status + machine code. Messages must never contain secrets. */
export class AppError extends Error {
  constructor(
    readonly status: 400 | 401 | 404 | 413 | 422 | 429 | 502 | 503,
    readonly code: string,
    message: string,
    readonly details?: unknown,
    readonly hint?: string,
  ) {
    super(message);
  }
}

export const dataError = (issues: Issue[], message = "Dataset failed validation"): AppError =>
  new AppError(422, "DATA_VALIDATION_FAILED", message, issues, "Fix the listed issues and re-submit; see GET /v1/schema.");
