import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";

import { afterEach, describe, expect, test } from "vitest";

import {
  discoverTaskPullRequest,
  linkTaskPullRequest,
  parsePullRequestSelector,
  refreshTaskPullRequest,
  showTaskPullRequests,
  unlinkTaskPullRequest,
} from "../src/domain/task/prs/association.js";
import { mutateTask, readTask, writeTask } from "../src/domain/task/adapters/task-store.js";
import { withTaskLock } from "../src/domain/task/adapters/task-lock.js";
import { persistPullRequestView, writePrStatusArtifact } from "../src/domain/task/prs/refresh.js";
import type { GhPrView, GitHubRepositoryLocator } from "../src/domain/task/adapters/github.js";
import type { ProjectTaskRepoTarget, TaskPR } from "../src/domain/task/index.js";
import { formatJsonSuccess } from "../src/commands/format-json.js";
import { createCraigState, createRepoRoot, writeTaskRecord } from "./test-helpers.js";

const tempRoots: string[] = [];

afterEach(async () => {
  await Promise.all(tempRoots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("task PR association service", () => {
  test("parses numeric and canonical GitHub URL selectors", () => {
    expect(parsePullRequestSelector("17")).toEqual({ number: 17, repository: null });
    expect(parsePullRequestSelector("https://github.com/example/repo/pull/17")).toEqual({
      number: 17,
      repository: { owner: "example", name: "repo", number: 17 },
    });
    expect(() => parsePullRequestSelector("repo#17")).toThrow(/Invalid pull request selector/);
    expect(() => parsePullRequestSelector("0")).toThrow(/positive number/);
  });

  test("links, refreshes, shows, and idempotently unlinks a verified repo PR", async () => {
    const { root, paths } = await createRepoTask();
    const views = new Map([
      ["17", buildView(17)],
      ["https://github.com/example/repo/pull/17", buildView(17)],
    ]);
    const deps = createDependencies(views);

    const linked = await linkTaskPullRequest(paths, "task_1", "17", undefined, deps);
    const duplicate = await linkTaskPullRequest(
      paths,
      "task_1",
      "https://github.com/example/repo/pull/17",
      undefined,
      deps,
    );
    const refreshed = await refreshTaskPullRequest(paths, "task_1", undefined, deps);
    const shown = await showTaskPullRequests(paths, "task_1", undefined, deps);
    const unlinked = await unlinkTaskPullRequest(paths, "task_1", "17", undefined, deps);
    const repeated = await unlinkTaskPullRequest(paths, "task_1", "17", undefined, deps);

    expect(linked).toMatchObject({
      disposition: "linked",
      repoId: "repo_test",
      primaryPullRequest: { owner: "example", repo: "repo", number: 17 },
    });
    expect(duplicate.disposition).toBe("unchanged");
    expect(refreshed.disposition).toBe("synced");
    expect(shown.pullRequests).toHaveLength(1);
    expect(unlinked).toMatchObject({ disposition: "unlinked", pullRequests: [] });
    expect(repeated.disposition).toBe("unchanged");
    expect((await readTask(paths, "task_1")).status).toBe("checked");
    const artifact = JSON.parse(
      await readFile(path.join(root, ".craig", "artifacts", "task_1", "pr-status.json"), "utf8"),
    ) as { prs: TaskPR[] };
    expect(artifact.prs).toEqual([]);
  });

  test("preserves sequential PR history and warns when the active PR changes", async () => {
    const { paths } = await createRepoTask();
    const deps = createDependencies(new Map([
      ["17", buildView(17)],
      ["18", buildView(18)],
    ]));

    await linkTaskPullRequest(paths, "task_1", "17", undefined, deps);
    const second = await linkTaskPullRequest(paths, "task_1", "18", undefined, deps);
    const task = await readTask(paths, "task_1");

    expect(task.prs.map((pr) => pr.number)).toEqual([17, 18]);
    expect(second.primaryPullRequest?.number).toBe(18);
    expect(second.warnings).toEqual([
      "Pull request #18 becomes active; #17 remains in task history.",
    ]);
    const envelope = JSON.parse(formatJsonSuccess("task.pr.link", second)) as {
      data: Record<string, unknown>;
      warnings: string[];
    };
    expect(envelope).toMatchObject({
      warnings: ["Pull request #18 becomes active; #17 remains in task history."],
    });
    expect(envelope.data).not.toHaveProperty("warnings");
  });

  test("rejects repository and branch mismatches before persistence", async () => {
    const { paths } = await createRepoTask();
    const wrongRepo = createDependencies(new Map([
      ["https://github.com/other/repo/pull/17", buildView(17, {
        url: "https://github.com/other/repo/pull/17",
      })],
    ]));
    const wrongBranch = createDependencies(new Map([
      ["17", buildView(17, { headRefName: "somebody-elses-branch" })],
    ]));

    await expect(
      linkTaskPullRequest(
        paths,
        "task_1",
        "https://github.com/other/repo/pull/17",
        undefined,
        wrongRepo,
      ),
    ).rejects.toMatchObject({ code: "PR_REPOSITORY_MISMATCH", exitCode: 4 });
    await expect(
      linkTaskPullRequest(paths, "task_1", "17", undefined, wrongBranch),
    ).rejects.toMatchObject({ code: "PR_BRANCH_MISMATCH", exitCode: 4 });
    expect((await readTask(paths, "task_1")).prs).toEqual([]);
  });

  test("discovers by task branch without manufacturing a missing association", async () => {
    const { paths } = await createRepoTask();
    const foundDeps = createDependencies(new Map(), buildView(21));
    const missingDeps = createDependencies(new Map(), null);

    const discovered = await discoverTaskPullRequest(paths, "task_1", undefined, foundDeps);
    await unlinkTaskPullRequest(paths, "task_1", "21", undefined, foundDeps);
    const missing = await discoverTaskPullRequest(paths, "task_1", undefined, missingDeps);

    expect(discovered).toMatchObject({
      disposition: "discovered",
      primaryPullRequest: { number: 21 },
    });
    expect(missing).toMatchObject({ disposition: "not_found", pullRequests: [] });
  });

  test("requires an unambiguous project target and maps URL selectors to that target", async () => {
    const root = await createRepoRoot("craig-pr-project-");
    tempRoots.push(root);
    const paths = await createCraigState(root, ["task_project"]);
    await writeTaskRecord(root, {
      id: "task_project",
      type: "project",
      repoId: "repo_a",
      repoTargets: [
        buildProjectTarget(root, "repo_a", "craig/project-a"),
        buildProjectTarget(root, "repo_b", "craig/project-b"),
      ],
    });
    const deps = createDependencies(
      new Map([
        [
          "https://github.com/example/repo-b/pull/31",
          buildView(31, {
            url: "https://github.com/example/repo-b/pull/31",
            headRefName: "craig/project-b",
          }),
        ],
        [
          "https://github.com/example/repo-b/pull/32",
          buildView(32, {
            url: "https://github.com/example/repo-b/pull/32",
            headRefName: "craig/project-b",
          }),
        ],
      ]),
      null,
      new Map([
        [path.join(root, "repo_a"), { owner: "example", name: "repo-a" }],
        [path.join(root, "repo_b"), { owner: "example", name: "repo-b" }],
      ]),
    );

    await expect(
      showTaskPullRequests(paths, "task_project", undefined, deps),
    ).rejects.toMatchObject({ code: "CLI_USAGE" });
    await expect(
      linkTaskPullRequest(paths, "task_project", "31", undefined, deps),
    ).rejects.toMatchObject({ code: "CLI_USAGE" });

    const linked = await linkTaskPullRequest(
      paths,
      "task_project",
      "https://github.com/example/repo-b/pull/31",
      undefined,
      deps,
    );
    const task = await readTask(paths, "task_project");

    expect(linked).toMatchObject({ repoId: "repo_b", disposition: "linked" });
    expect(task.repoTargets?.find((target) => target.repoId === "repo_b")?.pullRequest).toMatchObject({
      owner: "example",
      repo: "repo-b",
      number: 31,
    });
    expect(task.prs).toContainEqual(expect.objectContaining({
      owner: "example",
      repo: "repo-b",
      number: 31,
    }));

    await linkTaskPullRequest(
      paths,
      "task_project",
      "https://github.com/example/repo-b/pull/32",
      undefined,
      deps,
    );
    const offlineDeps = {
      ...deps,
      getGitHubRepositoryLocator: async () => {
        throw new Error("Git remote is unavailable");
      },
    };
    const unlinked = await unlinkTaskPullRequest(
      paths,
      "task_project",
      "https://github.com/example/repo-b/pull/32",
      undefined,
      offlineDeps,
    );
    const rolledBack = await readTask(paths, "task_project");
    const repoB = rolledBack.repoTargets?.find((target) => target.repoId === "repo_b");

    expect(unlinked.primaryPullRequest?.number).toBe(31);
    expect(repoB?.pullRequest.number).toBe(31);
    expect(rolledBack.status).toBe("pr_open");
    expect(rolledBack.prs.map((pr) => pr.number)).toEqual([31]);
  });

  test("unlinks persisted repo PRs without consulting the local Git remote", async () => {
    const { paths } = await createRepoTask();
    const deps = createDependencies(new Map([["17", buildView(17)]]));
    await linkTaskPullRequest(paths, "task_1", "17", undefined, deps);
    const offlineDeps = {
      ...deps,
      getGitHubRepositoryLocator: async () => {
        throw new Error("Git remote is unavailable");
      },
    };

    const result = await unlinkTaskPullRequest(paths, "task_1", "17", undefined, offlineDeps);

    expect(result).toMatchObject({ disposition: "unlinked", pullRequests: [] });
    expect((await readTask(paths, "task_1")).prs).toEqual([]);
  });

  test("serializes concurrent links so neither association is lost", async () => {
    const { paths } = await createRepoTask();
    const deps = createDependencies(new Map([
      ["41", buildView(41)],
      ["42", buildView(42)],
    ]));

    await Promise.all([
      linkTaskPullRequest(paths, "task_1", "41", undefined, deps),
      linkTaskPullRequest(paths, "task_1", "42", undefined, deps),
    ]);

    expect((await readTask(paths, "task_1")).prs.map((pr) => pr.number).sort()).toEqual([41, 42]);
  });

  test("serializes heartbeat persistence with a concurrent CLI repair", async () => {
    const { paths } = await createRepoTask();
    const task = await readTask(paths, "task_1");
    const deps = createDependencies(new Map([["52", buildView(52)]]));

    await Promise.all([
      persistPullRequestView(paths, task, buildView(51), null),
      linkTaskPullRequest(paths, "task_1", "52", undefined, deps),
    ]);

    expect((await readTask(paths, "task_1")).prs.map((pr) => pr.number).sort()).toEqual([51, 52]);
  });

  test("serializes ordinary task mutations with a concurrent CLI repair", async () => {
    const { paths } = await createRepoTask();
    const deps = createDependencies(new Map([["53", buildView(53)]]));

    await Promise.all([
      mutateTask(paths, "task_1", (task) => ({
        ...task,
        lastFailureReason: "runner exited unexpectedly",
      })),
      linkTaskPullRequest(paths, "task_1", "53", undefined, deps),
    ]);

    const task = await readTask(paths, "task_1");
    expect(task.lastFailureReason).toBe("runner exited unexpectedly");
    expect(task.prs).toContainEqual(expect.objectContaining({ number: 53 }));
  });

  test("recovers a task lock left by a dead process", async () => {
    const { paths } = await createRepoTask();
    const lockPath = path.join(paths.runtimeDir, "task-locks", "task_1.lock");
    await mkdir(lockPath, { recursive: true });
    await writeFile(
      path.join(lockPath, "owner.json"),
      JSON.stringify({ pid: 2_147_483_647 }),
      "utf8",
    );

    const result = await withTaskLock(paths, "task_1", async () => "acquired");

    expect(result).toBe("acquired");
  });

  test("reports a partial result when the task persists but its PR artifact fails", async () => {
    const { paths } = await createRepoTask();
    const deps = {
      ...createDependencies(new Map([["61", buildView(61)]])),
      writePrStatusArtifact: async () => {
        throw new Error("artifact disk failure");
      },
    };

    await expect(
      linkTaskPullRequest(paths, "task_1", "61", undefined, deps),
    ).rejects.toMatchObject({
      code: "PARTIAL_RESULT",
      exitCode: 7,
      details: { taskId: "task_1" },
    });
    expect((await readTask(paths, "task_1")).prs).toContainEqual(
      expect.objectContaining({ number: 61 }),
    );
  });
});

async function createRepoTask() {
  const root = await createRepoRoot("craig-pr-association-");
  tempRoots.push(root);
  const paths = await createCraigState(root, ["task_1"]);
  await writeTaskRecord(root, {
    id: "task_1",
    repoId: "repo_test",
    branch: "craig/task_1",
    worktreePath: root,
    status: "checked",
  });
  return { root, paths };
}

function createDependencies(
  views: Map<string, GhPrView>,
  discovered: GhPrView | null = null,
  repositories: Map<string, GitHubRepositoryLocator> = new Map(),
) {
  return {
    readTask,
    writeTask,
    withTaskLock,
    ensureGhAuthenticated: async () => undefined,
    fetchPrView: async (selector: string) => {
      const view = views.get(selector);
      if (!view) throw new Error(`missing fake PR ${selector}`);
      return view;
    },
    discoverPrView: async () => discovered,
    getGitHubRepositoryLocator: async (worktreePath: string) =>
      repositories.get(worktreePath) ?? { owner: "example", name: "repo" },
    writePrStatusArtifact,
  };
}

function buildView(number: number, overrides: Partial<GhPrView> = {}): GhPrView {
  return {
    number,
    url: `https://github.com/example/repo/pull/${number}`,
    baseRefName: "main",
    headRefName: "craig/task_1",
    headRefOid: `sha-${number}`,
    state: "OPEN",
    isDraft: false,
    mergeable: "MERGEABLE",
    mergeStateStatus: "CLEAN",
    reviewDecision: null,
    statusCheckRollup: [],
    comments: [],
    ...overrides,
  };
}

function buildProjectTarget(
  root: string,
  repoId: string,
  branch: string,
): ProjectTaskRepoTarget {
  return {
    repoId,
    branch,
    repoRoot: path.join(root, repoId),
    worktreePath: path.join(root, repoId),
    status: "ready",
    failureReason: null,
    checks: {
      source: { type: "repo_config", path: ".craig/config.json" },
      lastRunAt: null,
      status: "not_run",
      commands: [],
      results: [],
    },
    lastCommit: null,
    pullRequest: {
      provider: "github",
      number: null,
      url: null,
      baseBranch: null,
      headBranch: null,
      status: null,
      mergeable: false,
      mergeStateStatus: null,
      requiredChecks: [],
      lastSyncedAt: null,
      lastSyncedHeadSha: null,
    },
    cleanup: {
      worktreeRemovedAt: null,
      preservedWorktree: false,
      warning: null,
    },
  };
}
