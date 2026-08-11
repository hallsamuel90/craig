import { describe, expect, test } from "vitest";

import type { RunnerType } from "../src/domain/config/index.js";
import { buildRunnerPromptSubmission } from "../src/shell/prompt-delivery.js";

describe("runner prompt submission", () => {
  test.each(["codex", "cursor", "claude"] satisfies RunnerType[])(
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
