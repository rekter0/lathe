import { describe, expect, it } from "vitest";
import { applyPayloadTransform, evaluatePayloadPipeline, renderPayloadVariables } from "../src/index.js";

describe("payload transforms", () => {
  it("round trips Unicode through base64 and hex", () => {
    const value = "héllo 🧪";
    expect(applyPayloadTransform("base64-decode", applyPayloadTransform("base64-encode", value))).toBe(value);
    expect(applyPayloadTransform("hex-decode", applyPayloadTransform("hex-encode", value))).toBe(value);
  });

  it("renders explicit variables and reports missing names", () => {
    expect(renderPayloadVariables("hit {{ target_name }} for {{objective}}", { target_name: "box" })).toEqual({
      value: "hit box for {{objective}}",
      referenced: ["target_name", "objective"],
      missing: ["objective"]
    });
  });

  it("stops a pipeline at the first failed step without losing the last value", () => {
    const result = evaluatePayloadPipeline("abc", [
      { transformId: "uppercase", version: 1, enabled: true },
      { transformId: "hex-decode", version: 1, enabled: true },
      { transformId: "reverse", version: 1, enabled: true }
    ]);
    expect(result.completed).toBe(false);
    expect(result.output).toBe("ABC");
    expect(result.steps).toHaveLength(2);
  });
});
