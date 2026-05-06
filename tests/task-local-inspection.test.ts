import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";

import { describe, expect, test } from "vitest";

import { loadTaskLocalInspection } from "../src/services/task-local-inspection.js";
import { runCommand } from "../src/utils/exec.js";
import { buildTaskRecord, createGitRepo, createRepoRoot } from "./test-helpers.js";

describe("task local inspection", () => {
  test("lists tracked plus untracked non-ignored files", async () => {
    const repoRoot = await createRepoRoot("craig-inspection-");
    await createGitRepo(repoRoot);
    await writeFile(path.join(repoRoot, ".gitignore"), "ignored.txt\n", "utf8");
    await mkdir(path.join(repoRoot, "src"), { recursive: true });
    await writeFile(path.join(repoRoot, "src", "tracked.ts"), "export const tracked = true;\n", "utf8");
    await runCommand("git", ["add", ".gitignore", "src/tracked.ts"], { cwd: repoRoot });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, "src", "untracked.ts"), "export const untracked = true;\n", "utf8");
    await writeFile(path.join(repoRoot, "ignored.txt"), "nope\n", "utf8");

    const inspection = await loadTaskLocalInspection(buildTaskRecord(repoRoot, { id: "task_1", worktreePath: repoRoot }), {});

    expect(inspection.filePaths).toContain(".gitignore");
    expect(inspection.filePaths).toContain("src/tracked.ts");
    expect(inspection.filePaths).toContain("src/untracked.ts");
    expect(inspection.filePaths).not.toContain("ignored.txt");
    expect(inspection.fileRows).toContainEqual(expect.objectContaining({ kind: "directory", path: "src" }));
  });

  test("splits diff summary into staged unstaged and untracked groups", async () => {
    const repoRoot = await createRepoRoot("craig-inspection-");
    await createGitRepo(repoRoot);
    await writeFile(path.join(repoRoot, "staged.txt"), "before\n", "utf8");
    await writeFile(path.join(repoRoot, "unstaged.txt"), "line 1\nline 2\nline 3\nbefore\nline 5\nline 6\nline 7\n", "utf8");
    await runCommand("git", ["add", "staged.txt", "unstaged.txt"], { cwd: repoRoot });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, "staged.txt"), "after staged\n", "utf8");
    await runCommand("git", ["add", "staged.txt"], { cwd: repoRoot });
    await writeFile(path.join(repoRoot, "unstaged.txt"), "line 1\nline 2\nline 3\nafter unstaged\nline 5\nline 6\nline 7\n", "utf8");
    await writeFile(path.join(repoRoot, "new.txt"), "brand new\n", "utf8");

    const inspection = await loadTaskLocalInspection(buildTaskRecord(repoRoot, { id: "task_1", worktreePath: repoRoot }), {
      selectedDiffPath: "unstaged.txt",
    });

    expect(inspection.diffRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ group: "staged", path: "staged.txt" }),
        expect.objectContaining({ group: "unstaged", path: "unstaged.txt" }),
        expect.objectContaining({ group: "untracked", path: "new.txt", additions: 1, deletions: 0 }),
      ]),
    );
    expect(inspection.selectedDiffPath).toBe("unstaged.txt");
    expect(inspection.selectedDiff.lines.join("\n")).toContain("unstaged");
    expect(inspection.selectedDiff.lines.join("\n")).toContain("line 7");
  });

  test("falls back from stale selected paths and guards binary files", async () => {
    const repoRoot = await createRepoRoot("craig-inspection-");
    await createGitRepo(repoRoot);
    await writeFile(path.join(repoRoot, "binary.bin"), Buffer.from([0, 1, 2, 3]));
    await runCommand("git", ["add", "binary.bin"], { cwd: repoRoot });
    await runCommand("git", ["commit", "-m", "initial"], { cwd: repoRoot });

    const inspection = await loadTaskLocalInspection(buildTaskRecord(repoRoot, { id: "task_1", worktreePath: repoRoot }), {
      selectedFilePath: "missing.txt",
    });

    expect(inspection.selectedFilePath).toBe("binary.bin");
    expect(inspection.selectedFile.status).toBe("binary");
    expect(inspection.selectedFile.lines.join("\n")).toContain("Binary file preview");
  });
});
