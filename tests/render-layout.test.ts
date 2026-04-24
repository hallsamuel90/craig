import { describe, expect, test } from "vitest";

import { renderWorkspaceOverlay } from "../src/interactive/render-layout.js";

function stripAnsi(value: string): string {
  let result = "";
  let index = 0;

  while (index < value.length) {
    if (value.charCodeAt(index) === 27 && value[index + 1] === "[") {
      index += 2;

      while (index < value.length && value[index] !== "m") {
        index += 1;
      }

      if (index < value.length) {
        index += 1;
      }

      continue;
    }

    result += value[index] ?? "";
    index += 1;
  }

  return result;
}

describe("renderWorkspaceOverlay", () => {
  test("renders the overlay summary and menu on wide terminals", () => {
    const frame = stripAnsi(renderWorkspaceOverlay({
      workspaceRoot: "/workspace/seattle",
      repos: [
        {
          id: "repo_alpha",
          name: "alpha",
          rootPath: "/workspace/seattle/alpha",
          defaultBranch: "main",
          createdAt: "2026-04-23T00:00:00.000Z",
          updatedAt: "2026-04-23T00:00:00.000Z",
        },
      ],
      workspaces: [
        {
          id: "workspace_repo_alpha",
          primaryRepoId: "repo_alpha",
          branch: "main",
          status: "active",
          linkedRepoIds: [],
          archivedAt: null,
          createdAt: "2026-04-23T00:00:00.000Z",
          updatedAt: "2026-04-23T00:00:00.000Z",
        },
      ],
      archivedWorkspaces: [],
      overlayMode: "start",
      selectedMenuIndex: 0,
      messageLines: [],
      terminalSize: {
        columns: 120,
        rows: 24,
      },
    }));

    expect(frame).toContain("CRAIG | seattle | overlay");
    expect(frame).toContain("Repos: 1 | Active workspaces: 1 | Archived: 0");
    expect(frame).toContain("> Start");
    expect(frame).toContain("repo repo_alpha | main | /workspace/seattle/alpha");
    expect(frame).toContain("workspace workspace_repo_alpha | main");
  });

  test("renders archived workspace mode on narrow terminals", () => {
    const frame = stripAnsi(renderWorkspaceOverlay({
      workspaceRoot: "/workspace/seattle",
      repos: [],
      workspaces: [],
      archivedWorkspaces: [
        {
          id: "workspace_repo_alpha",
          primaryRepoId: "repo_alpha",
          branch: "feature/rfc",
          status: "archived",
          linkedRepoIds: [],
          archivedAt: "2026-04-23T00:00:00.000Z",
          createdAt: "2026-04-23T00:00:00.000Z",
          updatedAt: "2026-04-23T00:00:00.000Z",
        },
      ],
      overlayMode: "archives",
      selectedMenuIndex: 1,
      messageLines: ["Browsing archived workspaces."],
      terminalSize: {
        columns: 70,
        rows: 16,
      },
    }));

    expect(frame).toContain("Archived workspaces");
    expect(frame).toContain("> Archives");
    expect(frame).toContain("workspace_repo_alpha | feature/rfc");
    expect(frame).toContain("Browsing archived workspaces.");
  });

  test("shows empty-state text when no repos are registered", () => {
    const frame = stripAnsi(renderWorkspaceOverlay({
      workspaceRoot: "/workspace/seattle",
      repos: [],
      workspaces: [],
      archivedWorkspaces: [],
      overlayMode: "start",
      selectedMenuIndex: 0,
      messageLines: [],
      terminalSize: {
        columns: 80,
        rows: 14,
      },
    }));

    expect(frame).toContain("<no repos registered>");
  });
});
