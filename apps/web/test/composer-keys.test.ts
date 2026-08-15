import { describe, expect, it } from "vitest";
import { isComposerSubmitKey } from "../src/components/composer-keys.js";

describe("composer keyboard behavior", () => {
  it("submits on Enter", () => {
    expect(isComposerSubmitKey({ key: "Enter", shiftKey: false })).toBe(true);
  });

  it("keeps Shift+Enter for newlines and ignores IME confirmation", () => {
    expect(isComposerSubmitKey({ key: "Enter", shiftKey: true })).toBe(false);
    expect(isComposerSubmitKey({ key: "Enter", shiftKey: false, isComposing: true })).toBe(false);
    expect(isComposerSubmitKey({ key: "a", shiftKey: false })).toBe(false);
  });
});
