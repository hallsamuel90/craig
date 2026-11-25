import { createHash } from "node:crypto";
import { readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type { RuntimeHello } from "../../domain/runtime/types.js";
import { RUNTIME_CAPABILITIES } from "./compatibility.js";

declare const __CRAIG_VERSION__: string | undefined;
declare const __CRAIG_BUILD_ID__: string | undefined;
let identity: RuntimeHello | undefined;
export function runtimeIdentity(): RuntimeHello {
  if (identity) return identity;
  const craigVersion = typeof __CRAIG_VERSION__ === "undefined" ? "development" : __CRAIG_VERSION__;
  let buildId: string;
  if (typeof __CRAIG_BUILD_ID__ !== "undefined") buildId = __CRAIG_BUILD_ID__;
  else {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
    const hash = createHash("sha256");
    const visit = (relative: string): void => {
      const absolute = path.join(root, relative);
      for (const entry of readdirSync(absolute, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
        const name = path.join(relative, entry.name);
        if (entry.isDirectory()) visit(name);
        else if (entry.isFile()) hash.update(name).update(readFileSync(path.join(root, name)));
      }
    };
    visit("src");
    // A local tsc build can lag behind the sources beside it. Distinguish its
    // executable bytes from a tsx invocation of those newer sources.
    const compiled = fileURLToPath(import.meta.url).endsWith(".js");
    hash.update(compiled ? "compiled-runtime" : "source-runtime");
    if (compiled) visit("dist");
    for (const name of ["package.json", "packages/cli/package.json", "pnpm-lock.yaml", "tsconfig.json", "scripts/build-npm.mjs"]) hash.update(name).update(readFileSync(path.join(root, name)));
    buildId = hash.digest("hex");
  }
  return identity = { protocolVersion: 10, craigVersion, buildId, capabilities: RUNTIME_CAPABILITIES };
}
