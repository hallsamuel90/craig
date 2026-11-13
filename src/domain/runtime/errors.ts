/** Transport acknowledgement loss is not evidence of agent startup failure. */
export class RuntimeAcknowledgementUncertainError extends Error {
  override readonly name = "RuntimeAcknowledgementUncertainError";
}
