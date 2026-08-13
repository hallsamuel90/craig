import { describe, expect, test } from "vitest";

import { isEnabled, setEnabled } from "./index.js";

describe("feature preview config", () => {
  test("defaults previews off and enables one without changing other config", () => {
    const config = { github: { mergeMethod: "squash" as const } };

    expect(isEnabled(config, "agentOrchestration")).toBe(false);
    expect(setEnabled(config, "agentOrchestration", true)).toEqual({
      github: { mergeMethod: "squash" },
      previews: { agentOrchestration: true },
    });
  });
});
