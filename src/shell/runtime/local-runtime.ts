import { PtyRuntime as SessionCore, type PtyRuntimeOptions, type PtySessionSpec, type PtySize } from "./session-core.js";
import type { AgentCapabilitySession } from "../../domain/orchestration/index.js";
import type { TerminalEmulatorFactory } from "./terminal/terminal-emulator.js";
import type { RunnerType } from "../../domain/config/index.js";
import { findRunnerStartupBlocker } from "../prompt-delivery.js";
export * from "./session-core.js";

/** Legacy in-process adapter. Runner interpretation belongs above the session core. */
export class PtyRuntime extends SessionCore {
  private readonly specs = new Map<string, { taskId: string; spec: PtySessionSpec }>();
  private readonly resolveSpec: PtyRuntimeOptions["resolveSessionSpec"];
  constructor(options: PtyRuntimeOptions) { super(options); this.resolveSpec = options.resolveSessionSpec; }
  override ensureSession(taskId: string, tabId: string, size: PtySize, override?: PtySessionSpec, emulatorFactory?: TerminalEmulatorFactory) {
    const spec = override ?? this.resolveSpec?.(taskId, tabId);
    if (spec) this.specs.set(tabId, { taskId, spec });
    return super.ensureSession(taskId, tabId, size, spec, emulatorFactory);
  }
  getRunningAgentCapabilities(): AgentCapabilitySession[] {
    return [...this.specs].flatMap(([tabId, { taskId, spec }]) => this.hasRunningSession(tabId) && spec.env?.CRAIG_AGENT_CAPABILITY
      ? [{ taskId, agentTabId: tabId, capabilityToken: spec.env.CRAIG_AGENT_CAPABILITY }] : []);
  }
  getStartupBlocker(tabId: string, runner: RunnerType): string | null {
    const screen = this.getScreenText(tabId);
    return screen === null ? null : findRunnerStartupBlocker(runner, screen);
  }
}
