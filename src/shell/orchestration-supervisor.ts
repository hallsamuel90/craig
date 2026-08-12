import { setTimeout as wait } from "node:timers/promises";

import { getTaskAgentTabActivity, type PtyActivitySnapshot } from "../domain/agent/index.js";
import {
  listPromptCommands,
  promptCommandService,
  type PromptCommandError,
  type PromptDispatch,
} from "../domain/orchestration/index.js";
import { taskService } from "../domain/task/index.js";
import { CraigError } from "../domain/error/index.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { Heartbeat } from "./heartbeat.js";
import { acquireOrchestrationLeader, type OrchestrationLeaderLease } from "./orchestration-leader.js";
import { buildRunnerPromptSubmission } from "./prompt-delivery.js";
import { reconcilePromptCommandEvents } from "./command-event-reconciliation.js";
import { reconcileFuryRuns } from "./fury-runtime.js";

export interface OrchestrationDeliveryRuntime {
  getActivitySnapshots(): PtyActivitySnapshot[];
  /* eslint-disable-next-line no-unused-vars */
  hasRunningSession(tabId: string): boolean;
  /* eslint-disable-next-line no-unused-vars */
  writeToSession(tabId: string, input: string): void;
}

export class OrchestrationSupervisor {
  private readonly heartbeat: Heartbeat;
  private lease: OrchestrationLeaderLease | null = null;
  private reconciliation: Promise<void> | null = null;

  /* eslint-disable no-unused-vars */
  constructor(
    private readonly paths: CraigPaths,
    private readonly runtime: OrchestrationDeliveryRuntime,
    options: { intervalMs?: number; onError?: (error: unknown) => void } = {},
  ) {
    /* eslint-enable no-unused-vars */
    const intervalMs = options.intervalMs ?? 250;
    this.heartbeat = new Heartbeat({
      resolutionMs: intervalMs,
      onError: (_jobId, error) => options.onError?.(error),
    });
    this.heartbeat.register({
      id: "orchestration.commands",
      intervalMs,
      run: () => this.reconcile(),
    });
  }

  async start(): Promise<void> {
    if (this.lease) return;
    this.lease = await acquireOrchestrationLeader(this.paths);
    try {
      await this.reconcile();
      this.heartbeat.start();
    } catch (error) {
      await this.lease.release();
      this.lease = null;
      throw error;
    }
  }

  async wake(): Promise<void> {
    await this.reconcile();
  }

  async stop(): Promise<void> {
    this.heartbeat.stop();
    await this.reconciliation?.catch(() => undefined);
    await this.lease?.release();
    this.lease = null;
  }

  private reconcile(): Promise<void> {
    if (this.reconciliation) return this.reconciliation;
    this.reconciliation = this.reconcileCommands().finally(() => {
      this.reconciliation = null;
    });
    return this.reconciliation;
  }

  private async reconcileCommands(): Promise<void> {
    await reconcileFuryRuns(this.paths, { isAgentAvailable: (tabId) => this.runtime.hasRunningSession(tabId) });
    await reconcilePromptCommandEvents(this.paths);
    const commands = await listPromptCommands(this.paths);
    for (const command of commands) {
      await this.reconcileInitialPromptTask(command);
      if (command.state === "delivering") {
        await this.failCommand(command, commandError(
          "PROMPT_DELIVERY_UNCERTAIN",
          "Craig resumed after prompt delivery began; the prompt was not replayed.",
          false,
          true,
        ));
        continue;
      }
      if (command.state !== "queued") continue;
      await this.reconcileCommand(command);
    }
    await reconcileFuryRuns(this.paths, { isAgentAvailable: (tabId) => this.runtime.hasRunningSession(tabId) });
  }

  private async reconcileCommand(command: PromptDispatch): Promise<void> {
    if (Date.now() >= Date.parse(command.expiresAt)) {
      await this.failCommand(command, commandError(
        "PROMPT_DELIVERY_TIMEOUT",
        `Prompt delivery timed out after ${command.timeoutMs}ms.`,
        false,
        false,
      ));
      return;
    }

    const task = await taskService.getTask(this.paths, command.taskId).catch((error: unknown) => {
      if (error instanceof CraigError && error.code === "TASK_NOT_FOUND") return null;
      throw error;
    });
    const tab = task?.ptyTabs.find((candidate) => candidate.id === command.agentTabId);
    if (!task || !tab || tab.kind !== "agent" || task.status === "closed") {
      await this.failCommand(command, commandError(
        "PROMPT_TARGET_UNAVAILABLE",
        `Agent tab ${command.agentTabId} is no longer available in task ${command.taskId}.`,
        false,
        false,
      ));
      return;
    }

    const snapshot = this.runtime.getActivitySnapshots().find((candidate) => candidate.tabId === command.agentTabId);
    if (snapshot && snapshot.sessionState !== "running") {
      await this.failCommand(command, commandError(
        "PROMPT_TARGET_UNAVAILABLE",
        `Agent tab ${command.agentTabId} is no longer running.`,
        false,
        false,
      ));
      return;
    }
    if (!this.runtime.hasRunningSession(command.agentTabId)) return;
    if (command.delivery === "when-ready") {
      const state = getTaskAgentTabActivity(task, command.agentTabId, this.runtime.getActivitySnapshots(), Date.now());
      if (state !== "ready") return;
    }

    await promptCommandService.beginDelivery(this.paths, command.id);
    try {
      const submission = buildRunnerPromptSubmission(tab.runner ?? task.runner, command.prompt.text);
      this.runtime.writeToSession(command.agentTabId, submission.paste);
      await wait(submission.submitDelayMs);
      this.runtime.writeToSession(command.agentTabId, submission.submit);
    } catch (error) {
      await this.failCommand(command, commandError(
        "PROMPT_DELIVERY_UNCERTAIN",
        error instanceof Error ? error.message : "Prompt delivery failed after it began.",
        false,
        true,
      ));
      return;
    }
    const delivered = await promptCommandService.completeDelivery(this.paths, command.id);
    await this.reconcileInitialPromptTask(delivered);
  }

  private async failCommand(command: PromptDispatch, error: PromptCommandError): Promise<void> {
    const failed = await promptCommandService.fail(this.paths, command.id, error);
    await this.reconcileInitialPromptTask(failed);
  }

  private async reconcileInitialPromptTask(command: PromptDispatch): Promise<void> {
    if (!isInitialPrompt(command) || command.state === "queued" || command.state === "delivering") return;
    const task = await taskService.getTask(this.paths, command.taskId).catch((error: unknown) => {
      if (error instanceof CraigError && error.code === "TASK_NOT_FOUND") return null;
      throw error;
    });
    if (!task || task.status === "closed") return;
    if (command.state === "delivered") {
      if (task.status === "draft" || task.runnerSession.lastKnownState === "starting") {
        await taskService.markTaskStarted(this.paths, task.id);
      }
      return;
    }
    if (task.runnerSession.lastKnownState !== "failed") {
      await taskService.recordStartupFailure(
        this.paths,
        task.id,
        command.lastError?.message ?? `Initial prompt ${command.state}.`,
      );
    }
  }
}

const isInitialPrompt = (command: PromptDispatch): boolean =>
  command.idempotencyKey === `task-start:${command.taskId}`;

const commandError = (
  code: string,
  message: string,
  retryable: boolean,
  deliveryUncertain: boolean,
): PromptCommandError => ({ code, message, retryable, deliveryUncertain });
