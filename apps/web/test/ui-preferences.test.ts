// @vitest-environment jsdom

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  DEFAULT_UI_FONT_SCALE,
  UI_PREFERENCES_STORAGE_KEY,
  applyUiPreferences,
  initializeUiPreferences,
  readUiPreferences,
  saveUiPreferences
} from "../src/ui-preferences.js";

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

describe("global interface preferences", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage() });
  });

  afterEach(() => {
    document.documentElement.style.removeProperty("--ui-root-font-size");
    delete document.documentElement.dataset.uiFontScale;
  });

  it("uses a safe default when no valid preference is available", () => {
    expect(readUiPreferences()).toEqual({ fontScalePercent: DEFAULT_UI_FONT_SCALE });

    window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, "not-json");
    expect(readUiPreferences()).toEqual({ fontScalePercent: DEFAULT_UI_FONT_SCALE });
  });

  it("normalizes, applies, and persists the font scale", () => {
    const preferences = saveUiPreferences({ fontScalePercent: 128 });

    expect(preferences).toEqual({ fontScalePercent: 130 });
    expect(document.documentElement.style.getPropertyValue("--ui-root-font-size")).toBe("20.8px");
    expect(document.documentElement.dataset.uiFontScale).toBe("130");
    expect(JSON.parse(window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY) ?? "{}")).toEqual(preferences);

    expect(applyUiPreferences({ fontScalePercent: 500 }).fontScalePercent).toBe(150);
    expect(applyUiPreferences({ fontScalePercent: 0 }).fontScalePercent).toBe(85);
  });

  it("restores the saved preference before the interface renders", () => {
    window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify({ fontScalePercent: 115 }));

    expect(initializeUiPreferences()).toEqual({ fontScalePercent: 115 });
    expect(document.documentElement.style.getPropertyValue("--ui-root-font-size")).toBe("18.4px");
  });

  it("still applies a live preference if storage is blocked", () => {
    const blockedStorage = {
      getItem: () => { throw new Error("blocked"); },
      setItem: () => { throw new Error("blocked"); }
    };

    expect(readUiPreferences(blockedStorage)).toEqual({ fontScalePercent: DEFAULT_UI_FONT_SCALE });
    expect(saveUiPreferences({ fontScalePercent: 125 }, blockedStorage)).toEqual({ fontScalePercent: 125 });
    expect(document.documentElement.style.getPropertyValue("--ui-root-font-size")).toBe("20px");
  });
});
