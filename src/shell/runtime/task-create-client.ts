import { RuntimeAcknowledgementUncertainError } from "../../domain/runtime/errors.js";
import { RuntimeTransport } from "./wire.js";
import { getClientRuntimeEndpoint } from "./endpoint.js";
import type { CraigPaths } from "../../state/craig-paths.js";
import type { TaskCreateRequest, TaskCreateResult } from "./task-create.js";

export async function submitRuntimeTaskCreate(paths: CraigPaths, operationId: string, request: TaskCreateRequest): Promise<TaskCreateResult> {
  const transport = await RuntimeTransport.connect(getClientRuntimeEndpoint(paths).socketPath);
  try {
    const response = await transport.request({ type: "submitTaskCreate", operationId, request }, 120000);
    return response.result as TaskCreateResult;
  } catch (error) {
    if (error instanceof RuntimeAcknowledgementUncertainError) throw new RuntimeAcknowledgementUncertainError(`Task-create operation ${operationId} may still be running. Inspect/resubmit this same operation id; do not issue a fresh create. ${error.message}`);
    throw error;
  } finally { transport.close(); }
}
