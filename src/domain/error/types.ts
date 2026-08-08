export type CraigErrorCode =
  | "CLI_USAGE"
  | "INPUT_REQUIRED"
  | "WORKSPACE_CONTEXT_NOT_FOUND"
  | "WORKSPACE_CONTEXT_INVALID"
  | "WORKSPACE_NOT_FOUND"
  | "WORKSPACE_RECORD_INVALID"
  | "TASK_CONTEXT_NOT_FOUND"
  | "TASK_CONTEXT_AMBIGUOUS"
  | "TASK_CONTEXT_CONFLICT"
  | "TASK_NOT_FOUND"
  | "TASK_RECORD_INVALID"
  | "REPO_NOT_FOUND"
  | "REPO_RECORD_INVALID"
  | "PR_REPOSITORY_MISMATCH"
  | "PR_BRANCH_MISMATCH"
  | "EXTERNAL_DEPENDENCY_FAILED"
  | "OPERATION_TIMEOUT"
  | "OPERATION_CANCELLED"
  | "EVENT_CURSOR_INVALID"
  | "EVENT_CURSOR_EXPIRED"
  | "EVENT_JOURNAL_CORRUPT"
  | "COMMAND_NOT_FOUND"
  | "COMMAND_RECORD_INVALID"
  | "COMMAND_STATE_CONFLICT"
  | "CAPABILITY_NOT_FOUND"
  | "CAPABILITY_RECORD_INVALID"
  | "CAPABILITY_DENIED"
  | "DELEGATION_LIMIT_EXCEEDED"
  | "SWARM_DEFINITION_INVALID"
  | "SWARM_INPUT_INVALID"
  | "PARTIAL_RESULT"
  | "INTERNAL_ERROR";

export type CraigExitCode = 1 | 2 | 3 | 4 | 5 | 6 | 7;

export const CRAIG_EXIT_CODE_BY_ERROR = {
  CLI_USAGE: 2,
  INPUT_REQUIRED: 2,
  WORKSPACE_CONTEXT_NOT_FOUND: 3,
  WORKSPACE_CONTEXT_INVALID: 4,
  WORKSPACE_NOT_FOUND: 3,
  WORKSPACE_RECORD_INVALID: 2,
  TASK_CONTEXT_NOT_FOUND: 3,
  TASK_CONTEXT_AMBIGUOUS: 4,
  TASK_CONTEXT_CONFLICT: 4,
  TASK_NOT_FOUND: 3,
  TASK_RECORD_INVALID: 2,
  REPO_NOT_FOUND: 3,
  REPO_RECORD_INVALID: 2,
  PR_REPOSITORY_MISMATCH: 4,
  PR_BRANCH_MISMATCH: 4,
  EXTERNAL_DEPENDENCY_FAILED: 5,
  OPERATION_TIMEOUT: 6,
  OPERATION_CANCELLED: 6,
  EVENT_CURSOR_INVALID: 2,
  EVENT_CURSOR_EXPIRED: 4,
  EVENT_JOURNAL_CORRUPT: 2,
  COMMAND_NOT_FOUND: 3,
  COMMAND_RECORD_INVALID: 2,
  COMMAND_STATE_CONFLICT: 4,
  CAPABILITY_NOT_FOUND: 3,
  CAPABILITY_RECORD_INVALID: 2,
  CAPABILITY_DENIED: 4,
  DELEGATION_LIMIT_EXCEEDED: 4,
  SWARM_DEFINITION_INVALID: 2,
  SWARM_INPUT_INVALID: 2,
  PARTIAL_RESULT: 7,
  INTERNAL_ERROR: 1,
} as const satisfies Record<CraigErrorCode, CraigExitCode>;

export interface CraigErrorDetails {
  [key: string]: unknown;
}

export interface CraigErrorOptions {
  retryable?: boolean;
  details?: CraigErrorDetails;
  cause?: unknown;
}

export class CraigError extends Error {
  readonly code: CraigErrorCode;
  readonly exitCode: CraigExitCode;
  readonly retryable: boolean;
  readonly details: CraigErrorDetails;

  constructor(code: CraigErrorCode, message: string, options: CraigErrorOptions) {
    super(message, options.cause === undefined ? undefined : { cause: options.cause });
    this.name = "CraigError";
    this.code = code;
    this.exitCode = CRAIG_EXIT_CODE_BY_ERROR[code];
    this.retryable = options.retryable ?? false;
    this.details = options.details ?? {};
  }
}

export function toCraigError(error: unknown): CraigError {
  if (error instanceof CraigError) {
    return error;
  }

  return new CraigError(
    "INTERNAL_ERROR",
    error instanceof Error ? error.message : "Unknown Craig error",
    { cause: error },
  );
}
