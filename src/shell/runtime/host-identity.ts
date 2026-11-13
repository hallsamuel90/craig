import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

declare const __CRAIG_HOST_REVISION__: string | undefined;
let revision: string | undefined;
/** UI/control-only changes do not change the immutable host implementation id. */
export function sessionHostRevision(): string {
  if (typeof __CRAIG_HOST_REVISION__ !== "undefined") return __CRAIG_HOST_REVISION__;
  if (revision) return revision;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
  const hash = createHash("sha256");
  for (const relative of ["src/shell/runtime/session-host.ts", "src/shell/runtime/session-core.ts", "src/shell/runtime/wire.ts", "src/shell/runtime/records.ts", "src/shell/runtime/terminal/types.ts", "src/shell/runtime/terminal/terminal-emulator.ts", "src/shell/runtime/terminal/terminal-links.ts", "src/shell/runtime/terminal/terminal-scrollback.ts", "src/shell/runtime/discovery.ts", "src/shell/runtime/identity.ts", "src/shell/runtime/compatibility.ts", "src/shell/runtime/endpoint.ts", "src/shell/pty-daemon-protocol.ts", "src/shared/command-path.ts"]) hash.update(relative).update(readFileSync(path.join(root, relative)));
  const require = createRequire(import.meta.url);
  for (const name of ["node-pty", "@xterm/headless"]) hash.update(name).update(readFileSync(require.resolve(name)));
  hash.update(process.versions.modules ?? "");
  return revision = hash.digest("hex");
}
