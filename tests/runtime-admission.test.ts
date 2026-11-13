import { rm } from "node:fs/promises";
import { expect, test, vi } from "vitest";
import { RuntimeAdmissionGate } from "../src/shell/runtime/admission-gate.js";
import { PullRequestSyncSupervisor } from "../src/shell/pull-request-sync-supervisor.js";
import { createCraigState, createRepoRoot, writeTaskRecord } from "./test-helpers.js";

test("draining waits for admitted asynchronous PR synchronization and prevents polling until the new owner starts", async () => {
  const root = await createRepoRoot("craig-poll-drain-");
  const paths = await createCraigState(root, ["task_poll"]);
  const task = await writeTaskRecord(root, { id: "task_poll", status: "running" });
  const gate = new RuntimeAdmissionGate();
  let release!: () => void;
  const blocked = new Promise<void>((resolve) => { release = resolve; });
  let active = 0; let maximum = 0;
  const sync = vi.fn(async () => { active++; maximum = Math.max(maximum, active); await blocked; active--; return [task]; });
  const dependencies = { listTasks: async () => [task], syncTasks: sync };
  const old = new PullRequestSyncSupervisor(paths, { dependencies, admit: (work) => gate.background(work) });
  const next = new PullRequestSyncSupervisor(paths, { dependencies });
  const pending = old.wake();
  try {
    await vi.waitFor(() => expect(sync).toHaveBeenCalledOnce());
    const draining = gate.drain();
    expect(gate.pendingCount).toBe(1);
    release(); await pending; await draining;
    await old.wake(); expect(sync).toHaveBeenCalledOnce();
    await old.stop(); await next.wake();
    expect(sync).toHaveBeenCalledTimes(2); expect(maximum).toBe(1);
  } finally { release(); await pending; await old.stop(); await next.stop(); await rm(root, { recursive: true, force: true }); }
});
