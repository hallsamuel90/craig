import { describe, expect, test, vi } from "vitest";

import { installCraigUpdate } from "./craig-update.js";

describe("installCraigUpdate", () => {
  test("installs an exact stable version without a shell command", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await installCraigUpdate("0.14.0", { runCommand });

    expect(runCommand).toHaveBeenCalledWith("npm", ["install", "--global", "craig-cli@0.14.0"]);
  });

  test("rejects untrusted version strings before spawning npm", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "", stderr: "" }));

    await expect(installCraigUpdate("latest && echo nope", { runCommand })).rejects.toThrow("invalid Craig version");
    expect(runCommand).not.toHaveBeenCalled();
  });
});
