// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { applyPayloadTransform, PayloadWorkbench } from "../src/components/payload-workbench.js";

describe("payload transformations", () => {
  it("round-trips Unicode through Base64, URL, and UTF-8 hex encodings", () => {
    const payload = "Ignore prior text — مرحبا 🧪";

    const base64 = applyPayloadTransform("base64-encode", payload);
    expect(applyPayloadTransform("base64-decode", base64)).toBe(payload);

    const urlEncoded = applyPayloadTransform("url-encode", payload);
    expect(applyPayloadTransform("url-decode", urlEncoded)).toBe(payload);

    const hex = applyPayloadTransform("hex-encode", payload);
    expect(applyPayloadTransform("hex-decode", hex)).toBe(payload);
  });

  it("applies reversible text transforms and useful payload frames", () => {
    expect(applyPayloadTransform("rot13", applyPayloadTransform("rot13", "Attack at dawn"))).toBe("Attack at dawn");
    expect(applyPayloadTransform("markdown-frame", "payload")).toBe("```text\npayload\n```");
    expect(applyPayloadTransform("xml-frame", "payload")).toBe("<payload>\npayload\n</payload>");
    expect(JSON.parse(applyPayloadTransform("json-frame", "payload"))).toEqual({ payload: "payload" });
    expect(() => applyPayloadTransform("hex-decode", "not hex")).toThrow(/hexadecimal digits/i);
  });
});

describe("PayloadWorkbench", () => {
  afterEach(cleanup);

  it("keeps edits local, supports undo, and explicitly returns the next prompt", async () => {
    const onUse = vi.fn();
    render(<PayloadWorkbench value="hello / world" onUse={onUse} />);

    fireEvent.click(screen.getByRole("button", { name: "Open payload workbench" }));
    const dialog = screen.getByRole("dialog", { name: "Payload workbench" });
    const editor = screen.getByRole("textbox", { name: "Next prompt" }) as HTMLTextAreaElement;
    expect(editor.value).toBe("hello / world");
    expect(onUse).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Base64 encode" }));
    expect(editor.value).toBe("aGVsbG8gLyB3b3JsZA==");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(editor.value).toBe("hello / world");

    fireEvent.change(editor, { target: { value: "probe" } });
    fireEvent.click(screen.getByRole("button", { name: "XML payload" }));
    expect(editor.value).toBe("<payload>\nprobe\n</payload>");
    fireEvent.click(screen.getByRole("button", { name: "Use as next prompt" }));

    expect(onUse).toHaveBeenCalledWith("<payload>\nprobe\n</payload>");
    await waitFor(() => expect(dialog.isConnected).toBe(false));
  });

  it("shows decoding failures without replacing the current draft", () => {
    render(<PayloadWorkbench value="not hex" onUse={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Open payload workbench" }));
    const editor = screen.getByRole("textbox", { name: "Next prompt" }) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: "UTF-8 hex decode" }));

    expect(editor.value).toBe("not hex");
    expect(screen.getByRole("alert").textContent).toMatch(/hexadecimal digits/i);
  });
});
