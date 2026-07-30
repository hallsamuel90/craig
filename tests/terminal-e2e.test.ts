import { chmod, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

import { describe, expect, test } from "vitest";
import { spawn } from "node-pty";

import { createCraigState, createGitRepo, writeRepoRecord, writeTaskRecord } from "./test-helpers.js";
import { runCommand } from "../src/shared/exec.js";
import { getCraigPaths } from "../src/state/craig-paths.js";
import { requestDaemonShutdown } from "../src/ui/pty/daemon.js";
import { resolveExecutablePath } from "../src/shared/command-path.js";

describe("Craig terminal mode E2E", () => {
  test("enters terminal mode and supports detach and reattach", async () => {
    const repoRoot = process.cwd();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "craig-terminal-e2e-")).then((value) => realpath(value));
    await createCraigState(workspaceRoot, ["task_20260430_02"]);
    const sourceRepo = join(workspaceRoot, "repo-a");
    await mkdir(sourceRepo, { recursive: true });
    await writeRepoRecord(
      workspaceRoot,
      {
        id: "repo_a",
        name: "repo-a",
        rootPath: sourceRepo,
        defaultBranch: "main",
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      {
        id: "workspace_repo_a",
        primaryRepoId: "repo_a",
        branch: "main",
        status: "active",
        linkedRepoIds: [],
        archivedAt: null,
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
    );
    const taskWorktree = join(workspaceRoot, "worktrees", "repo-a", "task_20260430_02");
    await mkdir(taskWorktree, { recursive: true });
    await writeTaskRecord(workspaceRoot, {
      id: "task_20260430_02",
      repoId: "repo_a",
      workspaceId: "workspace_repo_a",
      worktreePath: taskWorktree,
    });
    const cursorMarker = "craig_e2e_cursor_ok";
    const output = new PtyOutputBuffer();
    await writeInitialUiState(workspaceRoot);

    const child = spawn(resolveTestTsxBin(repoRoot), [resolve(repoRoot, "src/cli.ts")], {
      cwd: workspaceRoot,
      cols: 120,
      rows: 36,
      env: {
        ...process.env,
        CI: "",
        SHELL: process.env.SHELL ?? "/bin/zsh",
        TERM: "xterm-256color",
      },
    });

    child.onData((chunk) => output.append(chunk));

    try {
      await output.waitFor("> Start");
      child.write("\r");
      await output.waitFor("+ new tab");
      child.write("\r");
      await output.waitFor("TERMINAL   ↑↓/PgUp/PgDn scroll");

      child.write(`printf '\\033[3;12H${cursorMarker}'\r`);
      await output.waitForLatestFrame(cursorMarker);
      child.write("\u001D");
      await output.waitForLatestFrame("+ new tab");
      child.write("\r");
      await output.waitForLatestFrame("TERMINAL   ↑↓/PgUp/PgDn scroll");
      await output.waitForLatestFrame(cursorMarker);

      expect(output.value).toContain("TERMINAL   ↑↓/PgUp/PgDn scroll");
      expect(output.latestFrame()).toContain(cursorMarker);
    } finally {
      child.kill();
      await cleanupTerminalWorkspace(workspaceRoot);
    }
  }, 15000);

  test("incremental center preview starts Codex in the selected task worktree", async () => {
    const repoRoot = process.cwd();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "craig-terminal-e2e-")).then((value) => realpath(value));
    await createCraigState(workspaceRoot, ["task_20260430_02"]);
    const sourceRepo = join(workspaceRoot, "repo-a");
    await mkdir(sourceRepo, { recursive: true });
    await createGitRepo(sourceRepo);
    await writeFile(join(sourceRepo, "README.md"), "# repo-a\n", "utf8");
    await runCommand("git", ["add", "README.md"], { cwd: sourceRepo });
    await runCommand("git", ["commit", "-m", "init"], { cwd: sourceRepo });
    await writeRepoRecord(
      workspaceRoot,
      {
        id: "repo_a",
        name: "repo-a",
        rootPath: sourceRepo,
        defaultBranch: "main",
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      {
        id: "workspace_repo_a",
        primaryRepoId: "repo_a",
        branch: "main",
        status: "active",
        linkedRepoIds: [],
        archivedAt: null,
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
    );
    const taskWorktree = join(workspaceRoot, "worktrees", "repo-a", "task_20260430_02");
    await mkdir(taskWorktree, { recursive: true });
    await writeTaskRecord(workspaceRoot, {
      id: "task_20260430_02",
      repoId: "repo_a",
      workspaceId: "workspace_repo_a",
      worktreePath: taskWorktree,
      selectedPtyTabId: "task_20260430_02:agent",
    });
    const codexStubDir = await createCodexHarnessStub(workspaceRoot);
    await writeAgentUiState(workspaceRoot);
    await writeFile(
      getCraigPaths(workspaceRoot).configFile,
      JSON.stringify({ previews: { incrementalCenterPane: true } }),
      "utf8",
    );
    const output = new PtyOutputBuffer();

    const child = spawn(resolveTestTsxBin(repoRoot), [resolve(repoRoot, "src/cli.ts")], {
      cwd: workspaceRoot,
      cols: 120,
      rows: 36,
      env: {
        ...process.env,
        CI: "",
        PATH: `${codexStubDir}:${process.env.PATH ?? ""}`,
        SHELL: process.env.SHELL ?? "/bin/zsh",
        TERM: "xterm-256color",
      },
    });

    child.onData((chunk) => output.append(chunk));

    try {
      await output.waitFor("> Start");
      child.write("\r");
      await output.waitFor("+ new tab");
      child.write("\r");
      await output.waitFor("codex_stub_started");
      await output.waitForLatestFrame("codex_stub_bottom_bar");
      const frame = output.latestFrame();
      expect(frame).toContain("TERMINAL   ↑↓/PgUp/PgDn scroll");
      expect(frame).toContain("codex_stub_started");
      expect(frame).toContain("codex_stub_prompt:");
      expect(frame).toContain("codex_stub_bottom_bar");
      expect(frame).toContain("48;2;42;42;42");
      expect(frame).toContain("codex_stub_task_dir:task_20260430_02");
    } finally {
      child.kill();
      await cleanupTerminalWorkspace(workspaceRoot);
    }
  }, 15000);

  test("creating a new task starts Codex in the new task worktree", async () => {
    const repoRoot = process.cwd();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "craig-terminal-e2e-create-")).then((value) => realpath(value));
    await createCraigState(workspaceRoot, []);
    const sourceRepo = join(workspaceRoot, "repo-a");
    await mkdir(sourceRepo, { recursive: true });
    await createGitRepo(sourceRepo);
    await writeFile(join(sourceRepo, "README.md"), "# repo-a\n", "utf8");
    await runCommand("git", ["add", "README.md"], { cwd: sourceRepo });
    await runCommand("git", ["commit", "-m", "init"], { cwd: sourceRepo });
    await writeRepoRecord(
      workspaceRoot,
      {
        id: "repo_a",
        name: "repo-a",
        rootPath: sourceRepo,
        defaultBranch: "main",
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      {
        id: "workspace_repo_a",
        primaryRepoId: "repo_a",
        branch: "main",
        status: "active",
        linkedRepoIds: [],
        archivedAt: null,
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
    );
    const codexStubDir = await createCodexHarnessStub(workspaceRoot);
    await writeRepoUiState(workspaceRoot);
    const output = new PtyOutputBuffer();

    const child = spawn(resolveTestTsxBin(repoRoot), [resolve(repoRoot, "src/cli.ts")], {
      cwd: workspaceRoot,
      cols: 120,
      rows: 36,
      env: {
        ...process.env,
        CI: "",
        PATH: `${codexStubDir}:${process.env.PATH ?? ""}`,
        SHELL: process.env.SHELL ?? "/bin/zsh",
        TERM: "xterm-256color",
      },
    });

    child.onData((chunk) => output.append(chunk));

    try {
      await output.waitFor("> Start");
      child.write("\r");
      await output.waitFor("+ New Task");
      child.write("n");
      await output.waitFor("NEW TASK");
      child.write("create e2e task");
      child.write("\r");
      await output.waitFor("codex_stub_started");
      await output.waitForLatestFrame("codex_stub_bottom_bar");
      const frame = output.latestFrame();
      expect(frame).toContain("TERMINAL   ↑↓/PgUp/PgDn scroll");
      expect(frame).toContain("codex_stub_started");
      expect(frame).toContain("codex_stub_task_dir:task_");
      expect(frame).toContain("codex_stub_prompt:");
      expect(frame).not.toContain("[process exited");
    } finally {
      child.kill();
      await cleanupTerminalWorkspace(workspaceRoot);
    }
  }, 20000);

  test.each([
    ["cursor", "cursor-agent"],
    ["claude", "claude"],
  ] as const)("attaching the selected %s agent task starts the runner in that task worktree", async (runner, executable) => {
    const repoRoot = process.cwd();
    const workspaceRoot = await mkdtemp(join(tmpdir(), `craig-terminal-e2e-${runner}-`)).then((value) => realpath(value));
    await createCraigState(workspaceRoot, ["task_20260430_02"]);
    const sourceRepo = join(workspaceRoot, "repo-a");
    await mkdir(sourceRepo, { recursive: true });
    await createGitRepo(sourceRepo);
    await writeFile(join(sourceRepo, "README.md"), "# repo-a\n", "utf8");
    await runCommand("git", ["add", "README.md"], { cwd: sourceRepo });
    await runCommand("git", ["commit", "-m", "init"], { cwd: sourceRepo });
    await writeRepoRecord(
      workspaceRoot,
      {
        id: "repo_a",
        name: "repo-a",
        rootPath: sourceRepo,
        defaultBranch: "main",
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      {
        id: "workspace_repo_a",
        primaryRepoId: "repo_a",
        branch: "main",
        status: "active",
        linkedRepoIds: [],
        archivedAt: null,
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
    );
    const taskWorktree = join(workspaceRoot, "worktrees", "repo-a", "task_20260430_02");
    await mkdir(taskWorktree, { recursive: true });
    await writeTaskRecord(workspaceRoot, {
      id: "task_20260430_02",
      repoId: "repo_a",
      workspaceId: "workspace_repo_a",
      runner,
      worktreePath: taskWorktree,
      selectedPtyTabId: "task_20260430_02:agent",
    });
    const stubDir = await createSimpleAgentHarnessStub(workspaceRoot, executable, runner);
    await writeAgentUiState(workspaceRoot);
    const output = new PtyOutputBuffer();

    const child = spawn(resolveTestTsxBin(repoRoot), [resolve(repoRoot, "src/cli.ts")], {
      cwd: workspaceRoot,
      cols: 120,
      rows: 36,
      env: {
        ...process.env,
        CI: "",
        PATH: `${stubDir}:${process.env.PATH ?? ""}`,
        SHELL: process.env.SHELL ?? "/bin/zsh",
        TERM: "xterm-256color",
      },
    });

    child.onData((chunk) => output.append(chunk));

    try {
      await output.waitFor("> Start");
      child.write("\r");
      await output.waitFor("+ new tab");
      child.write("\r");
      await output.waitFor(`${runner}_stub_started`);
      const frame = output.latestFrame();
      expect(frame).toContain(`${runner}_stub_started`);
      expect(output.value).toContain(`${runner}_stub_task_dir_ok`);
    } finally {
      child.kill();
      await cleanupTerminalWorkspace(workspaceRoot);
    }
  }, 15000);

  test("enter on the selected left-pane task row opens the agent PTY without crashing", async () => {
    const repoRoot = process.cwd();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "craig-terminal-e2e-")).then((value) => realpath(value));
    await createCraigState(workspaceRoot, ["task_20260430_02"]);
    const sourceRepo = join(workspaceRoot, "repo-a");
    await mkdir(sourceRepo, { recursive: true });
    await createGitRepo(sourceRepo);
    await writeFile(join(sourceRepo, "README.md"), "# repo-a\n", "utf8");
    await runCommand("git", ["add", "README.md"], { cwd: sourceRepo });
    await runCommand("git", ["commit", "-m", "init"], { cwd: sourceRepo });
    await writeRepoRecord(
      workspaceRoot,
      {
        id: "repo_a",
        name: "repo-a",
        rootPath: sourceRepo,
        defaultBranch: "main",
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      {
        id: "workspace_repo_a",
        primaryRepoId: "repo_a",
        branch: "main",
        status: "active",
        linkedRepoIds: [],
        archivedAt: null,
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
    );
    const taskWorktree = join(workspaceRoot, "worktrees", "repo-a", "task_20260430_02");
    await mkdir(taskWorktree, { recursive: true });
    await writeTaskRecord(workspaceRoot, {
      id: "task_20260430_02",
      repoId: "repo_a",
      workspaceId: "workspace_repo_a",
      worktreePath: taskWorktree,
      selectedPtyTabId: "task_20260430_02:agent",
    });
    const codexStubDir = await createCodexHarnessStub(workspaceRoot);
    await writeLeftPaneTaskUiState(workspaceRoot);
    const output = new PtyOutputBuffer();

    const child = spawn(resolveTestTsxBin(repoRoot), [resolve(repoRoot, "src/cli.ts")], {
      cwd: workspaceRoot,
      cols: 120,
      rows: 36,
      env: {
        ...process.env,
        CI: "",
        PATH: `${codexStubDir}:${process.env.PATH ?? ""}`,
        SHELL: process.env.SHELL ?? "/bin/zsh",
        TERM: "xterm-256color",
      },
    });

    child.onData((chunk) => output.append(chunk));

    try {
      await output.waitFor("> Start");
      child.write("\r");
      await output.waitFor("▸ test task");
      child.write("\r");
      await output.waitFor("codex_stub_started");
      await output.waitForLatestFrame("codex_stub_bottom_bar");
      const frame = output.latestFrame();
      expect(frame).toContain("TERMINAL   ↑↓/PgUp/PgDn scroll");
      expect(frame).toContain("codex_stub_prompt:");
      expect(frame).not.toContain("[process exited");
    } finally {
      child.kill();
      await cleanupTerminalWorkspace(workspaceRoot);
    }
  }, 15000);

  test("restarting Craig reattaches to a live daemon-owned agent tab without relaunching Codex", async () => {
    const repoRoot = process.cwd();
    const workspaceRoot = await mkdtemp(join(tmpdir(), "craig-terminal-daemon-e2e-")).then((value) => realpath(value));
    await createCraigState(workspaceRoot, ["task_20260430_02"]);
    const sourceRepo = join(workspaceRoot, "repo-a");
    await mkdir(sourceRepo, { recursive: true });
    await createGitRepo(sourceRepo);
    await writeFile(join(sourceRepo, "README.md"), "# repo-a\n", "utf8");
    await runCommand("git", ["add", "README.md"], { cwd: sourceRepo });
    await runCommand("git", ["commit", "-m", "init"], { cwd: sourceRepo });
    await writeRepoRecord(
      workspaceRoot,
      {
        id: "repo_a",
        name: "repo-a",
        rootPath: sourceRepo,
        defaultBranch: "main",
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
      {
        id: "workspace_repo_a",
        primaryRepoId: "repo_a",
        branch: "main",
        status: "active",
        linkedRepoIds: [],
        archivedAt: null,
        createdAt: "2026-05-04T00:00:00.000Z",
        updatedAt: "2026-05-04T00:00:00.000Z",
      },
    );
    const taskWorktree = join(workspaceRoot, "worktrees", "repo-a", "task_20260430_02");
    await mkdir(taskWorktree, { recursive: true });
    await writeTaskRecord(workspaceRoot, {
      id: "task_20260430_02",
      repoId: "repo_a",
      workspaceId: "workspace_repo_a",
      worktreePath: taskWorktree,
      selectedPtyTabId: "task_20260430_02:agent",
    });
    const codexStubDir = await createCodexHarnessStub(workspaceRoot);
    const launchFile = join(workspaceRoot, "codex-harness", "launch-count.txt");
    await writeAgentUiState(workspaceRoot);

    try {
      const firstOutput = new PtyOutputBuffer();
      const first = spawn(resolveTestTsxBin(repoRoot), [resolve(repoRoot, "src/cli.ts")], {
        cwd: workspaceRoot,
        cols: 120,
        rows: 36,
        env: {
          ...process.env,
          CI: "",
          CODEX_STUB_LAUNCH_FILE: launchFile,
          PATH: `${codexStubDir}:${process.env.PATH ?? ""}`,
          SHELL: process.env.SHELL ?? "/bin/zsh",
          TERM: "xterm-256color",
        },
      });
      first.onData((chunk) => firstOutput.append(chunk));
      await firstOutput.waitFor("> Start");
      first.write("\r");
      await firstOutput.waitFor("+ new tab");
      first.write("\r");
      await firstOutput.waitForLatestFrame("codex_stub_started");
      first.kill();
      await delay(500);

      const secondOutput = new PtyOutputBuffer();
      const second = spawn(resolveTestTsxBin(repoRoot), [resolve(repoRoot, "src/cli.ts")], {
        cwd: workspaceRoot,
        cols: 120,
        rows: 36,
        env: {
          ...process.env,
          CI: "",
          CODEX_STUB_LAUNCH_FILE: launchFile,
          PATH: `${codexStubDir}:${process.env.PATH ?? ""}`,
          SHELL: process.env.SHELL ?? "/bin/zsh",
          TERM: "xterm-256color",
        },
      });
      second.onData((chunk) => secondOutput.append(chunk));
      await secondOutput.waitFor("> Start");
      second.write("\r");
      await secondOutput.waitForLatestFrame("codex_stub_started");
      second.write("\u001D");
      second.write("q");
      await delay(500);

      const launchCount = await readFile(launchFile, "utf8");
      expect(launchCount.trim()).toBe("1");
      expect(secondOutput.latestFrame()).toContain("codex_stub_bottom_bar");
    } finally {
      await cleanupTerminalWorkspace(workspaceRoot);
    }
  }, 20000);
});

async function cleanupTerminalWorkspace(workspaceRoot: string): Promise<void> {
  await requestDaemonShutdown(getCraigPaths(workspaceRoot));
  await rm(workspaceRoot, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  });
}

async function writeInitialUiState(workspaceRoot: string): Promise<void> {
  const runtimeDir = join(workspaceRoot, ".craig", "runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    join(runtimeDir, "ui-state.json"),
    JSON.stringify({
      version: 1,
      selectedRepoId: "repo_a",
      selectedWorkspaceId: "workspace_repo_a",
      selectedTaskId: "task_20260430_02",
      selectedPtyTabId: "task_20260430_02:terminal",
      inputMode: "control",
      focusedRegion: "center",
      activeTab: "terminal",
      selectedActionId: "commit",
      updatedAt: "2026-05-04T00:00:00.000Z",
    }),
  );
}

async function writeAgentUiState(workspaceRoot: string): Promise<void> {
  const runtimeDir = join(workspaceRoot, ".craig", "runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    join(runtimeDir, "ui-state.json"),
    JSON.stringify({
      version: 1,
      selectedRepoId: "repo_a",
      selectedWorkspaceId: "workspace_repo_a",
      selectedTaskId: "task_20260430_02",
      selectedPtyTabId: "task_20260430_02:agent",
      inputMode: "control",
      focusedRegion: "center",
      activeTab: "agent",
      selectedActionId: "commit",
      updatedAt: "2026-05-04T00:00:00.000Z",
    }),
  );
}

async function writeRepoUiState(workspaceRoot: string): Promise<void> {
  const runtimeDir = join(workspaceRoot, ".craig", "runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    join(runtimeDir, "ui-state.json"),
    JSON.stringify({
      version: 1,
      selectedRepoId: "repo_a",
      selectedWorkspaceId: "workspace_repo_a",
      selectedTaskId: null,
      selectedPtyTabId: null,
      inputMode: "control",
      focusedRegion: "center",
      activeTab: "agent",
      selectedActionId: "commit",
      updatedAt: "2026-05-04T00:00:00.000Z",
    }),
  );
}

async function writeLeftPaneTaskUiState(workspaceRoot: string): Promise<void> {
  const runtimeDir = join(workspaceRoot, ".craig", "runtime");
  await mkdir(runtimeDir, { recursive: true });
  await writeFile(
    join(runtimeDir, "ui-state.json"),
    JSON.stringify({
      version: 1,
      selectedRepoId: "repo_a",
      selectedWorkspaceId: "workspace_repo_a",
      selectedTaskId: "task_20260430_02",
      selectedPtyTabId: "task_20260430_02:agent",
      inputMode: "control",
      focusedRegion: "tasks",
      activeTab: "agent",
      selectedActionId: "commit",
      updatedAt: "2026-05-04T00:00:00.000Z",
    }),
  );
}

async function createCodexHarnessStub(workspaceRoot: string): Promise<string> {
  const stubDir = join(workspaceRoot, "codex-harness");
  const stubPath = join(stubDir, "codex");
  const probePath = join(stubDir, "codex-probe.js");
  await mkdir(stubDir, { recursive: true });
  await writeFile(
    probePath,
    `const expected = [
  { query: "\\u001B[6n", match: /\\u001B\\[\\d+;\\d+R/ },
  { query: "\\u001B[c", match: /\\u001B\\[\\?.*c/ },
  { query: "\\u001B[?u", match: /\\u001B\\[\\?\\d+u/ },
];

process.stdin.setEncoding("utf8");
if (process.stdin.isTTY) {
  process.stdin.setRawMode(true);
}
process.stdin.resume();

let buffer = "";
let index = 0;
let launched = false;

const maybeAdvance = () => {
  while (index < expected.length) {
    const probe = expected[index];
    const match = buffer.match(probe.match);
    if (!match) {
      return;
    }
    buffer = buffer.slice(buffer.indexOf(match[0]) + match[0].length);
    index += 1;
    if (index < expected.length) {
      process.stdout.write(expected[index].query);
    }
  }

  if (index === expected.length && !launched) {
    launched = true;
    if (process.env.CODEX_STUB_LAUNCH_FILE) {
      const fs = require("node:fs");
      const current = Number(fs.existsSync(process.env.CODEX_STUB_LAUNCH_FILE) ? fs.readFileSync(process.env.CODEX_STUB_LAUNCH_FILE, "utf8") : "0");
      fs.writeFileSync(process.env.CODEX_STUB_LAUNCH_FILE, String(current + 1));
    }
    process.stdout.write("codex_stub_started\\n");
    process.stdout.write(\`codex_stub_cwd:\${process.cwd()}\\n\`);
    process.stdout.write(\`codex_stub_task_dir:\${process.cwd().split("/").pop()}\\n\`);
    process.stdout.write(\`codex_stub_prompt:\${process.argv.slice(2).join(" ")}\\n\`);
    const rows = Number(process.stdout.rows || 0);
    if (rows > 0) {
      process.stdout.write(\`\\u001B[\${rows};1H\\u001B[48;2;42;42;42;38;2;229;229;229mcodex_stub_bottom_bar\\u001B[0m\`);
    }
  }
};

process.stdin.on("data", (chunk) => {
  buffer += chunk;
  maybeAdvance();
});

process.stdout.write(expected[0].query);
`,
    "utf8",
  );
  await writeFile(
    stubPath,
    `#!/bin/sh
set -eu
if [ "\${1:-}" = "--help" ]; then
  exit 0
fi
exec node "${probePath}" "$@"
`,
    "utf8",
  );
  await chmod(stubPath, 0o755);
  return stubDir;
}

async function createSimpleAgentHarnessStub(workspaceRoot: string, executable: string, marker: string): Promise<string> {
  const stubDir = join(workspaceRoot, `${marker}-harness`);
  const stubPath = join(stubDir, executable);
  await mkdir(stubDir, { recursive: true });
  await writeFile(
    stubPath,
    `#!/bin/sh
set -eu
if [ "\${1:-}" = "--help" ]; then
  exit 0
fi
echo "${marker}_stub_started"
if [ "$(basename "$PWD")" = "task_20260430_02" ]; then
  echo "${marker}_stub_task_dir_ok"
else
  echo "${marker}_stub_task_dir_bad:$(basename "$PWD")"
fi
echo "${marker}_stub_prompt:$*"
sleep 5
`,
    "utf8",
  );
  await chmod(stubPath, 0o755);
  return stubDir;
}

function resolveTestTsxBin(repoRoot: string): string {
  return resolveExecutablePath(resolve(repoRoot, "node_modules/.bin/tsx")) ?? resolveExecutablePath("tsx") ?? resolve(repoRoot, "node_modules/.bin/tsx");
}

class PtyOutputBuffer {
  value = "";

  append(chunk: string): void {
    this.value += chunk;
    if (this.value.length > 80_000) {
      this.value = this.value.slice(-80_000);
    }
  }

  async waitFor(needle: string, timeoutMs = 7000): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (this.value.includes(needle)) {
        return;
      }

      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }

    throw new Error(`Timed out waiting for ${JSON.stringify(needle)}.\n\nLast output:\n${this.value.slice(-5000)}`);
  }

  latestFrame(): string {
    const marker = "CRAIG  |";
    const index = this.value.lastIndexOf(marker);
    return index === -1 ? this.value : this.value.slice(index);
  }

  async waitForLatestFrame(needle: string, timeoutMs = 7000): Promise<void> {
    const start = Date.now();

    while (Date.now() - start < timeoutMs) {
      if (this.latestFrame().includes(needle)) {
        return;
      }

      await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    }

    throw new Error(`Timed out waiting for ${JSON.stringify(needle)} in latest frame.\n\nLatest frame:\n${this.latestFrame().slice(-5000)}`);
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolveDelay) => setTimeout(resolveDelay, ms));
}
