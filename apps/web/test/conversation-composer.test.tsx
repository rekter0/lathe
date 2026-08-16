// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  COMPOSER_HEIGHT_STORAGE_KEY,
  ComposerPanel,
  ComposerTextarea,
  DEFAULT_COMPOSER_HEIGHT,
  MAX_COMPOSER_HEIGHT,
  MIN_COMPOSER_HEIGHT,
  fitComposerHeight,
  readComposerHeight,
  type ComposerHistoryEntry,
} from "../src/components/conversation-composer.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value),
  };
}

const history: ComposerHistoryEntry[] = [
  { text: "oldest payload", sourcePayloadRevisionId: "revision-oldest" },
  { text: "newest\npayload", sourcePayloadRevisionId: "revision-newest" },
];

function HistoryHarness({ navigationKey = "session:branch:head" }: { navigationKey?: string }) {
  const [draft, setDraft] = useState({ text: "unsent draft", sourcePayloadRevisionId: "revision-draft" as string | null });
  return <>
    <ComposerTextarea
      aria-label="Next operator payload"
      value={draft.text}
      sourcePayloadRevisionId={draft.sourcePayloadRevisionId}
      history={history}
      navigationKey={navigationKey}
      onValueChange={(text, _origin, sourcePayloadRevisionId) => setDraft({ text, sourcePayloadRevisionId })}
    />
    <output data-testid="source-revision">{draft.sourcePayloadRevisionId ?? "none"}</output>
  </>;
}

describe("conversation composer", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage() });
    Object.defineProperty(window, "PointerEvent", { configurable: true, value: MouseEvent });
  });
  afterEach(cleanup);

  it("restores and bounds the saved composer height", () => {
    expect(readComposerHeight()).toBe(DEFAULT_COMPOSER_HEIGHT);
    window.localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, "9999");
    expect(readComposerHeight()).toBe(MAX_COMPOSER_HEIGHT);
    window.localStorage.setItem(COMPOSER_HEIGHT_STORAGE_KEY, "broken");
    expect(readComposerHeight()).toBe(DEFAULT_COMPOSER_HEIGHT);
    expect(readComposerHeight({ getItem: () => { throw new Error("storage unavailable"); } })).toBe(DEFAULT_COMPOSER_HEIGHT);
    expect(fitComposerHeight(500, 600)).toEqual({ height: 420, maximum: 420 });
    expect(fitComposerHeight(500, 200)).toEqual({ height: MIN_COMPOSER_HEIGHT, maximum: MIN_COMPOSER_HEIGHT });
  });

  it("supports accessible keyboard resizing and double-click reset", () => {
    render(<div><ComposerPanel><textarea id="operator-composer-input" /></ComposerPanel></div>);
    const separator = screen.getByRole("separator", { name: "Resize message composer" });
    expect(separator.getAttribute("aria-orientation")).toBe("horizontal");
    expect(separator.getAttribute("aria-valuenow")).toBe(String(DEFAULT_COMPOSER_HEIGHT));

    fireEvent.keyDown(separator, { key: "ArrowUp" });
    expect(separator.getAttribute("aria-valuenow")).toBe(String(DEFAULT_COMPOSER_HEIGHT + 16));
    fireEvent.keyDown(separator, { key: "ArrowDown", shiftKey: true });
    expect(separator.getAttribute("aria-valuenow")).toBe(String(DEFAULT_COMPOSER_HEIGHT + 16 - 48));
    fireEvent.keyDown(separator, { key: "End" });
    expect(separator.getAttribute("aria-valuenow")).toBe(String(MAX_COMPOSER_HEIGHT));
    fireEvent.doubleClick(separator);
    expect(separator.getAttribute("aria-valuenow")).toBe(String(DEFAULT_COMPOSER_HEIGHT));
    expect(window.localStorage.getItem(COMPOSER_HEIGHT_STORAGE_KEY)).toBe(String(DEFAULT_COMPOSER_HEIGHT));
  });

  it("grows when its separator is dragged upward", () => {
    render(<div><ComposerPanel><textarea id="operator-composer-input" /></ComposerPanel></div>);
    const separator = screen.getByRole("separator", { name: "Resize message composer" });
    fireEvent.pointerDown(separator, { pointerId: 7, clientY: 300 });
    fireEvent.pointerMove(separator, { pointerId: 7, clientY: 250 });
    expect(separator.getAttribute("aria-valuenow")).toBe(String(DEFAULT_COMPOSER_HEIGHT + 50));
    fireEvent.pointerUp(separator, { pointerId: 7, clientY: 250 });
  });

  it("recalls older messages and walks forward to the original unsent draft", () => {
    render(<HistoryHarness />);
    const textarea = screen.getByRole("textbox", { name: "Next operator payload" }) as HTMLTextAreaElement;
    textarea.setSelectionRange(0, 0);

    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("newest\npayload");
    expect(screen.getByTestId("source-revision").textContent).toBe("revision-newest");

    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("oldest payload");
    expect(screen.getByTestId("source-revision").textContent).toBe("revision-oldest");

    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.value).toBe("newest\npayload");
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.value).toBe("unsent draft");
    expect(screen.getByTestId("source-revision").textContent).toBe("revision-draft");
  });

  it("does not hijack arrows away from the entry boundary and preserves provenance when editing a recall", () => {
    render(<HistoryHarness />);
    const textarea = screen.getByRole("textbox", { name: "Next operator payload" }) as HTMLTextAreaElement;
    textarea.setSelectionRange(3, 3);
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("unsent draft");

    textarea.setSelectionRange(0, 0);
    fireEvent.keyDown(textarea, { key: "ArrowUp", ctrlKey: true });
    expect(textarea.value).toBe("unsent draft");
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("newest\npayload");

    fireEvent.change(textarea, { target: { value: "edited recalled payload" } });
    expect(textarea.value).toBe("edited recalled payload");
    expect(screen.getByTestId("source-revision").textContent).toBe("revision-newest");
  });

  it("drops an active history cursor when the branch path changes", () => {
    const view = render(<HistoryHarness navigationKey="session:branch:head-a" />);
    const textarea = screen.getByRole("textbox", { name: "Next operator payload" }) as HTMLTextAreaElement;
    textarea.setSelectionRange(0, 0);
    fireEvent.keyDown(textarea, { key: "ArrowUp" });
    expect(textarea.value).toBe("newest\npayload");

    view.rerender(<HistoryHarness navigationKey="session:branch:head-b" />);
    fireEvent.keyDown(textarea, { key: "ArrowDown" });
    expect(textarea.value).toBe("newest\npayload");
  });
});
