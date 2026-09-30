import { randomUUID } from "node:crypto";
import { AppError } from "../errors.js";

// Bounded in-memory job queue. Jobs are LOST on restart (documented). No timer keeps the process alive: finished jobs
// are swept lazily on access, and the only timer (per-job timeout) is unref'd and cleared when the job ends.

export type JobStatus = "queued" | "running" | "completed" | "partial" | "failed";
export type JobKind = "analysis" | "research";
export type JobOutcome = { status: "completed" | "partial" | "failed"; result?: unknown; error?: { code: string; message: string } };

export type Job = {
  id: string;
  kind: JobKind;
  key: string;
  request: Record<string, unknown>;
  status: JobStatus;
  createdAt: number;
  startedAt?: number;
  finishedAt?: number;
  outcome?: JobOutcome;
};

export type JobLimits = {
  maxRunning: number;
  maxPending: number;
  maxRetained: number; // finished jobs kept for polling
  ttlMs: number; // how long a finished job stays retrievable
  jobTimeoutMs: number;
};

export type Work = (ctx: { signal: AbortSignal }) => Promise<JobOutcome>;

export class JobManager {
  private jobs = new Map<string, Job>();
  private queue: { job: Job; work: Work }[] = [];
  private running = new Map<string, { controller: AbortController; done: Promise<void> }>();
  private closed = false;

  constructor(
    private limits: JobLimits,
    private now: () => number = Date.now,
  ) {}

  /** Returns the in-flight job with the same key if there is one (deduplicated), else enqueues a new job. */
  submit(kind: JobKind, key: string, request: Record<string, unknown>, work: Work): { job: Job; deduplicated: boolean } {
    if (this.closed) throw new AppError(503, "SERVER_CLOSING", "Server is shutting down; job not accepted");
    this.sweep();
    for (const j of this.jobs.values()) if (j.key === key && (j.status === "queued" || j.status === "running")) return { job: j, deduplicated: true };
    if (this.running.size >= this.limits.maxRunning && this.queue.length >= this.limits.maxPending)
      throw new AppError(429, "QUEUE_FULL", `Too many jobs in flight (running ${this.running.size}/${this.limits.maxRunning}, pending ${this.queue.length}/${this.limits.maxPending})`, undefined, "Retry later, or poll an existing job.");
    const job: Job = { id: randomUUID(), kind, key, request, status: "queued", createdAt: this.now() };
    this.jobs.set(job.id, job);
    this.queue.push({ job, work });
    this.evictFinished();
    this.pump();
    return { job, deduplicated: false };
  }

  get(id: string, kind: JobKind): Job | undefined {
    this.sweep();
    const j = this.jobs.get(id);
    return j && j.kind === kind ? j : undefined;
  }

  expiresAt(job: Job): number | undefined {
    return job.finishedAt === undefined ? undefined : job.finishedAt + this.limits.ttlMs;
  }

  stats() {
    return { running: this.running.size, pending: this.queue.length, retained: this.jobs.size };
  }

  /** Aborts running jobs, fails queued ones and waits (bounded by each job's own settle) for the runners to finish. */
  async close(): Promise<void> {
    this.closed = true;
    for (const { job } of this.queue.splice(0)) this.finish(job, { status: "failed", error: { code: "SERVER_CLOSING", message: "Server shut down before the job started" } });
    for (const r of this.running.values()) r.controller.abort(new Error("server closing"));
    await Promise.all([...this.running.values()].map((r) => r.done));
  }

  private pump() {
    while (!this.closed && this.running.size < this.limits.maxRunning && this.queue.length > 0) {
      const { job, work } = this.queue.shift()!;
      const controller = new AbortController();
      job.status = "running";
      job.startedAt = this.now();
      // The job is reported as soon as it finishes or is abandoned (timeout), but its slot is released only once the
      // work itself has settled: work that ignores the abort signal can never push concurrency past maxRunning.
      const settled = Promise.resolve().then(() => work({ signal: controller.signal }));
      const done = this.execute(job, settled, controller);
      Promise.allSettled([done, settled]).then(() => {
        this.running.delete(job.id);
        this.pump();
      });
      this.running.set(job.id, { controller, done });
    }
  }

  /** Never rejects: every failure becomes a `failed` outcome. */
  private async execute(job: Job, work: Promise<JobOutcome>, controller: AbortController): Promise<void> {
    const timer = setTimeout(() => controller.abort(new Error("job timeout")), this.limits.jobTimeoutMs);
    timer.unref();
    try {
      const outcome = await new Promise<JobOutcome>((resolve, reject) => {
        const onAbort = () => reject(controller.signal.reason);
        if (controller.signal.aborted) return onAbort();
        controller.signal.addEventListener("abort", onAbort, { once: true });
        work.then(resolve, reject);
      });
      this.finish(job, outcome);
    } catch (e) {
      const closing = this.closed;
      const timeout = controller.signal.aborted && !closing;
      const code = closing ? "SERVER_CLOSING" : timeout ? "JOB_TIMEOUT" : e instanceof AppError ? e.code : "JOB_FAILED";
      const message = closing ? "Server shut down while the job was running" : timeout ? `Job exceeded ${this.limits.jobTimeoutMs} ms and was abandoned` : e instanceof AppError ? e.message : "Job failed unexpectedly";
      this.finish(job, { status: "failed", error: { code, message } });
    } finally {
      clearTimeout(timer);
    }
  }

  private finish(job: Job, outcome: JobOutcome) {
    if (job.finishedAt !== undefined) return;
    job.status = outcome.status;
    job.outcome = outcome;
    job.finishedAt = this.now();
  }

  private sweep() {
    const t = this.now();
    for (const [id, j] of this.jobs) if (j.finishedAt !== undefined && j.finishedAt + this.limits.ttlMs <= t) this.jobs.delete(id);
  }

  private evictFinished() {
    const finished = [...this.jobs.values()].filter((j) => j.finishedAt !== undefined).sort((a, b) => a.finishedAt! - b.finishedAt!);
    while (this.jobs.size > this.limits.maxRetained && finished.length) this.jobs.delete(finished.shift()!.id);
  }
}
