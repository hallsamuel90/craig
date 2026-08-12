import { mkdir, readdir, rm, writeFile } from "node:fs/promises";

import { afterEach, describe, expect, test, vi } from "vitest";

import { configService } from "../src/domain/config/index.js";
import { taskService } from "../src/domain/task/index.js";
import {
  promptCommandService,
  listEvents,
  appendEvent,
  type CreatePromptDispatchInput,
} from "../src/domain/orchestration/index.js";
import { OrchestrationSupervisor, type OrchestrationDeliveryRuntime } from "../src/shell/orchestration-supervisor.js";
import { promptCommandShellService } from "../src/shell/prompt-commands.js";
import { createCraigState, createRepoRoot, writeTaskRecord } from "./test-helpers.js";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("prompt command admission", () => {
  test("fails a persisted prompt explicitly when no orchestration daemon is available and rejects closed tasks", async () => {
    const root = await createRepoRoot("craig-prompt-admission-");
    roots.push(root);
    const paths = await createCraigState(root, ["task_merged", "task_closed"]);
    const merged = await writeTaskRecord(root, { id: "task_merged", status: "merged" });
    const closed = await writeTaskRecord(root, { id: "task_closed", status: "closed" });
    await configService.save(paths, { previews: { agentOrchestration: true } });

    await expect(promptCommandShellService.send(paths, {
      taskId: merged.id,
      prompt: { source: "inline", text: "start the next pull request" },
      delivery: "when-ready",
      timeoutMs: 60_000,
    })).rejects.toMatchObject({
      code: "PARTIAL_RESULT",
      details: { durableState: "failed" },
    });
    expect((await promptCommandService.list(paths, merged.id)).commands).toMatchObject([{
      taskId: merged.id,
      state: "failed",
      attempts: 0,
      lastError: { code: "ORCHESTRATION_UNAVAILABLE", retryable: true },
    }]);

    await expect(promptCommandShellService.send(paths, {
      taskId: closed.id,
      prompt: { source: "inline", text: "this task is finished" },
      delivery: "when-ready",
      timeoutMs: 60_000,
    })).rejects.toMatchObject({
      code: "COMMAND_STATE_CONFLICT",
      details: { taskId: closed.id, taskStatus: "closed" },
    });
  });
});

describe("durable prompt commands", () => {
  test("persists one command for duplicate idempotent requests and rejects conflicting reuse", async () => {
    const { paths, input } = await setupCommand();
    const first = await promptCommandService.create(paths, { ...input, idempotencyKey: "retry-1" });
    const duplicate = await promptCommandService.create(paths, { ...input, idempotencyKey: "retry-1" });

    expect(first.created).toBe(true);
    expect(duplicate).toEqual({ kind: "sendAgentPrompt", command: first.command, created: false });
    await expect(promptCommandService.create(paths, {
      ...input,
      prompt: { source: "inline", text: "different" },
      idempotencyKey: "retry-1",
    })).rejects.toMatchObject({ code: "COMMAND_STATE_CONFLICT", exitCode: 4 });
    expect((await promptCommandService.list(paths)).commands).toHaveLength(1);
  });

  test("rejects unsafe bytes and enforces cancellation as a queued-only terminal transition", async () => {
    const { paths, input } = await setupCommand();
    await expect(promptCommandService.create(paths, {
      ...input,
      prompt: { source: "inline", text: "stop\u0003now" },
    })).rejects.toMatchObject({ code: "CLI_USAGE" });
    await expect(promptCommandService.create(paths, {
      ...input,
      timeoutMs: 86_400_001,
    })).rejects.toMatchObject({ code: "CLI_USAGE" });
    await expect(promptCommandService.create(paths, {
      ...input,
      idempotencyKey: "x".repeat(257),
    })).rejects.toMatchObject({ code: "CLI_USAGE" });
    await expect(promptCommandService.show(paths, "../../outside"))
      .rejects.toMatchObject({ code: "CLI_USAGE" });

    const created = await promptCommandService.create(paths, input);
    const cancelled = await promptCommandService.cancel(paths, created.command.id);
    expect(cancelled).toMatchObject({ changed: true, command: { state: "cancelled" } });
    expect(await promptCommandService.cancel(paths, created.command.id)).toMatchObject({ changed: false });

    const delivering = await promptCommandService.create(paths, { ...input, id: "command_delivering" });
    await promptCommandService.beginDelivery(paths, delivering.command.id);
    await expect(promptCommandService.cancel(paths, delivering.command.id))
      .rejects.toMatchObject({ code: "COMMAND_STATE_CONFLICT", exitCode: 4 });
  });

  test("reports a partial result when command state persists but event append fails", async () => {
    const { paths, input } = await setupCommand();
    await writeFile(`${paths.eventsDir}/segment-0000000000000001.jsonl`, "{bad}\n", "utf8");

    await expect(promptCommandService.create(paths, input)).rejects.toMatchObject({
      code: "PARTIAL_RESULT",
      exitCode: 7,
      details: { durableState: "queued" },
    });
    expect((await promptCommandService.list(paths)).commands).toMatchObject([{ state: "queued" }]);
  });

  test("waits for requested states and reports timeout without mutating the command", async () => {
    const { paths, input } = await setupCommand();
    const created = await promptCommandService.create(paths, input);
    await expect(promptCommandService.wait(paths, created.command.id, { states: ["delivered"], timeoutMs: 5 }))
      .rejects.toMatchObject({ code: "OPERATION_TIMEOUT", exitCode: 6 });
    expect((await promptCommandService.show(paths, created.command.id)).command.state).toBe("queued");
  });

  test("retains journal segments referenced by live commands and releases them after cancellation", async () => {
    const { paths, input } = await setupCommand();
    const created = await promptCommandService.create(paths, input);
    for (let index = 0; index < 2; index += 1) {
      await appendEvent(paths, {
        type: "test.filler",
        actor: input.actor,
        data: { index },
      }, { maxSegmentBytes: 1, maxSegments: 2 });
    }
    expect((await readdir(paths.eventsDir)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(3);
    expect((await listEvents(paths)).events.some((event) => event.commandId === created.command.id)).toBe(true);

    await promptCommandService.cancel(paths, created.command.id);
    await appendEvent(paths, {
      type: "test.after-cancel",
      actor: input.actor,
      data: {},
    }, { maxSegmentBytes: 1, maxSegments: 2 });
    expect((await readdir(paths.eventsDir)).filter((name) => name.endsWith(".jsonl"))).toHaveLength(2);
  });
});

describe("orchestration supervisor", () => {
  test.each(["when-ready", "immediate"] as const)(
    "delivers %s follow-up work to a live merged task",
    async (delivery) => {
      const { paths, input, tabId } = await setupCommand();
      await writeTaskRecord(paths.repoRoot, { id: input.taskId, status: "merged" });
      const created = await promptCommandService.create(paths, { ...input, delivery });
      const runtime = createRuntime(tabId, delivery === "when-ready" ? Date.now() - 10_000 : Date.now());
      const supervisor = new OrchestrationSupervisor(paths, runtime, { intervalMs: 10_000 });
      try {
        await supervisor.start();
        expect(runtime.writeToSession).toHaveBeenCalledTimes(2);
        expect((await promptCommandService.show(paths, created.command.id)).command.state).toBe("delivered");
      } finally {
        await supervisor.stop();
      }
    },
  );

  test("delivers exactly once to the requested ready tab", async () => {
    const { paths, input, tabId } = await setupCommand();
    const created = await promptCommandService.create(paths, input);
    const runtime = createRuntime(tabId, Date.now() - 10_000);
    const supervisor = new OrchestrationSupervisor(paths, runtime, { intervalMs: 10_000 });
    try {
      await supervisor.start();
      expect(runtime.writeToSession).toHaveBeenNthCalledWith(
        1,
        tabId,
        `\u001b[200~${input.prompt.text}\u001b[201~`,
      );
      expect(runtime.writeToSession).toHaveBeenNthCalledWith(2, tabId, "\r");
      expect((await promptCommandService.show(paths, created.command.id)).command)
        .toMatchObject({ state: "delivered", attempts: 1 });
      await supervisor.wake();
      expect(runtime.writeToSession).toHaveBeenCalledTimes(2);
    } finally {
      await supervisor.stop();
    }
  });

  test("promotes a task only after its durable initial prompt is submitted", async () => {
    const { paths, input, tabId } = await setupCommand();
    await writeTaskRecord(paths.repoRoot, { id: input.taskId, status: "draft" });
    const created = await promptCommandService.create(paths, {
      ...input,
      idempotencyKey: `task-start:${input.taskId}`,
    });
    const runtime = createRuntime(tabId, Date.now() - 10_000);
    const supervisor = new OrchestrationSupervisor(paths, runtime, { intervalMs: 10_000 });
    try {
      expect((await taskService.getTask(paths, input.taskId)).status).toBe("draft");
      await supervisor.start();
      expect((await promptCommandService.show(paths, created.command.id)).command)
        .toMatchObject({ state: "delivered", attempts: 1 });
      expect((await taskService.getTask(paths, input.taskId))).toMatchObject({
        status: "running",
        runnerSession: { lastKnownState: "running" },
      });
    } finally {
      await supervisor.stop();
    }
  });

  test("repairs a delivered initial prompt whose task promotion was interrupted", async () => {
    const { paths, input, tabId } = await setupCommand();
    await writeTaskRecord(paths.repoRoot, { id: input.taskId, status: "draft" });
    const created = await promptCommandService.create(paths, {
      ...input,
      idempotencyKey: `task-start:${input.taskId}`,
    });
    await promptCommandService.beginDelivery(paths, created.command.id);
    await promptCommandService.completeDelivery(paths, created.command.id);
    const supervisor = new OrchestrationSupervisor(paths, createRuntime(tabId, Date.now() - 10_000), {
      intervalMs: 10_000,
    });
    try {
      await supervisor.start();
      expect((await taskService.getTask(paths, input.taskId))).toMatchObject({
        status: "running",
        runnerSession: { lastKnownState: "running" },
      });
    } finally {
      await supervisor.stop();
    }
  });

  test("holds when-ready work while busy and delivers after the target becomes ready", async () => {
    const { paths, input, tabId } = await setupCommand();
    const created = await promptCommandService.create(paths, input);
    const runtime = createRuntime(tabId, Date.now());
    const supervisor = new OrchestrationSupervisor(paths, runtime, { intervalMs: 10_000 });
    try {
      await supervisor.start();
      expect(runtime.writeToSession).not.toHaveBeenCalled();
      runtime.getActivitySnapshots = () => [{
        taskId: input.taskId,
        tabId,
        sessionState: "running",
        lastActivityAt: Date.now() - 10_000,
        exitCode: null,
        error: null,
      }];
      await supervisor.wake();
      expect(runtime.writeToSession).toHaveBeenCalledTimes(2);
      expect((await promptCommandService.show(paths, created.command.id)).command.state).toBe("delivered");
    } finally {
      await supervisor.stop();
    }
  });

  test("fails an interrupted delivering command as uncertain and never replays it", async () => {
    const { paths, input, tabId } = await setupCommand();
    const created = await promptCommandService.create(paths, input);
    await promptCommandService.beginDelivery(paths, created.command.id);
    await rm(paths.eventsDir, { recursive: true, force: true });
    await mkdir(paths.eventsDir, { recursive: true });
    const runtime = createRuntime(tabId, Date.now() - 10_000);
    const supervisor = new OrchestrationSupervisor(paths, runtime, { intervalMs: 10_000 });
    try {
      await supervisor.start();
      expect(runtime.writeToSession).not.toHaveBeenCalled();
      expect((await promptCommandService.show(paths, created.command.id)).command).toMatchObject({
        state: "failed",
        lastError: { code: "PROMPT_DELIVERY_UNCERTAIN", deliveryUncertain: true },
      });
      expect((await listEvents(paths)).events.map((event) => event.type)).toEqual([
        "command.queued",
        "command.delivering",
        "command.failed",
      ]);
    } finally {
      await supervisor.stop();
    }
  });

  test("fails closed targets, exited sessions, and expired commands without writing to a PTY", async () => {
    const { paths, input, tabId } = await setupCommand();
    const closed = await promptCommandService.create(paths, input);
    const closedRuntime = createRuntime(tabId, Date.now());
    await writeTaskRecord(paths.repoRoot, { id: input.taskId, status: "closed" });
    const closedSupervisor = new OrchestrationSupervisor(paths, closedRuntime, { intervalMs: 10_000 });
    try {
      await closedSupervisor.start();
      expect((await promptCommandService.show(paths, closed.command.id)).command)
        .toMatchObject({ state: "failed", lastError: { code: "PROMPT_TARGET_UNAVAILABLE" } });
      expect(closedRuntime.writeToSession).not.toHaveBeenCalled();
    } finally {
      await closedSupervisor.stop();
    }

    await writeTaskRecord(paths.repoRoot, { id: input.taskId, status: "merged" });
    const exited = await promptCommandService.create(paths, { ...input, id: "command_exited" });
    const exitedRuntime = createRuntime(tabId, Date.now());
    exitedRuntime.getActivitySnapshots = () => [{
      taskId: input.taskId,
      tabId,
      sessionState: "exited",
      lastActivityAt: Date.now(),
      exitCode: 0,
      error: null,
    }];
    const exitedSupervisor = new OrchestrationSupervisor(paths, exitedRuntime, { intervalMs: 10_000 });
    try {
      await exitedSupervisor.start();
      expect((await promptCommandService.show(paths, exited.command.id)).command)
        .toMatchObject({ state: "failed", lastError: { code: "PROMPT_TARGET_UNAVAILABLE" } });
      expect(exitedRuntime.writeToSession).not.toHaveBeenCalled();
    } finally {
      await exitedSupervisor.stop();
    }

    const expired = await promptCommandService.create(paths, {
      ...input,
      id: "command_expired",
      timeoutMs: 1,
      now: new Date(Date.now() - 1_000),
    });
    const expiredRuntime = createRuntime(tabId, Date.now() - 10_000);
    const expiredSupervisor = new OrchestrationSupervisor(paths, expiredRuntime, { intervalMs: 10_000 });
    try {
      await expiredSupervisor.start();
      expect((await promptCommandService.show(paths, expired.command.id)).command)
        .toMatchObject({ state: "failed", lastError: { code: "PROMPT_DELIVERY_TIMEOUT" } });
      expect(expiredRuntime.writeToSession).not.toHaveBeenCalled();
    } finally {
      await expiredSupervisor.stop();
    }
  });

  test("marks a transport exception uncertain instead of retrying", async () => {
    const { paths, input, tabId } = await setupCommand();
    const created = await promptCommandService.create(paths, { ...input, delivery: "immediate" });
    const runtime = createRuntime(tabId, Date.now());
    runtime.writeToSession.mockImplementation(() => {
      throw new Error("socket closed during write");
    });
    const supervisor = new OrchestrationSupervisor(paths, runtime, { intervalMs: 10_000 });
    try {
      await supervisor.start();
      expect(runtime.writeToSession).toHaveBeenCalledOnce();
      expect((await promptCommandService.show(paths, created.command.id)).command).toMatchObject({
        state: "failed",
        attempts: 1,
        lastError: { code: "PROMPT_DELIVERY_UNCERTAIN", deliveryUncertain: true },
      });
      await supervisor.wake();
      expect(runtime.writeToSession).toHaveBeenCalledOnce();
    } finally {
      await supervisor.stop();
    }
  });

  test("does not report delivery when the separate submit write fails", async () => {
    const { paths, input, tabId } = await setupCommand();
    const created = await promptCommandService.create(paths, { ...input, delivery: "immediate" });
    const runtime = createRuntime(tabId, Date.now());
    runtime.writeToSession
      .mockImplementationOnce(() => undefined)
      .mockImplementationOnce(() => {
        throw new Error("session closed before submit");
      });
    const supervisor = new OrchestrationSupervisor(paths, runtime, { intervalMs: 10_000 });
    try {
      await supervisor.start();
      expect(runtime.writeToSession).toHaveBeenCalledTimes(2);
      expect((await promptCommandService.show(paths, created.command.id)).command).toMatchObject({
        state: "failed",
        attempts: 1,
        deliveredAt: null,
        lastError: { code: "PROMPT_DELIVERY_UNCERTAIN", deliveryUncertain: true },
      });
    } finally {
      await supervisor.stop();
    }
  });

  test("allows only one workspace leader", async () => {
    const { paths, tabId } = await setupCommand();
    const first = new OrchestrationSupervisor(paths, createRuntime(tabId, 0), { intervalMs: 10_000 });
    const second = new OrchestrationSupervisor(paths, createRuntime(tabId, 0), { intervalMs: 10_000 });
    try {
      await first.start();
      await expect(second.start()).rejects.toMatchObject({ code: "COMMAND_STATE_CONFLICT" });
    } finally {
      await first.stop();
      await second.stop();
    }
  });
});

async function setupCommand(): Promise<{
  paths: Awaited<ReturnType<typeof createCraigState>>;
  input: CreatePromptDispatchInput;
  tabId: string;
}> {
  const root = await createRepoRoot("craig-prompt-command-");
  roots.push(root);
  const paths = await createCraigState(root, ["task_1"]);
  const task = await writeTaskRecord(root, { id: "task_1" });
  const tabId = task.ptyTabs.find((tab) => tab.kind === "agent")!.id;
  return {
    paths,
    tabId,
    input: {
      taskId: task.id,
      agentTabId: tabId,
      prompt: { source: "inline", text: "review the current changes" },
      delivery: "when-ready",
      timeoutMs: 60_000,
      actor: { type: "human", source: "cli", processId: 1 },
      now: new Date(),
    },
  };
}

function createRuntime(tabId: string, lastActivityAt: number): OrchestrationDeliveryRuntime & {
  writeToSession: ReturnType<typeof vi.fn>;
} {
  return {
    getActivitySnapshots: () => [{
      taskId: "task_1",
      tabId,
      sessionState: "running",
      lastActivityAt,
      exitCode: null,
      error: null,
    }],
    hasRunningSession: () => true,
    writeToSession: vi.fn(),
  };
}
