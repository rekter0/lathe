// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { UiSettingsDialog } from "../src/components/ui-settings-dialog.js";
import { UI_PREFERENCES_STORAGE_KEY } from "../src/ui-preferences.js";

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

describe("interface settings dialog", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage() });
  });

  afterEach(() => {
    cleanup();
    document.documentElement.style.removeProperty("--ui-root-font-size");
    delete document.documentElement.dataset.uiFontScale;
  });

  it("opens from its own cog and applies presets immediately", async () => {
    render(<UiSettingsDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Interface settings" }));
    expect(screen.getByRole("dialog", { name: "Interface settings" })).not.toBeNull();

    const slider = screen.getByRole("slider", { name: "Interface text size" }) as HTMLInputElement;
    expect(slider.value).toBe("100");
    fireEvent.click(screen.getByRole("button", { name: /Extra large/ }));

    expect(slider.value).toBe("130");
    expect(document.documentElement.style.getPropertyValue("--ui-root-font-size")).toBe("20.8px");
    expect(JSON.parse(window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY) ?? "{}")).toEqual({ fontScalePercent: 130 });

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Interface settings" })).toBeNull());
  });

  it("restores a saved size and offers an explicit reset", () => {
    window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify({ fontScalePercent: 115 }));
    render(<UiSettingsDialog />);

    fireEvent.click(screen.getByRole("button", { name: "Interface settings" }));
    const slider = screen.getByRole("slider", { name: "Interface text size" }) as HTMLInputElement;
    expect(slider.value).toBe("115");

    fireEvent.click(screen.getByRole("button", { name: "Reset text size" }));
    expect(slider.value).toBe("100");
    expect(document.documentElement.style.getPropertyValue("--ui-root-font-size")).toBe("16px");
  });
});
