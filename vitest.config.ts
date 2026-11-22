import { execFileSync } from "node:child_process";

import { defineConfig } from "vitest/config";

execFileSync(process.execPath, [new URL("./scripts/prepare-ghostty.mjs", import.meta.url).pathname], { stdio: "inherit" });

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts", "src/**/*.test.ts"],
  },
});
