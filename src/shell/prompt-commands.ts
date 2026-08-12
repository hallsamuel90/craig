import { readFile } from "node:fs/promises";

import { configService } from "../domain/config/index.js";
import { CraigError } from "../domain/error/index.js";
import {
  promptCommandService,
  type CommandCancelPromptResult,
  type CommandListPromptsResult,
  type CommandSendAgentPromptResult,
  type CommandShowPromptResult,
  type CommandWaitPromptResult,
  type PromptCommandState,
  type PromptDelivery,
} from "../domain/orchestration/index.js";
import { taskService } from "../domain/task/index.js";
import type { CraigPaths } from "../state/craig-paths.js";
import { wakeOrchestrationSupervisor } from "./pty-daemon-orchestration.js";

export type PromptInput =
  | { source: "inline"; text: string }
  | { source: "file"; path: string }
  | { source: "stdin" };

export async function sendAgentPrompt(
  paths: CraigPaths,
  input: {
    taskId: string;
    tabId?: string;
    prompt: PromptInput;
    delivery: PromptDelivery;
    timeoutMs: number;
    idempotencyKey?: string;
    readStdin?: () => Promise<string>;
  },
): Promise<CommandSendAgentPromptResult> {
  await assertCreationEnabled(paths);
  const task = await taskService.getTask(paths, input.taskId);
  if (task.status === "closed") {
    throw new CraigError("COMMAND_STATE_CONFLICT", `Task ${task.id} is ${task.status} and cannot receive prompts.`, {
      details: { taskId: task.id, taskStatus: task.status },
    });
  }
  const agentTabs = task.ptyTabs.filter((tab) => tab.kind === "agent");
  const tab = input.tabId
    ? agentTabs.find((candidate) => candidate.id === input.tabId)
    : agentTabs[0];
  if (!tab) {
    throw new CraigError(
      "TASK_CONTEXT_CONFLICT",
      input.tabId
        ? `Agent tab ${input.tabId} does not belong to task ${task.id}.`
        : `Task ${task.id} has no agent tab.`,
      { details: { taskId: task.id, tabId: input.tabId ?? null } },
    );
  }
  const prompt = await resolvePrompt(input.prompt, input.readStdin);
  let result: CommandSendAgentPromptResult;
  try {
    result = await promptCommandService.create(paths, {
      taskId: task.id,
      agentTabId: tab.id,
      prompt,
      delivery: input.delivery,
      timeoutMs: input.timeoutMs,
      idempotencyKey: input.idempotencyKey ?? null,
      actor: { type: "human", source: "cli", processId: process.pid },
    });
  } catch (error) {
    await wakeOrchestrationSupervisor(paths);
    throw error;
  }
  await requirePromptCommandWake(paths, result.command.id);
  return result;
}

export async function requirePromptCommandWake(paths: CraigPaths, commandId: string): Promise<void> {
  const current = (await promptCommandService.show(paths, commandId)).command;
  if (current.state === "delivered") return;
  if (await wakeOrchestrationSupervisor(paths)) return;
  const command = (await promptCommandService.show(paths, commandId)).command;
  if (command.state === "delivered") return;
  const failed = command.state === "queued"
    ? await promptCommandService.fail(paths, command.id, {
        code: "ORCHESTRATION_UNAVAILABLE",
        message: "Craig could not wake the workspace orchestration supervisor.",
        retryable: true,
        deliveryUncertain: false,
      })
    : command;
  throw new CraigError(
    "PARTIAL_RESULT",
    `Command ${command.id} was persisted as ${failed.state}, but Craig could not start prompt delivery.`,
    {
      retryable: true,
      details: { commandId: command.id, durableState: failed.state },
    },
  );
}

export async function showPromptCommand(paths: CraigPaths, commandId: string): Promise<CommandShowPromptResult> {
  return promptCommandService.show(paths, commandId);
}

export async function listPromptCommandRecords(paths: CraigPaths, taskId?: string): Promise<CommandListPromptsResult> {
  return promptCommandService.list(paths, taskId);
}

export async function cancelPromptCommandRecord(paths: CraigPaths, commandId: string): Promise<CommandCancelPromptResult> {
  let result: CommandCancelPromptResult;
  try {
    result = await promptCommandService.cancel(paths, commandId, {
      type: "human",
      source: "cli",
      processId: process.pid,
    });
  } catch (error) {
    await wakeOrchestrationSupervisor(paths);
    throw error;
  }
  await wakeOrchestrationSupervisor(paths);
  return result;
}

export async function waitForPromptCommand(
  paths: CraigPaths,
  commandId: string,
  options: { states?: PromptCommandState[]; timeoutMs: number; signal?: AbortSignal },
): Promise<CommandWaitPromptResult> {
  return promptCommandService.wait(paths, commandId, options);
}

async function resolvePrompt(
  input: PromptInput,
  readStdin: (() => Promise<string>) | undefined,
): Promise<{ source: "inline" | "file" | "stdin"; text: string }> {
  if (input.source === "inline") return input;
  if (input.source === "file") {
    try {
      return { source: "file", text: await readFile(input.path, "utf8") };
    } catch (error) {
      throw new CraigError("CLI_USAGE", `Unable to read prompt file ${input.path}.`, {
        details: { promptFile: input.path },
        cause: error,
      });
    }
  }
  if (!readStdin) {
    throw new CraigError("INPUT_REQUIRED", "Prompt input from stdin is unavailable.", {});
  }
  return { source: "stdin", text: await readStdin() };
}

async function assertCreationEnabled(paths: CraigPaths): Promise<void> {
  const config = await configService.load(paths);
  if (!configService.previews.isEnabled(config, "agentOrchestration")) {
    throw new CraigError(
      "CLI_USAGE",
      "Prompt dispatch is a feature preview. Enable agentOrchestration before sending prompts.",
      { details: { preview: "agentOrchestration" } },
    );
  }
}

export const promptCommandShellService = {
  send: sendAgentPrompt,
  show: showPromptCommand,
  list: listPromptCommandRecords,
  cancel: cancelPromptCommandRecord,
  wait: waitForPromptCommand,
};
