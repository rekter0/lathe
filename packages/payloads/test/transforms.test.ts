import { describe, expect, it } from "vitest";
import {
  applyPayloadTransform,
  countUnicodeCodePoints,
  evaluatePayloadPipeline,
  getPayloadTransform,
  inversePayloadTransformParameters,
  normalizePayloadTransformParameters,
  payloadTransformLimits,
  payloadTransforms,
  renderPayloadVariables,
  validatePayloadTransformParameters
} from "../src/index.js";

describe("payload transforms", () => {
  it("round trips Unicode through base64 and hex", () => {
    const value = "héllo 🧪";
    expect(applyPayloadTransform("base64-decode", applyPayloadTransform("base64-encode", value))).toBe(value);
    expect(applyPayloadTransform("hex-decode", applyPayloadTransform("hex-encode", value))).toBe(value);
  });

  it("rejects malformed UTF-16 instead of silently replacing it during UTF-8 encoding", () => {
    for (const transformId of ["base64-encode", "base32-encode", "hex-encode"] as const) {
      expect(() => applyPayloadTransform(transformId, "\ud800")).toThrow(/unpaired UTF-16 surrogate/i);
    }
  });

  it("implements padded RFC 4648 Base32 and round trips Unicode", () => {
    const vectors = [
      ["", ""],
      ["f", "MY======"],
      ["fo", "MZXQ===="],
      ["foo", "MZXW6==="],
      ["foob", "MZXW6YQ="],
      ["fooba", "MZXW6YTB"],
      ["foobar", "MZXW6YTBOI======"]
    ] as const;
    for (const [plain, encoded] of vectors) {
      expect(applyPayloadTransform("base32-encode", plain)).toBe(encoded);
      expect(applyPayloadTransform("base32-decode", encoded)).toBe(plain);
    }
    expect(applyPayloadTransform("base32-decode", "mzxw6")).toBe("foo");
    const value = "héllo 🧪";
    expect(applyPayloadTransform("base32-decode", applyPayloadTransform("base32-encode", value))).toBe(value);
    expect(() => applyPayloadTransform("base32-decode", "MZ======")).toThrow("non-zero trailing bits");
  });

  it("normalizes configurable parameters and resolves Caesar inverse parameters", () => {
    expect(normalizePayloadTransformParameters("caesar-rotate", { shift: " 5 " })).toEqual({ shift: "5" });
    expect(applyPayloadTransform("caesar-rotate", "Abc Z 🧪", { shift: "5" })).toBe("Fgh E 🧪");
    const inverse = inversePayloadTransformParameters("caesar-rotate", { shift: "5" });
    expect(inverse).toEqual({ shift: "-5" });
    expect(applyPayloadTransform("caesar-rotate", "Fgh E 🧪", inverse ?? undefined)).toBe("Abc Z 🧪");
    expect(normalizePayloadTransformParameters("caesar-rotate")).toEqual({ shift: "13" });
  });

  it("returns reusable validation errors without applying a transform", () => {
    expect(validatePayloadTransformParameters("caesar-rotate", { shift: "26", surprise: "yes" })).toEqual({
      valid: false,
      parameters: {},
      errors: ["Shift must be at most 25.", "Unknown parameter \"surprise\" for Caesar rotation."]
    });
    expect(() => normalizePayloadTransformParameters("zero-width-insert", { interval: "0" })).toThrow("Interval must be at least 1");
    const excessive = Object.fromEntries(Array.from({ length: 257 }, (_, index) => [`variable_${index}`, "x"]));
    expect(validatePayloadTransformParameters("render-variables", excessive).errors).toEqual(["Parameters may contain at most 256 entries."]);
  });

  it("maps ASCII to fullwidth without changing astral Unicode", () => {
    expect(applyPayloadTransform("fullwidth", "A 🧪!")).toBe("Ａ　🧪！");
    expect(applyPayloadTransform("fullwidth", "A 🧪!", { convertSpace: "false" })).toBe("Ａ 🧪！");
    expect(countUnicodeCodePoints(applyPayloadTransform("fullwidth", "A 🧪!"))).toBe(4);
  });

  it("inserts zero-width markers between Unicode code points deterministically", () => {
    const value = applyPayloadTransform("zero-width-insert", "A🧪B");
    expect(value).toBe("A\u200b🧪\u200bB");
    expect(countUnicodeCodePoints(value)).toBe(5);
    expect(applyPayloadTransform("zero-width-insert", "A🧪B", {
      character: "word-joiner",
      interval: "2",
      offset: "0"
    })).toBe("A🧪\u2060B");
  });

  it("publishes complete inspection metadata and marks canonicalizing decoders conditional", () => {
    expect(new Set(payloadTransforms.map((transform) => transform.id)).size).toBe(payloadTransforms.length);
    for (const transform of payloadTransforms) {
      expect(transform.description.length).toBeGreaterThan(0);
      expect(transform.category).toBe(transform.group);
      expect(transform.tags).toContain(transform.group);
      expect(transform.tags).toContain("deterministic");
      expect(transform.deterministic).toBe(true);
      expect(transform.limits).toBe(payloadTransformLimits);
      expect(transform.parameterSchema.fields).toBeDefined();
    }
    expect(getPayloadTransform("base32-decode")).toMatchObject({
      reversible: true,
      lossiness: "conditional",
      inverseTransformId: "base32-encode"
    });
    expect(getPayloadTransform("zero-width-insert").riskFlags).toContain("invisible-unicode");
    const caesar = getPayloadTransform("caesar-rotate");
    expect(Object.isFrozen(payloadTransforms)).toBe(true);
    expect(Object.isFrozen(caesar)).toBe(true);
    expect(Object.isFrozen(caesar.parameterDefaults)).toBe(true);
    expect(Object.isFrozen(caesar.parameterSchema)).toBe(true);
    expect(Object.isFrozen(caesar.parameterSchema.fields)).toBe(true);
  });

  it("rejects transform inputs and outputs beyond deterministic code-point limits", () => {
    expect(() => applyPayloadTransform("reverse", "x".repeat(payloadTransformLimits.maxInputCodePoints + 1))).toThrow("input exceeds");
    expect(() => applyPayloadTransform("repeat-twice", "x".repeat(payloadTransformLimits.maxOutputCodePoints / 2))).toThrow("output exceeds");
  });

  it("renders explicit variables and reports missing names", () => {
    expect(renderPayloadVariables("hit {{ target_name }} for {{objective}}", { target_name: "box" })).toEqual({
      value: "hit box for {{objective}}",
      referenced: ["target_name", "objective"],
      missing: ["objective"]
    });
    expect(renderPayloadVariables("{{constructor}} {{toString}}", {})).toEqual({
      value: "{{constructor}} {{toString}}",
      referenced: ["constructor", "toString"],
      missing: ["constructor", "toString"]
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
