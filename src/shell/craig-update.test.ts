import type { ChildProcess } from "node:child_process";
import { EventEmitter } from "node:events";

import { describe, expect, test, vi } from "vitest";

import { installCraigUpdate, restartCraig } from "./craig-update.js";

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

describe("restartCraig", () => {
  test("launches the installed global Craig bundle with the original process context", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "/opt/npm/lib/node_modules\n", stderr: "" }));
    const access = vi.fn(async () => undefined);
    const child = new EventEmitter() as ChildProcess;
    const spawn = vi.fn(() => child);
    const env = { PATH: "/bin" };

    const result = restartCraig(
      { argv: ["--help"], cwd: "/workspace", env, nodePath: "/usr/bin/node" },
      { runCommand, access, spawn },
    );
    await vi.waitFor(() => expect(spawn).toHaveBeenCalled());
    child.emit("exit", 0, null);

    await expect(result).resolves.toBe(0);
    expect(runCommand).toHaveBeenCalledWith("npm", ["root", "--global"], { cwd: "/workspace", env });
    expect(access).toHaveBeenCalledWith("/opt/npm/lib/node_modules/craig-cli/dist/cli.js");
    expect(spawn).toHaveBeenCalledWith(
      "/usr/bin/node",
      ["/opt/npm/lib/node_modules/craig-cli/dist/cli.js", "--help"],
      { cwd: "/workspace", env, stdio: "inherit" },
    );
  });

  test("rejects when npm cannot locate the global package directory", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "\n", stderr: "" }));
    const access = vi.fn(async () => undefined);
    const spawn = vi.fn();

    await expect(restartCraig(
      { argv: [], cwd: "/workspace", env: {}, nodePath: "/usr/bin/node" },
      { runCommand, access, spawn },
    )).rejects.toThrow("global package directory");
    expect(access).not.toHaveBeenCalled();
    expect(spawn).not.toHaveBeenCalled();
  });

  test("rejects before spawning when the installed Craig bundle is missing", async () => {
    const runCommand = vi.fn(async () => ({ stdout: "/opt/npm/lib/node_modules\n", stderr: "" }));
    const access = vi.fn(async () => { throw new Error("bundle not found"); });
    const spawn = vi.fn();

    await expect(restartCraig(
      { argv: [], cwd: "/workspace", env: {}, nodePath: "/usr/bin/node" },
      { runCommand, access, spawn },
    )).rejects.toThrow("bundle not found");
    expect(spawn).not.toHaveBeenCalled();
  });
});
