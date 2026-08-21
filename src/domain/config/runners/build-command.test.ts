import { describe, expect, test } from "vitest";
import { buildCommand } from "./build-command.js";

describe("buildCommand", () => {
  test("returns executable only when no prompt", () => {
    expect(buildCommand("codex")).toEqual(["codex"]);
  });

  test("appends prompt when provided", () => {
    expect(buildCommand("codex", "fix the bug")).toEqual(["codex", "fix the bug"]);
  });

  test("omits empty prompt", () => {
    expect(buildCommand("codex", "")).toEqual(["codex"]);
  });

  test("uses configured path from config", () => {
    const config = { runners: { codex: { path: "/usr/local/bin/codex" } } };
    expect(buildCommand("codex", undefined, config)).toEqual(["/usr/local/bin/codex"]);
  });

  test("uses cursor-agent executable for cursor", () => {
    expect(buildCommand("cursor")).toEqual(["cursor-agent"]);
  });

  test("uses the Pi interactive CLI with the task prompt", () => {
    expect(buildCommand("pi", "fix the bug")).toEqual(["pi", "fix the bug"]);
  });
});
