import { describe, expect, it } from "vitest";
import { sha256Json } from "@lathe/domain";
import {
  evaluatePayloadVariantMatrix,
  payloadVariantMatrixLimits
} from "../src/index.js";

describe("payload variant matrix", () => {
  it("normalizes explicit factors and reports exact deterministic sizes and hashes", () => {
    const evaluation = evaluatePayloadVariantMatrix({
      source: { kind: "draft", revisionId: null, text: "Abc 🧪" },
      transformId: "caesar-rotate",
      version: 1,
      parameterSets: [{ shift: " 1 " }, { shift: "13" }]
    });

    expect(evaluation.outputs).toEqual(["Bcd 🧪", "Nop 🧪"]);
    expect(evaluation.preflight).toMatchObject({
      creatable: true,
      source: { contentHash: sha256Json("Abc 🧪"), codePoints: 5, utf8Bytes: 8 },
      rows: [
        { ordinal: 1, parameters: { shift: "1" }, codePoints: 5, utf8Bytes: 8, matchesControl: false },
        { ordinal: 2, parameters: { shift: "13" }, codePoints: 5, utf8Bytes: 8, matchesControl: false }
      ],
      totals: { rowCount: 2, codePoints: 15, utf8Bytes: 24 },
      violations: []
    });
    expect(evaluation.preflight.preflightHash).toMatch(/^[a-f0-9]{64}$/);
    expect(evaluation.preflight.rows[0]?.contentHash).toBe(sha256Json("Bcd 🧪"));
  });

  it("binds preflight hashes to the requested source lineage as well as exact text", () => {
    const input = {
      transformId: "caesar-rotate" as const,
      version: 1 as const,
      parameterSets: [{ shift: "1" }]
    };
    const first = evaluatePayloadVariantMatrix({
      ...input,
      source: { kind: "revision", revisionId: "revision-a", text: "same" }
    });
    const second = evaluatePayloadVariantMatrix({
      ...input,
      source: { kind: "revision", revisionId: "revision-b", text: "same" }
    });
    const edited = evaluatePayloadVariantMatrix({
      ...input,
      source: { kind: "draft", revisionId: "revision-a", text: "same" }
    });

    expect(first.preflight.preflightHash).not.toBe(second.preflight.preflightHash);
    expect(first.preflight.preflightHash).not.toBe(edited.preflight.preflightHash);
  });

  it("blocks duplicate effective factors but only warns about identical outputs", () => {
    const duplicateFactors = evaluatePayloadVariantMatrix({
      source: { kind: "draft", revisionId: null, text: "abc" },
      transformId: "caesar-rotate",
      version: 1,
      parameterSets: [{ shift: "1" }, { shift: " 1 " }]
    });
    expect(duplicateFactors.preflight.creatable).toBe(false);
    expect(duplicateFactors.preflight.violations).toContainEqual(expect.objectContaining({
      code: "duplicate-parameters",
      ordinal: 2
    }));

    const identicalOutputs = evaluatePayloadVariantMatrix({
      source: { kind: "draft", revisionId: null, text: "123" },
      transformId: "caesar-rotate",
      version: 1,
      parameterSets: [{ shift: "1" }, { shift: "2" }]
    });
    expect(identicalOutputs.preflight.creatable).toBe(true);
    expect(identicalOutputs.preflight.rows).toMatchObject([
      { ordinal: 1, matchesControl: true, duplicateOutputOrdinals: [2] },
      { ordinal: 2, matchesControl: true, duplicateOutputOrdinals: [1] }
    ]);
  });

  it("returns bounded structured violations without applying oversized or invalid matrices", () => {
    const empty = evaluatePayloadVariantMatrix({
      source: { kind: "draft", revisionId: null, text: "abc" },
      transformId: "uppercase",
      version: 1,
      parameterSets: []
    });
    expect(empty.preflight.violations).toContainEqual(expect.objectContaining({ code: "no-rows" }));
    expect(empty.outputs).toEqual([]);

    const oversized = evaluatePayloadVariantMatrix({
      source: { kind: "draft", revisionId: null, text: "abc" },
      transformId: "caesar-rotate",
      version: 1,
      parameterSets: Array.from({ length: payloadVariantMatrixLimits.maxRows + 1 }, (_, index) => ({ shift: String(index) }))
    });
    expect(oversized.outputs).toEqual([]);
    expect(oversized.preflight).toMatchObject({
      creatable: false,
      rows: [],
      violations: [expect.objectContaining({ code: "too-many-rows" })]
    });

    const invalid = evaluatePayloadVariantMatrix({
      source: { kind: "draft", revisionId: null, text: "abc" },
      transformId: "caesar-rotate",
      version: 1,
      parameterSets: [{ shift: "99" }]
    });
    expect(invalid.preflight).toMatchObject({
      creatable: false,
      rows: [{ ordinal: 1, parameters: null, contentHash: null }],
      violations: [expect.objectContaining({ code: "invalid-parameters", ordinal: 1 })]
    });

    const unsupportedVersion = evaluatePayloadVariantMatrix({
      source: { kind: "draft", revisionId: null, text: "abc" },
      transformId: "uppercase",
      version: 2 as 1,
      parameterSets: [{}]
    });
    expect(unsupportedVersion.outputs).toEqual([]);
    expect(unsupportedVersion.preflight.violations).toContainEqual(expect.objectContaining({ code: "unsupported-version" }));
  });

  it("classifies invalid UTF-16 source text instead of throwing", () => {
    const evaluation = evaluatePayloadVariantMatrix({
      source: { kind: "draft", revisionId: null, text: "\ud800" },
      transformId: "uppercase",
      version: 1,
      parameterSets: [{}]
    });
    expect(evaluation.preflight).toMatchObject({
      creatable: false,
      source: { utf8Bytes: null },
      violations: [expect.objectContaining({ code: "invalid-source" })]
    });
  });

  it("checks the aggregate normalized parameter budget before transforming", () => {
    const parameterSets = Array.from({ length: 11 }, (_, index) => ({
      value: "x",
      [`padding_${index}`]: "p".repeat(19_000)
    }));
    const evaluation = evaluatePayloadVariantMatrix({
      source: { kind: "draft", revisionId: null, text: "{{value}}" },
      transformId: "render-variables",
      version: 1,
      parameterSets
    });
    expect(evaluation.outputs.every((output) => output === null)).toBe(true);
    expect(evaluation.preflight.violations).toContainEqual(expect.objectContaining({ code: "total-parameters-exceeded" }));
  });
});
