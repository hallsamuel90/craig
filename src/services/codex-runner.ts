/* eslint-disable no-unused-vars */
import type { SessionRecord } from "../types/session.js";
import type { TaskRecord } from "../types/task.js";
import { runCommand } from "../utils/exec.js";
import { shellEscape } from "../utils/shell-escape.js";
import { requireExecutablePath, withDefaultCommandPath } from "../utils/command-path.js";
import { buildRunnerCommand, getRunnerProfile } from "./runner-profiles.js";
import { sendCommandToPane } from "./tmux-session.js";

export interface RunnerAdapter {
  prepare(...args: [TaskRecord, { repoRoot: string }]): Promise<void>;
  launch(...args: [TaskRecord, { repoRoot: string; session: SessionRecord }]): Promise<void>;
  status(...args: [TaskRecord, { session: SessionRecord }]): Promise<"starting" | "running" | "exited" | "failed">;
  stop(...args: [TaskRecord, { session: SessionRecord }]): Promise<void>;
  collectArtifacts(...args: [TaskRecord, { session: SessionRecord }]): Promise<void>;
}

export const commandRunnerAdapter: RunnerAdapter = {
  async prepare(task, input) {
    const profile = getRunnerProfile(task.runner);
    const env = withDefaultCommandPath();
    await runCommand(requireExecutablePath(profile.executable, { cwd: input.repoRoot, env }), ["--help"], {
      cwd: input.repoRoot,
      env,
    });
  },

  async launch(task, input) {
    const command = buildRunnerCommand(task.runner, task.prompt.value);
    const executable = requireExecutablePath(command[0]!, { cwd: task.worktreePath, env: withDefaultCommandPath() });
    await sendCommandToPane(
      input.session.paneId,
      [executable, ...command.slice(1)].map((part) => shellEscape(part)).join(" "),
      input.repoRoot,
    );
  },

  async status(task) {
    return task.runnerSession.lastKnownState;
  },

  async stop() {
    return;
  },

  async collectArtifacts() {
    return;
  },
};

export const codexRunnerAdapter = commandRunnerAdapter;
