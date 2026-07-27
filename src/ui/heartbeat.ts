export interface HeartbeatJob {
  id: string;
  intervalMs: number;
  /* eslint-disable-next-line no-unused-vars */
  run: (signal: AbortSignal) => void | Promise<void>;
}

export interface HeartbeatOptions {
  resolutionMs?: number;
  now?: () => number;
  /* eslint-disable-next-line no-unused-vars */
  onError: (jobId: string, error: unknown) => void | Promise<void>;
}

interface ScheduledHeartbeatJob extends HeartbeatJob {
  inFlight: boolean;
  nextRunAt: number | null;
}

const DEFAULT_RESOLUTION_MS = 1_000;

export class Heartbeat {
  private readonly jobs = new Map<string, ScheduledHeartbeatJob>();
  private resolutionMs: number;
  private readonly now: () => number;
  private readonly onError: HeartbeatOptions["onError"];
  private timer: ReturnType<typeof setInterval> | null = null;
  private abortController: AbortController | null = null;

  constructor(options: HeartbeatOptions) {
    this.resolutionMs = requirePositiveInterval(options.resolutionMs ?? DEFAULT_RESOLUTION_MS, "Heartbeat resolution");
    this.now = options.now ?? Date.now;
    this.onError = options.onError;
  }

  register(job: HeartbeatJob): void {
    if (this.jobs.has(job.id)) {
      throw new Error(`Heartbeat job "${job.id}" is already registered.`);
    }

    const scheduledJob: ScheduledHeartbeatJob = {
      ...job,
      intervalMs: requirePositiveInterval(job.intervalMs, `Heartbeat job "${job.id}" interval`),
      inFlight: false,
      nextRunAt: this.timer ? this.now() + job.intervalMs : null,
    };
    this.jobs.set(job.id, scheduledJob);
  }

  start(): void {
    if (this.timer) {
      return;
    }

    const startedAt = this.now();
    for (const job of this.jobs.values()) {
      job.nextRunAt = startedAt + job.intervalMs;
    }
    this.abortController = new AbortController();
    this.timer = setInterval(() => this.tick(), this.resolutionMs);
  }

  stop(): void {
    this.abortController?.abort();
    this.abortController = null;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
    for (const job of this.jobs.values()) {
      job.nextRunAt = null;
    }
  }

  setResolutionMs(resolutionMs: number): void {
    const nextResolutionMs = requirePositiveInterval(resolutionMs, "Heartbeat resolution");
    if (nextResolutionMs === this.resolutionMs) {
      return;
    }
    this.resolutionMs = nextResolutionMs;
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = setInterval(() => this.tick(), this.resolutionMs);
    }
  }

  private tick(): void {
    const signal = this.abortController?.signal;
    if (!signal) {
      return;
    }

    const currentTime = this.now();
    for (const job of this.jobs.values()) {
      if (job.inFlight || job.nextRunAt === null || currentTime < job.nextRunAt) {
        continue;
      }

      job.inFlight = true;
      job.nextRunAt = currentTime + job.intervalMs;
      void Promise.resolve()
        .then(() => job.run(signal))
        .catch((error: unknown) => {
          if (!signal.aborted) {
            return Promise.resolve(this.onError(job.id, error)).catch(() => undefined);
          }
          return undefined;
        })
        .finally(() => {
          job.inFlight = false;
        });
    }
  }
}

function requirePositiveInterval(value: number, label: string): number {
  if (!Number.isFinite(value) || value <= 0) {
    throw new Error(`${label} must be a positive number.`);
  }
  return value;
}
