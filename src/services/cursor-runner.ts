import { runCommand } from "../utils/exec.js";
import { shellEscape } from "../utils/shell-escape.js";
import { sendCommandToPane } from "./tmux-session.js";

export async function assertCursorAvailable(repoRoot: string): Promise<void> {
  await runCommand("cursor", ["agent", "--help"], { cwd: repoRoot });
}

export async function launchCursorInPane(
  repoRoot: string,
  paneId: string,
  prompt: string,
): Promise<void> {
  await sendCommandToPane(paneId, `cursor agent ${shellEscape(prompt)}`, repoRoot);
}
