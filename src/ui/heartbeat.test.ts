import { afterEach, describe, expect, test, vi } from "vitest";

import { Heartbeat } from "./heartbeat.js";

afterEach(() => {
  vi.useRealTimers();
});

describe("Heartbeat", () => {
  test("runs registered jobs on their own intervals", async () => {
    vi.useFakeTimers();
    const fast = vi.fn();
    const slow = vi.fn();
    const heartbeat = new Heartbeat({ resolutionMs: 100, onError: vi.fn() });
    heartbeat.register({ id: "fast", intervalMs: 200, run: fast });
    heartbeat.register({ id: "slow", intervalMs: 500, run: slow });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(fast).toHaveBeenCalledTimes(5);
    expect(slow).toHaveBeenCalledTimes(2);
    heartbeat.stop();
  });

  test("does not overlap a job that is still running", async () => {
    vi.useFakeTimers();
    let finish: (() => void) | undefined;
    const run = vi.fn(() => new Promise<void>((resolve) => {
      finish = resolve;
    }));
    const heartbeat = new Heartbeat({ resolutionMs: 100, onError: vi.fn() });
    heartbeat.register({ id: "slow", intervalMs: 100, run });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(500);
    expect(run).toHaveBeenCalledTimes(1);

    finish?.();
    await vi.runAllTicks();
    await vi.advanceTimersByTimeAsync(100);
    expect(run).toHaveBeenCalledTimes(2);
    heartbeat.stop();
  });

  test("isolates job failures and reports them", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    const healthy = vi.fn();
    const heartbeat = new Heartbeat({ resolutionMs: 100, onError });
    heartbeat.register({
      id: "failing",
      intervalMs: 100,
      run: () => {
        throw new Error("boom");
      },
    });
    heartbeat.register({ id: "healthy", intervalMs: 100, run: healthy });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(100);

    expect(onError).toHaveBeenCalledWith("failing", expect.objectContaining({ message: "boom" }));
    expect(healthy).toHaveBeenCalledTimes(1);
    heartbeat.stop();
  });

  test("stops scheduling work and rejects duplicate job ids", async () => {
    vi.useFakeTimers();
    const run = vi.fn();
    const heartbeat = new Heartbeat({ resolutionMs: 100, onError: vi.fn() });
    heartbeat.register({ id: "poll", intervalMs: 100, run });
    expect(() => heartbeat.register({ id: "poll", intervalMs: 200, run })).toThrow("already registered");

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(100);
    heartbeat.stop();
    await vi.advanceTimersByTimeAsync(500);

    expect(run).toHaveBeenCalledTimes(1);
  });

  test("aborts in-flight jobs and suppresses their shutdown errors", async () => {
    vi.useFakeTimers();
    const onError = vi.fn();
    let jobSignal: AbortSignal | undefined;
    // eslint-disable-next-line no-unused-vars
    let rejectJob: ((error: Error) => void) | undefined;
    const heartbeat = new Heartbeat({ resolutionMs: 100, onError });
    heartbeat.register({
      id: "poll",
      intervalMs: 100,
      run: (signal) => {
        jobSignal = signal;
        return new Promise<void>((_resolve, reject) => {
          rejectJob = reject;
        });
      },
    });

    heartbeat.start();
    await vi.advanceTimersByTimeAsync(100);
    heartbeat.stop();
    rejectJob?.(new Error("cancelled"));
    await vi.runAllTicks();

    expect(jobSignal?.aborted).toBe(true);
    expect(onError).not.toHaveBeenCalled();
  });
});
