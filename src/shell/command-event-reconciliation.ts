import path from "node:path";

import {
  appendPromptCommandEvent,
  listPromptCommands,
  type CraigActor,
  type PromptDispatch,
} from "../domain/orchestration/index.js";
import { atomicWriteJson, readJsonIfExists } from "../shared/atomic-write.js";
import type { CraigPaths } from "../state/craig-paths.js";

interface CommandEventCheckpoint {
  version: 1;
  commands: Record<string, string[]>;
}

const SYSTEM_ACTOR: CraigActor = { type: "system", component: "orchestration-supervisor" };

export async function reconcilePromptCommandEvents(paths: CraigPaths): Promise<void> {
  const checkpointPath = path.join(paths.orchestrationDir, "command-event-reconciliation.json");
  const checkpoint = await readJsonIfExists<CommandEventCheckpoint>(checkpointPath) ?? { version: 1, commands: {} };
  const commands = await listPromptCommands(paths);
  let changed = false;
  for (const command of commands) {
    const recorded = new Set(checkpoint.commands[command.id] ?? []);
    for (const eventType of desiredEventTypes(command)) {
      if (recorded.has(eventType)) continue;
      await appendPromptCommandEvent(
        paths,
        command,
        eventType,
        eventType === "command.queued"
          ? command.actor
          : eventType === "command.cancelled"
            ? command.cancelledBy ?? command.actor
            : SYSTEM_ACTOR,
      );
      recorded.add(eventType);
      changed = true;
    }
    checkpoint.commands[command.id] = [...recorded];
  }
  if (changed) await atomicWriteJson(checkpointPath, checkpoint);
}

function desiredEventTypes(command: PromptDispatch): string[] {
  const events = ["command.queued"];
  if (command.attempts > 0) events.push("command.delivering");
  if (command.state === "delivered") events.push("command.delivered");
  else if (command.state === "failed") events.push("command.failed");
  else if (command.state === "cancelled") events.push("command.cancelled");
  return events;
}
