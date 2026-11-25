import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { cp, mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { materializeRuntimeDependencies } from "../src/shell/runtime/artifacts.js";
const execute = promisify(execFile);

/** Real build:npm + Changesets versioning + npm pack in disposable sources only. */
export async function buildPackagedUpgradeFixtures(root: string) {
  const sourceRoot = process.cwd();
  const result: Record<string, { binary: string; installation: string; version: string }> = {};
  for (const name of ["a", "b"]) {
    const source = path.join(root, `source-${name}`); await mkdir(source, { recursive: true });
    for (const file of ["src", "scripts", "package.json", "pnpm-lock.yaml", "pnpm-workspace.yaml", "tsconfig.json", "packages/cli/package.json", "packages/cli/README.md"]) {
      const destination = path.join(source, file); await mkdir(path.dirname(destination), { recursive: true });
      await cp(path.join(sourceRoot, file), destination, { recursive: true });
    }
    await symlink(path.join(sourceRoot, "node_modules"), path.join(source, "node_modules"));
    if (name === "b") {
      await mkdir(path.join(source, ".changeset"));
      const config = JSON.parse(await readFile(path.join(sourceRoot, ".changeset/config.json"), "utf8"));
      await writeFile(path.join(source, ".changeset/config.json"), JSON.stringify({ ...config, changelog: false }));
      await writeFile(path.join(source, ".changeset/fixture-rollover.md"), '---\n"craig-cli": minor\n---\n\nIsolated package upgrade fixture.\n');
      await execute("pnpm", ["version-packages"], { cwd: source });
      const host = path.join(source, "src/shell/runtime/session-host.ts");
      await writeFile(host, (await readFile(host, "utf8")) + "\n// Packaged fixture B: changed immutable host implementation input.\n");
    }
    await execute("pnpm", ["build:npm"], { cwd: source });
    const destination = path.join(root, `pack-${name}`); await mkdir(destination);
    await execute("npm", ["pack", "--ignore-scripts", "--pack-destination", destination], { cwd: path.join(source, "packages/cli") });
    const tarball = (await readdir(destination)).find((file) => file.endsWith(".tgz"))!;
    const installation = path.join(root, `installation-${name}`); await mkdir(installation);
    await execute("tar", ["-xf", path.join(destination, tarball), "-C", installation]);
    const packageDirectory = path.join(installation, "package");
    await materializeRuntimeDependencies(path.join(source, "packages/cli/dist/cli.js"), packageDirectory);
    result[name] = { binary: path.join(packageDirectory, "dist/cli.js"), installation, version: JSON.parse(await readFile(path.join(packageDirectory, "package.json"), "utf8")).version };
  }
  return { a: result.a!, b: result.b! };
}
