// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COLLAPSED_PANE_WIDTH,
  DEFAULT_LEFT_PANE_WIDTH,
  DEFAULT_RIGHT_PANE_WIDTH,
  MIN_TRANSCRIPT_WIDTH,
  WORKBENCH_LAYOUT_STORAGE_KEY,
  WorkbenchSplit,
  defaultWorkbenchLayout,
  fitWorkbenchPanelWidths,
  readWorkbenchLayout
} from "../src/components/workbench-split.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}

function renderSplit() {
  return render(<WorkbenchSplit
    left={<label>Tree draft<input aria-label="Tree draft" defaultValue="branch note" /></label>}
    center={<div>Transcript</div>}
    right={<label>Inspector draft<input aria-label="Inspector draft" defaultValue="unsaved config" /></label>}
  />);
}

describe("workbench split layout", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage() });
  });
  afterEach(cleanup);

  it("collapses both side panels without unmounting their content and persists the choice", () => {
    const { container } = renderSplit();
    const inspectorDraft = screen.getByLabelText("Inspector draft") as HTMLInputElement;
    fireEvent.change(inspectorDraft, { target: { value: "edited but unsaved" } });

    fireEvent.click(screen.getByRole("button", { name: "Collapse conversation tree panel" }));
    fireEvent.click(screen.getByRole("button", { name: "Collapse inspector panel" }));

    const layout = container.querySelector(".workbench-grid");
    expect(layout?.getAttribute("data-left-collapsed")).toBe("true");
    expect(layout?.getAttribute("data-right-collapsed")).toBe("true");
    expect(screen.getByRole("button", { name: "Expand conversation tree panel" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("button", { name: "Expand inspector panel" }).getAttribute("aria-expanded")).toBe("false");

    fireEvent.click(screen.getByRole("button", { name: "Expand inspector panel" }));
    expect((screen.getByLabelText("Inspector draft") as HTMLInputElement).value).toBe("edited but unsaved");

    const saved = JSON.parse(window.localStorage.getItem(WORKBENCH_LAYOUT_STORAGE_KEY) ?? "{}") as Record<string, unknown>;
    expect(saved.leftCollapsed).toBe(true);
    expect(saved.rightCollapsed).toBe(false);
  });

  it("supports keyboard resizing and restores default width on double click", () => {
    renderSplit();
    const leftHandle = screen.getByRole("separator", { name: "Resize conversation tree panel" });
    const rightHandle = screen.getByRole("separator", { name: "Resize inspector panel" });

    expect(leftHandle.getAttribute("aria-valuenow")).toBe(String(DEFAULT_LEFT_PANE_WIDTH));
    fireEvent.keyDown(leftHandle, { key: "ArrowRight" });
    expect(leftHandle.getAttribute("aria-valuenow")).toBe(String(DEFAULT_LEFT_PANE_WIDTH + 16));
    fireEvent.doubleClick(leftHandle);
    expect(leftHandle.getAttribute("aria-valuenow")).toBe(String(DEFAULT_LEFT_PANE_WIDTH));

    fireEvent.keyDown(rightHandle, { key: "ArrowLeft", shiftKey: true });
    expect(rightHandle.getAttribute("aria-valuenow")).toBe(String(DEFAULT_RIGHT_PANE_WIDTH + 48));
    expect(JSON.parse(window.localStorage.getItem(WORKBENCH_LAYOUT_STORAGE_KEY) ?? "{}").rightWidth).toBe(DEFAULT_RIGHT_PANE_WIDTH + 48);
  });

  it("restores valid saved preferences and safely ignores malformed storage", () => {
    window.localStorage.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, JSON.stringify({ leftWidth: 410, rightWidth: 520, leftCollapsed: true, rightCollapsed: false }));
    const restored = readWorkbenchLayout();
    expect(restored).toEqual({ leftWidth: 410, rightWidth: 520, leftCollapsed: true, rightCollapsed: false });

    window.localStorage.setItem(WORKBENCH_LAYOUT_STORAGE_KEY, "not json");
    expect(readWorkbenchLayout()).toEqual(defaultWorkbenchLayout);
    expect(readWorkbenchLayout({ getItem: () => { throw new Error("storage blocked"); } })).toEqual(defaultWorkbenchLayout);
  });

  it("fits expanded panels while preserving the transcript minimum and compact collapsed rails", () => {
    const containerWidth = 1080;
    const fitted = fitWorkbenchPanelWidths(defaultWorkbenchLayout, containerWidth);
    expect(containerWidth - fitted.leftWidth - fitted.rightWidth - 12).toBeGreaterThanOrEqual(MIN_TRANSCRIPT_WIDTH);

    expect(fitWorkbenchPanelWidths({ ...defaultWorkbenchLayout, leftCollapsed: true, rightCollapsed: true }, containerWidth)).toEqual({
      leftWidth: COLLAPSED_PANE_WIDTH,
      rightWidth: COLLAPSED_PANE_WIDTH
    });
  });
});
