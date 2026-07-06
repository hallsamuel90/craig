import path from "node:path";
import pc from "picocolors";

import type { CraigIndex } from "../domain/workspace/index.js";

const BANNER_ART = [
  "   ▄████▄   ██▀███   ▄▄▄       ██▓  ▄████",
  "  ▒██▀ ▀█  ▓██ ▒ ██▒▒████▄    ▓██▒ ██▒ ▀█▒",
  "  ▒▓█    ▄ ▓██ ░▄█ ▒▒██  ▀█▄  ▒██▒▒██░▄▄▄░",
  "  ▒▓▓▄ ▄██▒▒██▀▀█▄  ░██▄▄▄▄██ ░██░░▓█  ██▓",
  "  ▒ ▓███▀ ░░██▓ ▒██▒ ▓█   ▓██▒░██░░▒▓███▀▒",
  "  ░ ░▒ ▒  ░░ ▒▓ ░▒▓░ ▒▒   ▓▒█░░▓   ░▒   ▒",
  "    ░  ▒     ░▒ ░ ▒░  ▒   ▒▒ ░ ▒ ░  ░   ░",
  "  ░          ░░   ░   ░   ▒    ▒ ░░ ░   ░",
  "  ░ ░         ░           ░  ░ ░        ░",
  "  ░",
];

export function getBannerArtLines(): string[] {
  return [...BANNER_ART];
}

export function renderBanner(repoRoot: string, index: CraigIndex): string {
  const art = getBannerArtLines().map((line) => pc.green(line));

  const summary = [
    pc.green(pc.bold("     c r A I g   i s   t h a t   y o u ?")),
    "",
    pc.dim(`Workspace: ${path.basename(repoRoot)}`),
    pc.dim(`Root: ${repoRoot}`),
    pc.dim(`Tracked tasks: ${index.taskIds.length}`),
  ];

  return [...art, ...summary].join("\n");
}
