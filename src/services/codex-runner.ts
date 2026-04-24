/* eslint-disable no-unused-vars */
import type { SessionRecord } from "../types/session.js";
import type { TaskRecord } from "../types/task.js";
import { runCommand } from "../utils/exec.js";
import { shellEscape } from "../utils/shell-escape.js";
import { sendCommandToPane } from "./tmux-session.js";

export interface RunnerAdapter {
  prepare(...args: [TaskRecord, { repoRoot: string }]): Promise<void>;
  launch(...args: [TaskRecord, { repoRoot: string; session: SessionRecord }]): Promise<void>;
  status(...args: [TaskRecord, { session: SessionRecord }]): Promise<"starting" | "running" | "exited" | "failed">;
  stop(...args: [TaskRecord, { session: SessionRecord }]): Promise<void>;
  collectArtifacts(...args: [TaskRecord, { session: SessionRecord }]): Promise<void>;
}

export const codexRunnerAdapter: RunnerAdapter = {
  async prepare(_task, input) {
    await runCommand("codex", ["--help"], { cwd: input.repoRoot });
  },

  async launch(task, input) {
    await sendCommandToPane(
      input.session.paneId,
      `codex ${shellEscape(task.prompt.value)}`,
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
