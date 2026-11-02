import { stripVTControlCharacters } from "node:util";
import { describe, expect, test } from "vitest";
import { getMockShellData } from "../src/ui/mock-data.js";
import { renderMainShellPresentation, renderBootOverlayFrame, renderPauseOverlayFrame, renderOptionsOverlayFrame } from "../src/ui/render.js";
import { hitTest, type HitTarget } from "../src/ui/input/pointer.js";
import { reduceMainKey, reducePointerAction } from "../src/ui/input/reducer.js";
import { createInitialShellState } from "../src/ui/state.js";
import type { ListViewport } from "../src/ui/layout.js";
import { configService } from "../src/domain/config/index.js";

for (const panelPolish of [false, true]) {
  describe(`pointer geometry, panel polish ${panelPolish}`, () => {
    test("uses visible rows and Unicode tab widths across resize and zoom", () => {
      const data = getMockShellData();
      data.leftTree = Array.from({ length: 100 }, (_, index) => ({ id: `task:${index}`, text: `TASK ${index}` }));
      data.tabs = [{ id: "agent", label: "界é", active: true }, { id: "terminal", label: "TERM" }];
      data.rightInspection = { title: "", rows: [
        { id: "inspection-mode", text: "FILES  REVIEW" }, { id: "space", text: "" },
        ...Array.from({ length: 100 }, (_, i) => ({ id: `file-${i}`, text: `FILE ${i}`, selected: i === 60 })),
      ] };
      for (const viewport of [{ width: 120, height: 36 }, { width: 170, height: 45 }]) {
        for (const centerOnly of [false, true]) {
          const targets: HitTarget[] = [];
          const presentation = renderMainShellPresentation(viewport, data, { panelPolish, centerOnly, color: false, hitTargets: targets });
          for (const target of targets) {
            expect(target.row + target.height - 1).toBeLessThan(viewport.height);
            expect(target.column + target.width - 1).toBeLessThanOrEqual(viewport.width);
            if (target.action.kind === "left") {
              expect(centerOnly).toBe(false);
              expect(presentation.frame.split("\n")[target.row - 1]).toContain(`TASK ${target.action.id.slice(5)}`);
            }
            if (target.action.kind === "inspection" && target.action.id.startsWith("file-")) {
              expect(presentation.frame.split("\n")[target.row - 1]).toContain(`FILE ${target.action.id.slice(5)}`);
            }
          }
          expect(targets.some((t) => t.action.kind === "left")).toBe(!centerOnly);
          const tab = targets.find((t) => t.action.kind === "tab" && t.action.id === "terminal")!;
          expect(tab.column).toBe(presentation.center.column + (panelPolish ? 3 : 2) + 3 + 3);
          expect(hitTest(targets, tab.column, tab.row)).toEqual({ kind: "tab", id: "terminal" });
          if (panelPolish) expect(hitTest(targets, presentation.center.column, presentation.center.row + 5)).toEqual({ kind: "focus", region: "center" });
        }
      }
    });

    test("scrolls list viewports without changing selections and maps clicks to painted rows", () => {
      const data = getMockShellData();
      data.leftTree = [{ text: "WORKSPACES", panelHeader: true, focused: true }, ...Array.from({ length: 90 }, (_, i) => ({ id: `task:${i}`, text: `TASK ${i}`, selected: i === 0 }))];
      data.rightInspection = { title: "", rows: [{ id: "inspection-mode", text: "FILES  REVIEW" }, { id: "spacer", text: "" },
        ...Array.from({ length: 90 }, (_, i) => ({ id: `file-${i}`, text: `FILE ${i}`, selected: i === 0 }))] };
      const leftScroll: ListViewport = { offset: 0, maxOffset: 0 };
      const inspectorScroll: ListViewport = { offset: 0, maxOffset: 0 };
      renderMainShellPresentation({ width: 120, height: 36 }, data, { panelPolish, leftScroll, inspectorScroll });
      leftScroll.offset = 40;
      inspectorScroll.offset = 45;
      const targets: HitTarget[] = [];
      const { frame } = renderMainShellPresentation({ width: 120, height: 36 }, data, { panelPolish, leftScroll, inspectorScroll, hitTargets: targets, color: false });
      expect(data.leftTree[1]?.selected).toBe(true);
      expect(leftScroll.offset).toBe(40);
      expect(inspectorScroll.offset).toBe(45);
      for (const target of targets) {
        if (target.action.kind === "left") expect(frame.split("\n")[target.row - 1]).toContain(`TASK ${target.action.id.slice(5)}`);
        if (target.action.kind === "inspection" && target.action.id.startsWith("file-")) expect(frame.split("\n")[target.row - 1]).toContain(`FILE ${target.action.id.slice(5)}`);
      }
      expect(targets.some((t) => t.action.kind === "left" && t.action.id === "task:0")).toBe(false);
      expect(hitTest(targets, -1, 2)).toBeNull();
      expect(hitTest(targets, Number.NaN, 2)).toBeNull();
      if (panelPolish) expect(hitTest(targets, 1, 10)).toBeNull();
    });

    test("menus emit targets from shared content including summaries and nested menus", () => {
      for (const render of [renderBootOverlayFrame, renderPauseOverlayFrame, renderOptionsOverlayFrame]) {
        const targets: HitTarget[] = [];
        const frame = render({ width: 120, height: 36 }, { panelPolish, color: true, hitTargets: targets,
          optionsMenuItems: ["[x] Mouse support", "[ ] Panel polish"], optionsMessage: "Experimental\nfeatures",
          splashSummary: { workspaceCount: 3, taskCount: 5, workingAgents: 2, readyAgents: 1, attentionAgents: 0, activityKnown: true },
        });
        expect(targets.length).toBeGreaterThan(1);
        for (const target of targets) {
          const line = stripVTControlCharacters(frame.split("\n")[target.row - 1]!);
          expect(line.slice(target.column - 1, target.column + target.width - 1).trim()).not.toBe("");
          expect(hitTest(targets, target.column, target.row)).toEqual(target.action);
          expect(hitTest(targets, target.column, target.row + 20)).toBeNull();
        }
      }
    });
  });
}

test("pointer selections reuse keyboard transitions and engagement effects", () => {
  const state = { ...createInitialShellState(null), selectedLeftItemId: "task:a", selectedTaskId: "a", activeTab: "a:agent", selectedPtyTabId: "a:agent" };
  const options = { leftItemIds: ["task:a", "task:b"], centerTabIds: ["a:agent", "a:terminal"], ptyTabIds: ["a:agent", "a:terminal"] };
  expect(reducePointerAction(state, { kind: "left", id: "task:b" }, options)).toEqual(reduceMainKey({ ...state, focusedRegion: "tasks" }, "DOWN", options));
  expect(reducePointerAction(state, { kind: "tab", id: "a:terminal" }, options)).toEqual(reduceMainKey({ ...state, focusedRegion: "center" }, "RIGHT", options));
  const engaged = reducePointerAction(state, { kind: "engage" }, options);
  expect(engaged.attachTerminal).toBe(true);
  expect(engaged.state.inputMode).toBe("terminal");
  const focus = reducePointerAction(engaged.state, { kind: "focus", region: "tasks" }, options);
  expect(focus.state).toMatchObject({ inputMode: "control", focusedRegion: "tasks" });
});

test("mouse support defaults off independently of panel polish", () => {
  expect(configService.previews.isEnabled({ previews: { panelPolish: true } }, "mouseSupport")).toBe(false);
  expect(configService.previews.setEnabled({ previews: { panelPolish: false } }, "mouseSupport", true)).toMatchObject({ previews: { panelPolish: false, mouseSupport: true } });
});
