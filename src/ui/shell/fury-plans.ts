import { stripVTControlCharacters } from "node:util";

import { configService } from "../../domain/config/index.js";
import { CraigError } from "../../domain/error/index.js";
import { listPendingFuryPlans, type FuryPlan } from "../../domain/orchestration/index.js";
import { approvePlan } from "../../shell/fury-runtime.js";
import type { AppContext } from "../app-context.js";
import { characterWidth } from "../render.js";
import type { Viewport } from "../layout.js";
import { isEnterKey, restoreShellState } from "../state.js";

export interface FuryPlansView {
  plans: FuryPlan[];
  selectedIndex: number;
  plan: FuryPlan | null;
  scrollOffset: number;
  confirming: boolean;
  busy: boolean;
  message: string | null;
}

export async function refreshPendingFuryPlans(ctx: AppContext, signal?: AbortSignal): Promise<void> {
  const plans = configService.previews.isEnabled(ctx.config, "agentOrchestration")
    ? await listPendingFuryPlans(ctx.paths) : [];
  if (signal?.aborted) return;
  let changed = false;
  if (JSON.stringify(plans) !== JSON.stringify(ctx.model.furyPendingPlans ?? [])) {
    const previousCount = ctx.model.furyPendingPlans?.length ?? 0;
    ctx.model = { ...ctx.model, furyPendingPlans: plans,
      furyApprovalCount: Math.max(0, (ctx.model.furyApprovalCount ?? 0) - previousCount) + plans.length };
    changed = true;
  }
  if (ctx.state.mode === "overlay" && ctx.state.variant === "fury-plans" && ctx.state.furyPlans) {
    const view = ctx.state.furyPlans;
    if (!view.plan && !view.busy && JSON.stringify(view.plans) !== JSON.stringify(plans)) {
      const selectedId = view.plans[view.selectedIndex]?.id;
      ctx.state = { ...ctx.state, furyPlans: { ...view, plans,
        selectedIndex: Math.max(0, plans.findIndex((plan) => plan.id === selectedId)) } };
      changed = true;
    }
  }
  if (changed) ctx.render();
}

export function openFuryPlans(ctx: AppContext): void {
  if (!configService.previews.isEnabled(ctx.config, "agentOrchestration")) return;
  ctx.state = { mode: "overlay", variant: "fury-plans", menuIndex: 0, optionsMessage: null,
    shell: ctx.state.shell, furyPlans: { plans: ctx.model.furyPendingPlans ?? [], selectedIndex: 0,
      plan: null, scrollOffset: 0, confirming: false, busy: false, message: null } };
  ctx.pendingClear = true;
  ctx.render();
  void refreshPendingFuryPlans(ctx).then(() => {
    if (ctx.state.mode !== "overlay" || ctx.state.variant !== "fury-plans" || !ctx.state.furyPlans || ctx.state.furyPlans.plan) return;
    ctx.state = { ...ctx.state, furyPlans: { ...ctx.state.furyPlans, plans: ctx.model.furyPendingPlans ?? [] } };
    ctx.render();
  }).catch((error: unknown) => {
    if (ctx.state.mode !== "overlay" || ctx.state.variant !== "fury-plans" || !ctx.state.furyPlans) return;
    ctx.state = { ...ctx.state, furyPlans: { ...ctx.state.furyPlans, message: errorMessage(error) } };
    ctx.render();
  });
}

export function handleFuryPlansKey(ctx: AppContext, key: string): void {
  if (ctx.state.mode !== "overlay" || !ctx.state.furyPlans) return;
  const view = ctx.state.furyPlans;
  if (view.busy) return;
  const update = (next: FuryPlansView) => {
    if (ctx.state.mode !== "overlay") return;
    ctx.state = { ...ctx.state, furyPlans: next };
    ctx.render();
  };
  if (key === "ESCAPE") {
    if (view.confirming) update({ ...view, confirming: false });
    else if (view.plan) update({ ...view, plan: null, scrollOffset: 0, message: null, plans: ctx.model.furyPendingPlans ?? [], selectedIndex: 0 });
    else { ctx.state = { mode: "main", shell: restoreShellState(ctx.state.shell, ctx.model) }; ctx.pendingClear = true; ctx.render(); }
    return;
  }
  if (!view.plan) {
    if (key === "UP" || key === "k") update({ ...view, selectedIndex: Math.max(0, view.selectedIndex - 1) });
    else if (key === "DOWN" || key === "j") update({ ...view, selectedIndex: Math.min(Math.max(0, view.plans.length - 1), view.selectedIndex + 1) });
    else if (isEnterKey(key) && view.plans[view.selectedIndex]) update({ ...view, plan: view.plans[view.selectedIndex]!, scrollOffset: 0, message: null });
    return;
  }
  if (view.confirming) {
    if (!isEnterKey(key)) return;
    const plan = view.plan;
    update({ ...view, busy: true, message: "Approving plan..." });
    void (async () => {
      const pending = await listPendingFuryPlans(ctx.paths);
      if (!pending.some((candidate) => candidate.id === plan.id && candidate.planHash === plan.planHash)) {
        await refreshPendingFuryPlans(ctx);
        throw new CraigError("FURY_STATE_CONFLICT", "This plan was replaced or already approved. Return to the list and review the current plan.", {});
      }
      await approvePlan(ctx.paths, plan.id, { type: "human", source: "tui", processId: process.pid }, plan.planHash);
      await refreshPendingFuryPlans(ctx);
      update({ ...view, plans: ctx.model.furyPendingPlans ?? [], selectedIndex: 0, plan: null, confirming: false,
        busy: false, scrollOffset: 0, message: "Plan approved. No workers started; the planning agent can now start it." });
    })().catch((error: unknown) => update({ ...view, confirming: false, busy: false, message: errorMessage(error) }));
    return;
  }
  if (key === "a" || key === "A") update({ ...view, confirming: true, message: null });
  else if (["UP", "k", "DOWN", "j", "PAGE_UP", "PAGE_DOWN", "HOME", "END"].includes(key)) {
    const page = Math.max(1, (ctx.activeTerminal.height ?? 36) - 7);
    const maxOffset = Math.max(0, planLines(view.plan, (ctx.activeTerminal.width ?? 120) - 4).length - page);
    const delta = key === "PAGE_UP" ? -page : key === "PAGE_DOWN" ? page : key === "UP" || key === "k" ? -1 : 1;
    update({ ...view, scrollOffset: key === "HOME" ? 0 : key === "END" ? maxOffset : Math.max(0, Math.min(maxOffset, view.scrollOffset + delta)) });
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Could not approve the Fury plan. Try again.";
}

function wrap(value: string, width: number): string[] {
  const clean = Array.from(stripVTControlCharacters(value)).map((character) => {
    const code = character.codePointAt(0)!;
    return (code < 32 && code !== 10) || (code >= 127 && code <= 159) ? " " : character;
  }).join("");
  return clean.split("\n").flatMap((line) => {
    const characters = Array.from(line);
    if (!characters.length) return [""];
    const rows: string[] = [];
    let row = "";
    let used = 0;
    for (const character of characters) {
      const size = characterWidth(character);
      if (used + size > width && row) { rows.push(row); row = ""; used = 0; }
      row += character; used += size;
    }
    if (row) rows.push(row);
    return rows;
  });
}

function planLines(plan: FuryPlan, width: number): string[] {
  return [plan.name, `Root task: ${plan.rootTaskId}`, `Definition: ${plan.sourceFile}`,
    `Limits: ${plan.limits.maxTasks} tasks | ${plan.limits.maxConcurrency} concurrent | ${plan.limits.timeoutMs / 1000}s timeout`,
    `Inputs: ${JSON.stringify(plan.inputs)}`, `Plan: ${plan.id}`, `Hash: ${plan.planHash}`, "",
    ...plan.steps.flatMap((step) => [
      `${step.id} | ${step.kind === "human_review" ? "HUMAN REVIEW" : step.runner} | needs: ${step.needs.join(", ") || "none"}`,
      `Target: ${JSON.stringify(step.target)}`,
      ...(step.prompt ? [`Prompt: ${step.prompt}`] : []),
      ...(step.outputSchema ? [`Output: ${JSON.stringify(step.outputSchema)}`] : []),
      ...(step.review ? [`Review: ${step.review.title}`, step.review.summary,
        `Feedback target: ${step.review.feedbackTask ?? "none"} | timeout: ${step.review.timeoutMs / 1000}s`] : []), "",
    ]),
  ].flatMap((line) => wrap(line, Math.max(1, width)));
}

export function renderFuryPlansFrame(viewport: Viewport, view: FuryPlansView): string {
  const width = Math.max(1, viewport.width - 4);
  const page = Math.max(1, viewport.height - 7);
  let lines: string[];
  if (view.confirming && view.plan) {
    lines = [`Approve ${view.plan.name}?`, "", `Plan: ${view.plan.id}`, `Hash: ${view.plan.planHash}`, "",
      "This approves the exact plan you reviewed. It does not start workers."];
  } else if (view.plan) {
    lines = planLines(view.plan, width).slice(view.scrollOffset, view.scrollOffset + page);
  } else {
    const offset = Math.max(0, view.selectedIndex - page + 1);
    lines = view.plans.length ? view.plans.slice(offset, offset + page).map((plan, index) =>
      `${view.selectedIndex === offset + index ? ">" : " "} ${plan.name} | ${plan.rootTaskId} | ${plan.steps.length} steps`)
      : ["No Fury plans waiting for approval."];
  }
  const rows = new Array<string>(viewport.height).fill("");
  rows[0] = "FURY PLANS — human approval";
  rows[1] = view.plan && !view.confirming ? `Plan details | line ${view.scrollOffset + 1} | a approve | Esc back` : "";
  lines.slice(0, page).forEach((line, index) => { rows[index + 3] = line; });
  rows[viewport.height - 3] = view.message ?? "";
  rows[viewport.height - 1] = view.busy ? "Saving approval..." : view.confirming ? "Enter approve this plan   Esc back" : view.plan
    ? "↑↓ / PgUp / PgDn scroll   Home / End   a approve plan   Esc back"
    : "↑↓ select   Enter review plan   Esc return";
  return rows.map((row) => {
    const text = `  ${wrap(row, width)[0] ?? ""}`;
    const used = Array.from(text).reduce((sum, character) => sum + characterWidth(character), 0);
    return text + " ".repeat(Math.max(0, viewport.width - used));
  }).join("\n");
}
