import path from "node:path";
import { readFile } from "node:fs/promises";

import type { CommandResult, AppCommand } from "./types.js";
import type { CraigPaths } from "../state/craig-paths.js";
import type { ResolvedTaskContext } from "../domain/task/index.js";
import type { ResolvedWorkspaceContext } from "../domain/workspace/index.js";
import { getDefaultUiState, readUiState, writeUiState } from "../state/ui-state-store.js";
import { getHelpText } from "./parse-argv.js";
import { taskService } from "../domain/task/index.js";
import { listWorkspaceRecords, workspaceService } from "../domain/workspace/index.js";
import { agentStatusService } from "../shell/agent-status.js";
import { eventService } from "../shell/events.js";
import { promptCommandShellService } from "../shell/prompt-commands.js";
import type { CraigActor, CraigEvent } from "../domain/orchestration/index.js";
import { createRootTask, listTaskChildren, validateFuryFile } from "../domain/orchestration/index.js";
import { cancelTaskTreeAndSessions, createChildTaskAndSession } from "../shell/delegation.js";
import { configService } from "../domain/config/index.js";
import { CraigError } from "../domain/error/index.js";
import { furyRuntimeService } from "../shell/fury-runtime.js";

export interface CommandContext {
  paths: CraigPaths;
  selectedTaskId?: string | null;
  workspaceContext?: ResolvedWorkspaceContext;
  taskContext?: ResolvedTaskContext | null;
  signal?: AbortSignal;
  /* eslint-disable-next-line no-unused-vars */
  emitEvent?: (event: CraigEvent) => void;
  readStdin?: () => Promise<string>;
  agentCapabilityId?: string;
  agentContext?: boolean;
  cwd?: string;
}

export async function executeCommand(
  command: AppCommand,
  context: CommandContext,
): Promise<CommandResult> {
  switch (command.kind) {
    case "addWorkspace": {
      const result = await workspaceService.addWorkspace(context.paths, command.path);
      const selectedRepoId = result.workspace.kind === "project"
        ? (result.workspace.discoveredRepoIds?.[0] ?? null)
        : result.repos[0]?.id ?? null;
      await selectWorkspaceInUi(context.paths, result.workspace.id, selectedRepoId);
      return result;
    }
    case "addRepo": {
      const result = await workspaceService.repos.addRepo(context.paths, command.path);
      await selectWorkspaceInUi(context.paths, result.workspaceId, result.repo.id);
      return result;
    }
    case "listRepos":
      return workspaceService.repos.listRegisteredRepos(context.paths);
    case "removeRepo": {
      const ui = await readUiState({ uiStateFile: context.paths.uiStateFile });
      const affectedWorkspaceIds = ui?.selectedWorkspaceId
        ? (await listWorkspaceRecords(context.paths))
            .filter((w) => w.primaryRepoId === command.repoId)
            .map((w) => w.id)
        : [];
      const result = await workspaceService.repos.removeRepo(context.paths, command.repoId, { listTasks: taskService.listTasks });
      if (ui) {
        const workspaceCleared = affectedWorkspaceIds.includes(ui.selectedWorkspaceId ?? "");
        const repoCleared = ui.selectedRepoId === command.repoId;
        if (workspaceCleared) {
          await writeUiState({ uiStateFile: context.paths.uiStateFile }, { ...ui, selectedRepoId: null, selectedWorkspaceId: null, selectedTaskId: null });
        } else if (repoCleared) {
          await writeUiState({ uiStateFile: context.paths.uiStateFile }, { ...ui, selectedRepoId: null });
        }
      }
      return result;
    }
    case "listWorkspaces":
      return workspaceService.listWorkspaces(context.paths, { archived: command.archived });
    case "archiveWorkspace": {
      const result = await workspaceService.archiveWorkspace(context.paths, command.workspaceId);
      await clearWorkspaceInUi(context.paths, command.workspaceId);
      return result;
    }
    case "restoreWorkspace": {
      const result = await workspaceService.restoreWorkspace(context.paths, command.workspaceId);
      await selectWorkspaceInUi(context.paths, command.workspaceId, result.primaryRepoId);
      return result;
    }
    case "removeWorkspace":
      return workspaceService.removeWorkspace(context.paths, command.workspaceId, { listTasks: taskService.listTasks });
    case "createTask":
      return createRootTask(
        context.paths,
        command.repoId ?? command.workspaceId ?? "",
        command.prompt,
        { ...(command.runner ? { runner: command.runner } : {}), ...(command.workspaceId ? { workspaceId: command.workspaceId } : {}) },
      );
    case "createChildTask": {
      const config = await configService.load(context.paths);
      if (!configService.previews.isEnabled(config, "agentOrchestration")) {
        throw new CraigError(
          "CLI_USAGE",
          "Child delegation is a feature preview. Enable agentOrchestration before creating child tasks.",
          { details: { preview: "agentOrchestration" } },
        );
      }
      assertScopedAgent(context);
      return createChildTaskAndSession(context.paths, {
        parentTaskId: command.parentTaskId ?? requireResolvedTaskContext(context).task.id,
        ...(command.repoId ? { repoId: command.repoId } : {}),
        ...(command.workspaceId ? { workspaceId: command.workspaceId } : {}),
        prompt: command.prompt,
        ...(command.runner ? { runner: command.runner } : {}),
        ...(command.idempotencyKey ? { idempotencyKey: command.idempotencyKey } : {}),
        ...(context.agentCapabilityId ? { capabilityId: context.agentCapabilityId } : {}),
      });
    }
    case "listTaskChildren":
      assertScopedAgent(context);
      return listTaskChildren(
        context.paths,
        command.taskId ?? requireResolvedTaskContext(context).task.id,
        context.agentCapabilityId,
      );
    case "cancelTaskTree":
      assertScopedAgent(context);
      return cancelTaskTreeAndSessions(
        context.paths,
        command.taskId ?? requireResolvedTaskContext(context).task.id,
        context.agentCapabilityId,
      );
    case "validateFury":
      await assertFuryPreview(context);
      return validateFuryFile(path.resolve(context.cwd ?? process.cwd(), command.file));
    case "planFury":
      await assertFuryPreview(context);
      return furyRuntimeService.plan(
        context.paths,
        path.resolve(context.cwd ?? process.cwd(), command.file),
        command.inputs,
        command.rootTaskId ?? requireResolvedTaskContext(context).task.id,
        commandActor(context),
        context.agentCapabilityId,
      );
    case "approveFury":
      return furyRuntimeService.approve(context.paths, command.planId, commandActor(context));
    case "runFury":
      assertScopedAgent(context);
      return furyRuntimeService.run(
        context.paths,
        command.planId,
        commandActor(context),
        context.agentCapabilityId,
      );
    case "showFury":
      return furyRuntimeService.show(context.paths, command.runId);
    case "watchFury":
      return furyRuntimeService.watch(context.paths, command.runId, command.after, {
        ...(context.signal ? { signal: context.signal } : {}),
        onEvent: context.emitEvent ?? (() => undefined),
      });
    case "cancelFury":
      return furyRuntimeService.cancel(context.paths, command.runId, commandActor(context), context.agentCapabilityId);
    case "resumeFury":
      return furyRuntimeService.resume(context.paths, command.runId, commandActor(context), context.agentCapabilityId);
    case "completeFuryStep":
      assertScopedAgent(context);
      return furyRuntimeService.completeStep(
        context.paths, command.runId, command.stepId, await resolveFuryOutput(command.output, context),
        commandActor(context), context.agentCapabilityId,
      );
    case "failFuryStep":
      assertScopedAgent(context);
      return furyRuntimeService.failStep(
        context.paths, command.runId, command.stepId, command.reason, commandActor(context), context.agentCapabilityId,
      );
    case "listFuryReviews":
      return furyRuntimeService.listReviews(context.paths, command.runId, command.state);
    case "showFuryReview":
      return furyRuntimeService.showReview(context.paths, command.reviewId);
    case "actFuryReview":
      assertScopedAgent(context);
      return furyRuntimeService.actOnReview(
        context.paths, command.reviewId, command.action, command.message ?? null,
        commandActor(context), context.agentCapabilityId,
      );
    case "listTasks":
      return command.repoId || command.workspaceId
        ? taskService.listTasks(context.paths, { ...(command.repoId ? { repoId: command.repoId } : {}), ...(command.workspaceId ? { workspaceId: command.workspaceId } : {}) })
        : taskService.listTasks(context.paths);
    case "currentTask": {
      const taskContext = requireResolvedTaskContext(context);
      return {
        kind: "currentTask",
        task: taskContext.task,
        context: {
          source: taskContext.source,
          agentTabId: taskContext.agentTabId,
        },
      };
    }
    case "attachTask":
      return taskService.attachTask(context.paths, command.taskId);
    case "addTaskLink":
      return taskService.addTaskLink(context.paths, command.taskId, command.repoId);
    case "listTaskLinks":
      return taskService.listTaskLinks(context.paths, command.taskId);
    case "refreshInteractiveState":
      throw new Error("Interactive refresh should be handled by the interactive app.");
    case "showTask":
      return taskService.showTask(context.paths, command.taskId);
    case "showCurrentTask":
      return taskService.showTask(context.paths, requireResolvedTaskContext(context).task.id);
    case "showTaskPr":
      return taskService.prs.show(
        context.paths,
        resolveCommandTaskId(command.taskId, context),
        command.repoId,
      );
    case "discoverTaskPr":
      return taskService.prs.discover(
        context.paths,
        resolveCommandTaskId(command.taskId, context),
        command.repoId,
      );
    case "linkTaskPr":
      return taskService.prs.link(
        context.paths,
        resolveCommandTaskId(command.taskId, context),
        command.pullRequest,
        command.repoId,
      );
    case "refreshTaskPr":
      return taskService.prs.refreshAssociation(
        context.paths,
        resolveCommandTaskId(command.taskId, context),
        command.repoId,
      );
    case "unlinkTaskPr":
      return taskService.prs.unlink(
        context.paths,
        resolveCommandTaskId(command.taskId, context),
        command.pullRequest,
        command.repoId,
      );
    case "listAgents":
      return agentStatusService.listAgents(context.paths, command.taskId);
    case "showAgentStatus":
      return agentStatusService.showAgentStatus(context.paths, {
        ...(command.taskId ? { taskId: command.taskId } : {}),
        ...(command.tabId ? { tabId: command.tabId } : {}),
      });
    case "waitTask": {
      const options = {
        states: command.states,
        timeoutMs: command.timeoutMs,
        ...(command.tabId ? { tabId: command.tabId } : {}),
        ...(context.signal ? { signal: context.signal } : {}),
      };
      const taskId = resolveCommandTaskId(command.taskId, context);
      const config = await configService.load(context.paths);
      return configService.previews.isEnabled(config, "agentOrchestration")
        ? eventService.waitForTaskState(context.paths, taskId, options)
        : agentStatusService.waitForTask(context.paths, taskId, options);
    }
    case "listEvents":
      return eventService.list(context.paths, {
        ...(command.taskId ? { taskId: command.taskId } : {}),
        ...(command.typeGlob ? { typeGlob: command.typeGlob } : {}),
        ...(command.after ? { after: command.after } : {}),
      });
    case "watchEvents":
      return eventService.watch(
        context.paths,
        {
          ...(command.taskId ? { taskId: command.taskId } : {}),
          ...(command.typeGlob ? { typeGlob: command.typeGlob } : {}),
          ...(command.after ? { after: command.after } : {}),
        },
        {
          onEvent: context.emitEvent ?? (() => undefined),
          ...(context.signal ? { signal: context.signal } : {}),
        },
      );
    case "sendAgentPrompt":
      return promptCommandShellService.send(context.paths, {
        taskId: resolveCommandTaskId(command.taskId, context),
        ...(command.tabId
          ? { tabId: command.tabId }
          : context.taskContext?.agentTabId
            ? { tabId: context.taskContext.agentTabId }
            : {}),
        prompt: command.prompt,
        delivery: command.delivery,
        timeoutMs: command.timeoutMs,
        ...(command.idempotencyKey ? { idempotencyKey: command.idempotencyKey } : {}),
        ...(context.readStdin ? { readStdin: context.readStdin } : {}),
      });
    case "showPromptCommand":
      return promptCommandShellService.show(context.paths, command.commandId);
    case "listPromptCommands":
      return promptCommandShellService.list(context.paths, command.taskId);
    case "cancelPromptCommand":
      return promptCommandShellService.cancel(context.paths, command.commandId);
    case "waitPromptCommand":
      return promptCommandShellService.wait(context.paths, command.commandId, {
        ...(command.states ? { states: command.states } : {}),
        timeoutMs: command.timeoutMs,
        ...(context.signal ? { signal: context.signal } : {}),
      });
    case "showSelectedTask":
      return taskService.showTask(context.paths, requireSelectedTaskId(context, "show"));
    case "streamTaskLogs":
      return taskService.prepareTaskLogs(context.paths, command.taskId);
    case "streamSelectedTaskLogs":
      return taskService.prepareTaskLogs(context.paths, requireSelectedTaskId(context, "logs"));
    case "showTaskDiff":
      return taskService.showTaskDiff(context.paths, command.taskId);
    case "showSelectedTaskDiff":
      return taskService.showTaskDiff(context.paths, requireSelectedTaskId(context, "diff"));
    case "focusTask":
      return taskService.focusTask(context.paths, command.taskId);
    case "focusSelectedTask":
      return taskService.focusTask(context.paths, requireSelectedTaskId(context, "focus"));
    case "openTask":
      return taskService.openTask(context.paths, command.taskId);
    case "openSelectedTask":
      return taskService.openTask(context.paths, requireSelectedTaskId(context, "open"));
    case "runChecks":
      return taskService.runChecks(context.paths, command.taskId);
    case "runSelectedTaskChecks":
      return taskService.runChecks(context.paths, requireSelectedTaskId(context, "check"));
    case "commitTask":
      return taskService.commitTask(context.paths, command.taskId);
    case "commitSelectedTask":
      return taskService.commitTask(context.paths, requireSelectedTaskId(context, "commit"));
    case "showContext": {
      const workspace = requireWorkspaceContext(context);
      return {
        kind: "showContext",
        workspace: {
          root: workspace.workspaceRoot,
          source: workspace.source,
          initialized: workspace.initialized,
        },
        task: context.taskContext
          ? {
              id: context.taskContext.task.id,
              source: context.taskContext.source,
              agentTabId: context.taskContext.agentTabId,
            }
          : null,
      };
    }
    case "help":
      return { kind: "help", text: getHelpText() };
    case "exit":
      return { kind: "exit" };
    default:
      return assertNever(command);
  }
}

function assertScopedAgent(context: CommandContext): void {
  if (!context.agentContext || context.agentCapabilityId) return;
  throw new CraigError(
    "CAPABILITY_DENIED",
    "This agent session has no delegation capability. Restart the agent session to receive one.",
    { details: { reason: "agent capability is missing" } },
  );
}

async function assertFuryPreview(context: CommandContext): Promise<void> {
  const config = await configService.load(context.paths);
  if (configService.previews.isEnabled(config, "agentOrchestration")) return;
  throw new CraigError(
    "CLI_USAGE",
    "Fury planning is a feature preview. Enable agentOrchestration before validating or planning a fury.",
    { details: { preview: "agentOrchestration" } },
  );
}

function commandActor(context: CommandContext): CraigActor {
  if (!context.agentContext) return { type: "human", source: "cli", processId: process.pid };
  const task = requireResolvedTaskContext(context);
  if (!context.agentCapabilityId || !task.agentTabId) {
    throw new CraigError("CAPABILITY_DENIED", "This agent session has no scoped capability.", {});
  }
  return {
    type: "agent", taskId: task.task.id, agentTabId: task.agentTabId,
    capabilityId: context.agentCapabilityId.split(".", 1)[0]!,
  };
}

async function resolveFuryOutput(
  input: Extract<AppCommand, { kind: "completeFuryStep" }>["output"],
  context: CommandContext,
): Promise<unknown> {
  if (!input) return null;
  let text: string;
  if (input.source === "inline") text = input.text;
  else if (input.source === "file") text = await readFile(path.resolve(context.cwd ?? process.cwd(), input.path), "utf8");
  else {
    if (!context.readStdin) throw new CraigError("INPUT_REQUIRED", "Fury output from stdin is unavailable.", {});
    text = await context.readStdin();
  }
  try { return JSON.parse(text) as unknown; }
  catch (error) { throw new CraigError("FURY_OUTPUT_INVALID", "Fury step output must be valid JSON.", { cause: error }); }
}

async function selectWorkspaceInUi(paths: CraigPaths, workspaceId: string, selectedRepoId: string | null): Promise<void> {
  const ui = (await readUiState({ uiStateFile: paths.uiStateFile })) ?? getDefaultUiState();
  await writeUiState({ uiStateFile: paths.uiStateFile }, { ...ui, selectedWorkspaceId: workspaceId, selectedRepoId, selectedTaskId: null });
}

async function clearWorkspaceInUi(paths: CraigPaths, workspaceId: string): Promise<void> {
  const ui = await readUiState({ uiStateFile: paths.uiStateFile });
  if (ui?.selectedWorkspaceId === workspaceId) {
    await writeUiState({ uiStateFile: paths.uiStateFile }, { ...ui, selectedWorkspaceId: null, selectedRepoId: null, selectedTaskId: null });
  }
}

function assertNever(value: never): never {
  throw new Error(`Unsupported command: ${JSON.stringify(value)}`);
}

function requireSelectedTaskId(context: CommandContext, commandName: string): string {
  if (context.selectedTaskId) {
    return context.selectedTaskId;
  }

  throw new Error(`No task selected. Create a task with 'task new --repo <repo-id> <prompt>' or use '${commandName} <id>'.`);
}

function requireResolvedTaskContext(context: CommandContext): ResolvedTaskContext {
  if (context.taskContext) {
    return context.taskContext;
  }

  throw new Error("Command requires resolved task context.");
}

function resolveCommandTaskId(taskId: string | undefined, context: CommandContext): string {
  return taskId ?? requireResolvedTaskContext(context).task.id;
}

function requireWorkspaceContext(context: CommandContext): ResolvedWorkspaceContext {
  if (context.workspaceContext) {
    return context.workspaceContext;
  }

  throw new Error("Command requires resolved workspace context.");
}
