import type { AgentRuntimeState, PtyActivitySnapshot } from "../domain/agent/index.js";

export type { PtyActivitySnapshot } from "../domain/agent/index.js";
export type AgentActivityState = AgentRuntimeState;
export {
  AGENT_READY_AFTER_MS,
  getAgentTabActivity,
  getTaskAgentTabActivity,
  getTaskAgentActivity,
  hasWorkingAgentActivity,
} from "../domain/agent/index.js";

export interface AgentActivityPresentation {
  snapshots: readonly PtyActivitySnapshot[];
  now: number;
  animationFrame: number;
}

export const AGENT_ACTIVITY_ANIMATION_INTERVAL_MS = 150;
export const AGENT_ACTIVITY_ANIMATION_FRAMES = 6;
