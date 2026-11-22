import { stripVTControlCharacters } from "node:util";

import { configService } from "../../domain/config/index.js";
import { CraigError } from "../../domain/error/index.js";
import { listPendingFuryPlans, type FuryPlan } from "../../domain/orchestration/index.js";
import { approvePlan } from "../../shell/fury-runtime.js";
import type { AppContext } from "../app-context.js";
import { characterWidth } from "../render.js";
import { getFramedPanelBounds, getViewport, SHELL_LAYOUT, type Viewport } from "../layout.js";
import type { ShellData } from "./data.js";
import { isEnterKey } from "../state.js";

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
  if (ctx.state.mode === "main" && ctx.furyPlans) {
    const view = ctx.furyPlans;
    if (!view.plan && !view.busy && JSON.stringify(view.plans) !== JSON.stringify(plans)) {
      const selectedId = view.plans[view.selectedIndex]?.id;
      ctx.furyPlans = { ...view, plans,
        selectedIndex: Math.max(0, plans.findIndex((plan) => plan.id === selectedId)) };
      changed = true;
    }
  }
  if (changed) ctx.render();
}

export function openFuryPlans(ctx: AppContext): void {
  if (!configService.previews.isEnabled(ctx.config, "agentOrchestration")) return;
  if (ctx.state.mode !== "main") return;
  ctx.ptyRuntime.detach();
  ctx.furyPlans = { plans: ctx.model.furyPendingPlans ?? [], selectedIndex: 0,
    plan: null, scrollOffset: 0, confirming: false, busy: false, message: null };
  ctx.pendingClear = true;
  ctx.render();
  void refreshPendingFuryPlans(ctx).then(() => {
    if (ctx.state.mode !== "main" || !ctx.furyPlans || ctx.furyPlans.plan) return;
    ctx.furyPlans = { ...ctx.furyPlans, plans: ctx.model.furyPendingPlans ?? [] };
    ctx.render();
  }).catch((error: unknown) => {
    if (ctx.state.mode !== "main" || !ctx.furyPlans) return;
    ctx.furyPlans = { ...ctx.furyPlans, message: errorMessage(error) };
    ctx.render();
  });
}

export function handleFuryPlansKey(ctx: AppContext, key: string): void {
  if (ctx.state.mode !== "main" || !ctx.furyPlans) return;
  const view = ctx.furyPlans;
  if (view.busy) return;
  const update = (next: FuryPlansView) => {
    if (ctx.state.mode !== "main" || !ctx.furyPlans) return;
    ctx.furyPlans = next;
    ctx.render();
  };
  if (key === "TAB" || key === "SHIFT_TAB") {
    ctx.furyPlans = null;
    ctx.state = { mode: "main", shell: { ...ctx.state.shell, focusedRegion: "tasks" } };
    ctx.pendingClear = true;
    ctx.render();
    return;
  }
  if (key === "ESCAPE") {
    if (view.confirming) update({ ...view, confirming: false });
    else if (view.plan) update({ ...view, plan: null, scrollOffset: 0, message: null, plans: ctx.model.furyPendingPlans ?? [], selectedIndex: 0 });
    else { ctx.furyPlans = null; ctx.pendingClear = true; ctx.render(); }
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
    const { width, page } = furyContentSize(ctx);
    const maxOffset = Math.max(0, planLines(view.plan, width).length - page);
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
      if (used + size > width && row) {
        const lastSpace = row.lastIndexOf(" ");
        if (lastSpace > 0) {
          rows.push(row.slice(0, lastSpace));
          row = row.slice(lastSpace + 1);
          used = Array.from(row).reduce((sum, value) => sum + characterWidth(value), 0);
        } else { rows.push(row); row = ""; used = 0; }
      }
      row += character; used += size;
    }
    if (row) rows.push(row);
    return rows;
  });
}

function planLines(plan: FuryPlan, width: number): string[] {
  return [plan.name, "",
    `${plan.limits.maxTasks} tasks | ${plan.limits.maxConcurrency} concurrent | ${plan.limits.timeoutMs / 1000}s timeout`,
    "Review each worker's scope before approving.", "",
    ...plan.steps.flatMap((step, index) => [
      `${index + 1}. ${step.id} · ${step.kind === "human_review" ? "HUMAN REVIEW" : (step.runner?.toUpperCase() ?? "EXISTING AGENT")}`,
      `After: ${step.needs.join(", ") || "ready first"}`,
      ...(step.target?.type === "task" ? [`Task: ${step.target.task}`]
        : step.target?.type === "create_child" ? ["Creates a new child task",
          ...(step.target.repo ? [`Repository: ${step.target.repo}`] : []),
          ...(step.target.workspace ? [`Workspace: ${step.target.workspace}`] : [])] : []), "",
      ...(step.prompt ? [step.prompt, ""] : []),
      ...(step.outputSchema ? [`Output: ${JSON.stringify(step.outputSchema)}`] : []),
      ...(step.review ? [step.review.title, step.review.summary,
        `Feedback target: ${step.review.feedbackTask ?? "none"}`, `Review timeout: ${step.review.timeoutMs / 1000}s`] : []), "",
    ]),
    "PLAN IDENTITY", `Root task: ${plan.rootTaskId}`, `Definition: ${plan.sourceFile}`,
    `Inputs: ${JSON.stringify(plan.inputs)}`, `Plan: ${plan.id}`, `Hash: ${plan.planHash}`,
  ].flatMap((line) => wrap(line, Math.max(1, width)));
}

function furyContentSize(ctx: AppContext): { width: number; page: number } {
  return contentSize(getViewport(ctx.activeTerminal.width, ctx.activeTerminal.height),
    true, ctx.state.shell.centerZoomed, ctx.furyPlans?.message);
}

function contentSize(viewport: Viewport, panelPolish: boolean, zoomed: boolean, message?: string | null) {
  const width = panelPolish
    ? getFramedPanelBounds(viewport, zoomed).center.width - 6
    : zoomed ? viewport.width - 4
    : viewport.width - SHELL_LAYOUT.leftWidth - SHELL_LAYOUT.rightWidth - 6;
  const contentWidth = Math.max(1, width);
  const messageRows = wrap(message ?? "", contentWidth).length;
  return { width: contentWidth, page: Math.max(1, viewport.height - 12 - Math.max(0, messageRows - 1)) };
}

/** Present Fury as a native Craig surface; keep workspace navigation and activity visible. */
export function buildFuryPlansShellData(data: ShellData, view: FuryPlansView, viewport: Viewport,
  panelPolish: boolean, zoomed: boolean): ShellData {
  const { width, page } = contentSize(viewport, panelPolish, zoomed, view.message);
  const plan = view.plan ?? view.plans[view.selectedIndex] ?? null;
  const status = view.confirming ? "Confirm approval" : view.plan ? "Review plan" : "Waiting for approval";
  let lines: string[];
  if (view.confirming && view.plan) {
    lines = [`Approve ${view.plan.name}?`, "", "You are approving the exact plan you reviewed.",
      "No workers start until the planning agent starts this approved plan.", "", "Enter to approve · Esc to keep reviewing",
      "", `Plan fingerprint: ${view.plan.planHash}`].flatMap(line => wrap(line, width));
  } else if (view.plan) {
    const details = planLines(view.plan, width);
    const offset = Math.min(view.scrollOffset, Math.max(0, details.length - page));
    lines = details.slice(offset, offset + page);
  } else {
    const offset = Math.max(0, view.selectedIndex - page + 3);
    lines = view.plans.length ? ["Choose a plan to review", "", ...view.plans.slice(offset, offset + page - 2).map((candidate, index) =>
      `${view.selectedIndex === offset + index ? ">" : " "} ${candidate.name}`)]
      : ["No Fury plans waiting for approval.", "", "Your planning agent's next plan will appear here."];
  }
  return {
    ...data,
    inputMode: "control", focusedRegion: "center", modalInput: true,
    actionMessage: null,
    tabs: [...data.tabs.map(tab => ({ ...tab, active: false, focused: false })),
      { id: "fury-plans", label: "FURY PLANS", active: true, focused: true }],
    centerHeader: { ...data.centerHeader, tabLabel: "FURY PLANS", taskId: plan?.name ?? "Plan approvals" },
    centerTranscript: [{ text: status, tone: "focused" },
      ...wrap(view.message ?? "", width).map(text => ({ text, tone: "muted" as const })),
      ...lines.map(text => ({ text }))],
    footerText: view.busy ? "Saving approval..." : view.confirming ? "Enter approve this plan   Esc back"
      : view.plan ? "↑↓/wheel/PgUp/PgDn scroll   a approve plan   Esc plans   Tab tasks"
      : "↑↓ select   Enter review plan   Esc return to task   Tab tasks",
    rightContext: plan ? [
      { label: "Status", value: status },
      { label: "Root task", value: plan.rootTaskId },
      { label: "Workers", value: `${plan.limits.maxTasks} tasks` },
      { label: "Parallel", value: `${plan.limits.maxConcurrency} at a time` },
      { label: "Timeout", value: `${plan.limits.timeoutMs / 1000}s` },
    ] : [{ label: "Fury", value: "Plan approvals" }],
    rightInspection: { title: "FURY PLAN", rows: [
      { id: "fury-title", text: "FURY PLAN" },
      { id: "fury-spacer", text: "" },
      ...[
        `Status: ${status}`,
        ...(plan ? [`Workers: ${plan.limits.maxTasks} tasks`,
          `Parallel: ${plan.limits.maxConcurrency} at a time`,
          `Timeout: ${plan.limits.timeoutMs / 1000}s`, "", "Root task", plan.rootTaskId, "", "EXECUTION ORDER"] : []),
      ].flatMap((text, index) => wrap(text, 26).map((row, line) => ({ id: `fury-scope:${index}:${line}`, text: row }))),
      ...(plan ? plan.steps.flatMap((step, index) => [
        { id: `fury-step:${step.id}`, text: `${index + 1}. ${step.id}` },
        { id: `fury-runner:${step.id}`, text: step.kind === "human_review" ? "Human review" : step.runner ?? "Existing agent", muted: true },
        { id: `fury-needs:${step.id}`, text: step.needs.length ? "After " + step.needs.join(", ") : "Ready first", muted: true },
      ]) : []),
    ] },
  };
}
