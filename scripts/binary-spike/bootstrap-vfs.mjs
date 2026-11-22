// Node 26 SEA VFS experiment. Only the native addon is materialized on disk.
import { createHash } from "node:crypto";
import { existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { homedir, tmpdir } from "node:os";
import path from "node:path";

const cacheNative = false;
const bytes = readFileSync(new URL("./node_modules/node-pty/build/Release/pty.node", import.meta.url));
let native;
if (cacheNative) {
  const base = path.join(homedir(), "Library/Caches/craig-binary-spike");
  mkdirSync(base, { recursive: true, mode: 0o700 });
  const info = lstatSync(base);
  if (!info.isDirectory() || info.uid !== process.getuid() || (info.mode & 0o077) !== 0) throw new Error("Unsafe spike cache");
  native = path.join(base, `${createHash("sha256").update(bytes).digest("hex")}.node`);
  if (!existsSync(native)) {
    const staging = mkdtempSync(path.join(base, ".native-"));
    try {
      writeFileSync(path.join(staging, "pty.node"), bytes, { mode: 0o600 });
      renameSync(path.join(staging, "pty.node"), native);
    } finally { rmSync(staging, { recursive: true, force: true }); }
  }
  globalThis.__CRAIG_NATIVE_ADDON__ = createRequire(import.meta.url)(native);
} else {
  const temporary = mkdtempSync(path.join(tmpdir(), "craig-sea-native-"));
  try {
    native = path.join(temporary, "pty.node");
    writeFileSync(native, bytes, { mode: 0o600 });
    globalThis.__CRAIG_NATIVE_ADDON__ = createRequire(import.meta.url)(native);
  } finally {
    // On macOS a loaded dylib remains mapped after unlink.
    rmSync(temporary, { recursive: true, force: true });
  }
}
process.argv[1] = new URL("./cli.js", import.meta.url).pathname;
await import("./cli.js");
