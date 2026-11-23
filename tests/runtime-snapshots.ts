import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";

const execute = promisify(execFile);
/** Frozen public build inputs: no Git history, installed dependencies or build output. */
export async function extractRuntimeSnapshot(name: "pre-rfc-package" | "phase2-runtime", destination: string): Promise<void> {
  const manifest = JSON.parse(await readFile(new URL("./fixtures/lifecycle/runtime-snapshots.json", import.meta.url), "utf8")) as Record<string, { sha256: string }>;
  const archive = new URL(`./fixtures/lifecycle/${name}.tar.gz`, import.meta.url);
  if (createHash("sha256").update(await readFile(archive)).digest("hex") !== manifest[name]?.sha256) throw new Error("Frozen runtime fixture checksum mismatch.");
  await execute("tar", ["-xzf", fileURLToPath(archive), "-C", destination]);
}
