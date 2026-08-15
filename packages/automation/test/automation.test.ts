import { describe, expect, it } from "vitest";
import { parseJsonPointer, previewBatchVariation, runBoundedPool, setJsonPointer } from "../src/index.js";

describe("batch variation", () => {
  it("updates exactly one field without mutating the template", () => {
    const template = { config: { temperature: 0.2, model: "a" } };
    const changed = setJsonPointer(template, "/config/temperature", 0.8);
    expect(changed).toEqual({ config: { temperature: 0.8, model: "a" } });
    expect(template.config.temperature).toBe(0.2);
  });

  it("previews a deterministic matrix", () => {
    const items = previewBatchVariation({ pointer: "/payload", values: ["a", "b"], template: { payload: "" } });
    expect(items.map((item) => item.input.payload)).toEqual(["a", "b"]);
  });

  it("rejects malformed JSON Pointer escapes", () => {
    expect(() => parseJsonPointer("/config/~2temperature")).toThrow(/escapes/);
  });
});

describe("bounded pool", () => {
  it("runs every item and reports progress", async () => {
    const items = [0, 1, 2].map((index) => ({ id: String(index), index, input: {} }));
    const result = await runBoundedPool(items, 2, async (item) => item.index * 2, { stopOnError: false });
    expect(result.completed.map(({ value }) => value).toSorted()).toEqual([0, 2, 4]);
  });

  it("does not start work when the caller is already cancelled", async () => {
    const controller = new AbortController();
    controller.abort(new Error("stop"));
    let started = 0;
    const result = await runBoundedPool([{ id: "one", index: 0, input: {} }], 1, async () => {
      started += 1;
      return true;
    }, { signal: controller.signal });
    expect(started).toBe(0);
    expect(result.completed).toEqual([]);
  });
});
