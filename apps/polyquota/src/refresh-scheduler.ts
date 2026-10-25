import type {
  PublicError,
  PublicRefreshSchedulerState,
  RefreshBatchOutcomeDto,
} from "@astra-conductor/polyquota-contract";

export type RefreshSource = RefreshBatchOutcomeDto["source"];

interface TimerPort {
  set(callback: () => void, delayMs: number): unknown;
  clear(handle: unknown): void;
}

const nodeTimers: TimerPort = {
  set: (callback, delayMs) => setTimeout(callback, delayMs),
  clear: (handle) => clearTimeout(handle as NodeJS.Timeout),
};

function defaultError(error: unknown): PublicError {
  return {
    code: "internal",
    message: error instanceof Error ? "刷新调度执行失败" : "刷新调度发生未知错误",
    retryable: false,
  };
}

export class RefreshScheduler {
  private timer: unknown | null = null;
  private activeBatch: Promise<RefreshBatchOutcomeDto> | null = null;
  private accepting = true;
  private started = false;
  private settings = { pollingEnabled: false, pollingIntervalMinutes: 15 };
  private state: PublicRefreshSchedulerState = {
    status: "disabled",
    intervalMinutes: 15,
    nextRunAt: null,
    lastRunStartedAt: null,
    lastRunFinishedAt: null,
    lastResult: null,
  };

  constructor(
    private readonly execute: (source: RefreshSource) => Promise<RefreshBatchOutcomeDto>,
    private readonly onStateChanged: () => void,
    private readonly now: () => Date = () => new Date(),
    private readonly timers: TimerPort = nodeTimers,
    private readonly toError: (error: unknown) => PublicError = defaultError,
  ) {}

  start(settings: { pollingEnabled: boolean; pollingIntervalMinutes: number }): void {
    if (this.started) throw new Error("Refresh scheduler is already started");
    this.started = true;
    this.accepting = true;
    this.configure(settings);
  }

  configure(settings: { pollingEnabled: boolean; pollingIntervalMinutes: number }): void {
    this.settings = { ...settings };
    this.clearTimer();
    this.state = {
      ...this.state,
      status: settings.pollingEnabled ? (this.activeBatch ? "running" : "waiting") : "disabled",
      intervalMinutes: settings.pollingIntervalMinutes,
      nextRunAt: null,
    };
    if (this.accepting && settings.pollingEnabled && !this.activeBatch) this.scheduleNext();
    this.onStateChanged();
  }

  getState(): PublicRefreshSchedulerState {
    return structuredClone(this.state);
  }

  run(source: RefreshSource): Promise<RefreshBatchOutcomeDto> {
    if (!this.accepting) {
      return Promise.reject(new Error("Refresh scheduler is stopping"));
    }
    if (this.activeBatch) return this.activeBatch;
    this.clearTimer();
    const startedAt = this.now().toISOString();
    this.state = {
      ...this.state,
      status: "running",
      nextRunAt: null,
      lastRunStartedAt: startedAt,
    };
    this.onStateChanged();

    const operation = this.execute(source)
      .then((batch) => {
        const succeeded = batch.outcomes.filter((outcome) => outcome.status === "updated").length;
        const skipped = batch.outcomes.filter((outcome) => outcome.status === "skipped").length;
        const failed = batch.outcomes.filter((outcome) => outcome.status === "failed").length;
        this.state = {
          ...this.state,
          lastRunFinishedAt: this.now().toISOString(),
          lastResult: { source: batch.source, succeeded, skipped, failed, error: null },
        };
        return batch;
      })
      .catch((error: unknown) => {
        this.state = {
          ...this.state,
          lastRunFinishedAt: this.now().toISOString(),
          lastResult: {
            source,
            succeeded: 0,
            skipped: 0,
            failed: 0,
            error: this.toError(error),
          },
        };
        throw error;
      })
      .finally(() => {
        this.activeBatch = null;
        if (!this.accepting) {
          this.state = { ...this.state, status: "stopped", nextRunAt: null };
        } else if (!this.settings.pollingEnabled) {
          this.state = { ...this.state, status: "disabled", nextRunAt: null };
        } else {
          this.state = { ...this.state, status: "waiting" };
          this.scheduleNext();
        }
        this.onStateChanged();
      });
    this.activeBatch = operation;
    return operation;
  }

  resume(): void {
    if (!this.accepting || !this.settings.pollingEnabled || this.activeBatch) return;
    const nextRunAt = this.state.nextRunAt ? Date.parse(this.state.nextRunAt) : Number.NaN;
    if (!Number.isFinite(nextRunAt) || nextRunAt <= this.now().getTime()) {
      void this.run("automatic").catch((error: unknown) => {
        console.warn("Automatic refresh after resume failed", this.toError(error).code);
      });
      return;
    }
    this.clearTimer();
    this.scheduleAt(nextRunAt);
    this.onStateChanged();
  }

  async stopAndDrain(): Promise<void> {
    this.accepting = false;
    this.clearTimer();
    this.state = { ...this.state, status: "stopped", nextRunAt: null };
    this.onStateChanged();
    if (this.activeBatch) await Promise.allSettled([this.activeBatch]);
  }

  private scheduleNext(): void {
    const target = this.now().getTime() + this.settings.pollingIntervalMinutes * 60_000;
    this.scheduleAt(target);
  }

  private scheduleAt(target: number): void {
    this.state = { ...this.state, nextRunAt: new Date(target).toISOString() };
    this.timer = this.timers.set(
      () => {
        this.timer = null;
        void this.run("automatic").catch((error: unknown) => {
          console.warn("Automatic refresh failed", this.toError(error).code);
        });
      },
      Math.max(0, target - this.now().getTime()),
    );
  }

  private clearTimer(): void {
    if (this.timer !== null) this.timers.clear(this.timer);
    this.timer = null;
  }
}
