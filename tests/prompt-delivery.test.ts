import { describe, expect, test } from "vitest";

import type { RunnerType } from "../src/domain/config/index.js";
import { findRunnerStartupBlocker, buildRunnerPromptSubmission } from "../src/shell/prompt-delivery.js";

describe("runner prompt submission", () => {
  test.each(["codex", "cursor", "claude", "pi"] satisfies RunnerType[])(
    "keeps the %s paste and submit key in separate writes",
    (runner) => {
      const submission = buildRunnerPromptSubmission(runner, "review this\nthen report");

      expect(submission).toEqual({
        paste: "\u001b[200~review this\nthen report\u001b[201~",
        submit: "\r",
        submitDelayMs: 50,
      });
      expect(submission.paste).not.toContain(submission.submit);
    },
  );
});

test("recognizes startup dialogs without treating an update banner as an input blocker", () => {
  expect(findRunnerStartupBlocker("codex", "Trust this folder?\n1. Trust and continue\n2. Quit")).toContain("folder trust");
  expect(findRunnerStartupBlocker("codex", "Update available!\n1. Update now\n2. Skip")).toContain("update dialog");
  expect(findRunnerStartupBlocker("cursor", "Press any key to log in...")).toContain("authentication");
  expect(findRunnerStartupBlocker("codex", "Update available! Run npm install -g @openai/codex\nAsk Codex to do anything")).toBeNull();
});
