import { CraigError } from "../error/index.js";
/** Transport acknowledgement loss is not evidence of agent startup failure. */
export class RuntimeAcknowledgementUncertainError extends Error {
  override readonly name = "RuntimeAcknowledgementUncertainError";
}

/** The service gate rejected this operation before any mutation was admitted. */
export class RuntimeUpgradeRetryError extends CraigError {
  constructor(message = "CRAIG_UPGRADE_RETRY: control is updating; this operation was not admitted. Retry with the same identity.") {
    super("COMMAND_STATE_CONFLICT", message, { retryable: true, details: { reason: "runtime_updating", admitted: false } });
  }
}
