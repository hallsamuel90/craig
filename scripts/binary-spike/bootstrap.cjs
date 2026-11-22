// Embedded by build.mjs. This is a local spike, not a production installer.
/* global process, Buffer */
const fs = require("node:fs");
const path = require("node:path");
const os = require("node:os");
const { execFileSync } = require("node:child_process");
const { createRequire } = require("node:module");
const { getAsset } = require("node:sea");

const base = path.join(os.homedir(), "Library/Caches/craig-binary-spike");
fs.mkdirSync(base, { recursive: true, mode: 0o700 });
const info = fs.lstatSync(base);
if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) {
  throw new Error("Standalone spike cache must be a private directory owned by the current user.");
}
const directory = path.join(base, "PAYLOAD_HASH");
if (!fs.existsSync(directory)) {
  const staging = fs.mkdtempSync(path.join(base, ".extract-"));
  try {
    execFileSync("/usr/bin/tar", ["-xzf", "-", "-C", staging], { input: Buffer.from(getAsset("payload")) });
    try {
      fs.renameSync(staging, directory);
    } catch (error) {
      if (error.code !== "EEXIST" && error.code !== "ENOTEMPTY") throw error;
    }
  } finally {
    fs.rmSync(staging, { recursive: true, force: true });
  }
}
const entrypoint = path.join(directory, "cli.js");
// SEA starts with [binary, binary, ...userArgs]. Daemon children pass the disk
// entrypoint explicitly; replace that slot rather than adding a second script.
if (process.argv[2] === entrypoint) process.argv.splice(2, 1);
process.argv[1] = entrypoint;
createRequire(entrypoint)(path.join(directory, "launch.cjs"));
