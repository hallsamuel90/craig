// Bundled into the Bun executable; dependencies load normally after extraction.
import archive from "./payload.tgz" with { type: "file" };
import { execFileSync } from "node:child_process";
import { lstatSync, mkdirSync, mkdtempSync, existsSync, readFileSync, renameSync, rmSync } from "node:fs";
import { homedir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

const base = path.join(homedir(), "Library/Caches/craig-binary-spike");
mkdirSync(base, { recursive: true, mode: 0o700 });
const info = lstatSync(base);
if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("Unsafe spike cache");
const directory = path.join(base, "PAYLOAD_HASH");
if (!existsSync(directory)) {
  const staging = mkdtempSync(path.join(base, ".extract-"));
  try {
    execFileSync("/usr/bin/tar", ["-xzf", "-", "-C", staging], { input: readFileSync(archive) });
    try { renameSync(staging, directory); }
    catch (error) { if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error; }
  } finally { rmSync(staging, { recursive: true, force: true }); }
}
process.argv[1] = path.join(directory, "cli.js");
await import(pathToFileURL(process.argv[1]).href);
