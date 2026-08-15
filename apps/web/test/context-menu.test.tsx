// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ContextMenu } from "../src/components/context-menu.js";

describe("ContextMenu", () => {
  beforeEach(() => {
    vi.stubGlobal("requestAnimationFrame", (callback: FrameRequestCallback) => {
      callback(0);
      return 1;
    });
    vi.stubGlobal("cancelAnimationFrame", () => undefined);
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("renders in a portal and supports menu keyboard navigation", () => {
    const onClose = vi.fn();
    render(<ContextMenu point={{ x: 40, y: 70 }} label="Node actions" onClose={onClose}>
      <button type="button" role="menuitem">Jump here</button>
      <button type="button" role="menuitem">Fork</button>
    </ContextMenu>);

    const menu = screen.getByRole("menu", { name: "Node actions" });
    const jump = screen.getByRole("menuitem", { name: "Jump here" });
    const fork = screen.getByRole("menuitem", { name: "Fork" });
    expect(document.body.contains(menu)).toBe(true);
    expect(document.activeElement).toBe(jump);

    fireEvent.keyDown(menu, { key: "ArrowDown" });
    expect(document.activeElement).toBe(fork);
    fireEvent.keyDown(menu, { key: "Home" });
    expect(document.activeElement).toBe(jump);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("dismisses on an outside pointer interaction and skips disabled items", () => {
    const onClose = vi.fn();
    render(<><button type="button">Outside</button><ContextMenu point={{ x: 0, y: 0 }} label="Node actions" onClose={onClose}>
      <button type="button" role="menuitem" disabled>Unavailable</button>
      <button type="button" role="menuitem">Fork</button>
    </ContextMenu></>);

    expect(document.activeElement).toBe(screen.getByRole("menuitem", { name: "Fork" }));
    fireEvent.pointerDown(screen.getByRole("button", { name: "Outside" }));
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("stays open while an underlying workbench panel scrolls", () => {
    const onClose = vi.fn();
    const { container } = render(<><div data-testid="transcript" /><ContextMenu point={{ x: 20, y: 20 }} label="Node actions" onClose={onClose}>
      <button type="button" role="menuitem">Jump here</button>
    </ContextMenu></>);

    fireEvent.scroll(container.querySelector('[data-testid="transcript"]')!);
    expect(onClose).not.toHaveBeenCalled();
    expect(screen.getByRole("menu", { name: "Node actions" })).not.toBeNull();
  });
});
