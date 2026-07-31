import type { CommandResult, CommandTaskPrResult } from "./types.js";
import type { CraigError } from "../domain/error/index.js";

type JsonSuccessData =
  | Exclude<CommandResult, CommandTaskPrResult>
  | Omit<CommandTaskPrResult, "warnings">;

interface JsonSuccessEnvelope {
  schemaVersion: 1;
  command: string;
  ok: true;
  data: JsonSuccessData;
  warnings: string[];
}

interface JsonErrorEnvelope {
  schemaVersion: 1;
  command: string;
  ok: false;
  error: {
    code: CraigError["code"];
    message: string;
    retryable: boolean;
    details: CraigError["details"];
  };
}

export function formatJsonSuccess(command: string, result: CommandResult): string {
  const { data, warnings } = splitResultWarnings(result);
  const envelope: JsonSuccessEnvelope = {
    schemaVersion: 1,
    command,
    ok: true,
    data,
    warnings,
  };
  return JSON.stringify(envelope);
}

function splitResultWarnings(result: CommandResult): {
  data: JsonSuccessData;
  warnings: string[];
} {
  if ("warnings" in result && Array.isArray(result.warnings)) {
    const { warnings, ...data } = result;
    return { data, warnings };
  }
  return { data: result, warnings: [] };
}

export function formatJsonError(command: string, error: CraigError): string {
  const envelope: JsonErrorEnvelope = {
    schemaVersion: 1,
    command,
    ok: false,
    error: {
      code: error.code,
      message: error.message,
      retryable: error.retryable,
      details: error.details,
    },
  };
  return JSON.stringify(envelope);
}
