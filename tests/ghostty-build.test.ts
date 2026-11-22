import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";

import { expect, test } from "vitest";

const run = promisify(execFile);
test("Ghostty builds fail closed for missing offline assets and corrupted cache bytes", async () => {
  const cacheDir = await mkdtemp(join(tmpdir(), "craig-ghostty-build-"));
  try {
    const script = new URL("../scripts/prepare-ghostty.mjs", import.meta.url).href;
    const code = `import { prepareGhostty } from ${JSON.stringify(script)}; await prepareGhostty({cacheDir:${JSON.stringify(cacheDir)},offline:true});`;
    await expect(run(process.execPath, ["--input-type=module", "-e", code])).rejects.toMatchObject({ stderr: expect.stringContaining("verified Ghostty build cache is missing") });
    await writeFile(join(cacheDir, "ghostty-vt-1.0.0.wasm"), "wrong artifact");
    await expect(run(process.execPath, ["--input-type=module", "-e", code])).rejects.toMatchObject({ stderr: expect.stringContaining("checksum mismatch") });
  } finally { await rm(cacheDir, { recursive: true, force: true }); }
});
