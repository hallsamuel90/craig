import { isAlias, parseDocument, visit } from "yaml";

import { CraigError } from "../../error/index.js";

export const MAX_SWARM_DEFINITION_BYTES = 1024 * 1024;

export function parseSwarmYaml(source: string, sourceName: string): unknown {
  if (Buffer.byteLength(source) > MAX_SWARM_DEFINITION_BYTES) {
    invalid(sourceName, [`Definition exceeds ${MAX_SWARM_DEFINITION_BYTES} bytes.`]);
  }
  const document = parseDocument(source, {
    schema: "core",
    uniqueKeys: true,
    prettyErrors: true,
  });
  const structuralIssues: string[] = [];
  visit(document, (_key, node) => {
    if (isAlias(node)) structuralIssues.push("YAML aliases are not supported.");
    if (typeof node === "object" && node !== null && "anchor" in node && typeof node.anchor === "string") {
      structuralIssues.push("YAML anchors are not supported.");
    }
  });
  const issues = [
    ...document.errors.map((error) => error.message),
    ...document.warnings.map((warning) => warning.message),
    ...structuralIssues,
  ];
  if (issues.length > 0) invalid(sourceName, issues);
  if (document.contents === null) invalid(sourceName, ["Definition is empty."]);
  try {
    return document.toJS({ maxAliasCount: 0, mapAsMap: false });
  } catch (error) {
    invalid(sourceName, [error instanceof Error ? error.message : "YAML could not be decoded."]);
  }
}

function invalid(sourceName: string, issues: string[]): never {
  throw new CraigError("SWARM_DEFINITION_INVALID", `Swarm definition ${sourceName} is invalid: ${issues[0]}`, {
    details: { file: sourceName, issues: [...new Set(issues)] },
  });
}
