import type { CommandResult } from "./types.js";
import type { CraigError } from "../domain/error/index.js";

interface JsonSuccessEnvelope {
  schemaVersion: 1;
  command: string;
  ok: true;
  data: CommandResult;
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
  const envelope: JsonSuccessEnvelope = {
    schemaVersion: 1,
    command,
    ok: true,
    data: result,
    warnings: [],
  };
  return JSON.stringify(envelope);
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
