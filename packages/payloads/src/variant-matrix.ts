import { sha256Json, type JsonObject } from "@lathe/domain";
import {
  applyPayloadTransform,
  countUnicodeCodePoints,
  normalizePayloadTransformParameters,
  getPayloadTransform,
  type PayloadTransformId
} from "./transforms.js";

export const payloadVariantMatrixLimits = Object.freeze({
  maxRows: 32,
  maxTotalCodePoints: 4_000_000,
  maxTotalUtf8Bytes: 16 * 1024 * 1024,
  maxTotalParameterCodePoints: 200_000
});

export type PayloadVariantMatrixViolationCode =
  | "no-rows"
  | "too-many-rows"
  | "invalid-source"
  | "unsupported-version"
  | "duplicate-parameters"
  | "total-parameters-exceeded"
  | "invalid-parameters"
  | "transform-failed"
  | "total-code-points-exceeded"
  | "total-utf8-bytes-exceeded";

export interface PayloadVariantMatrixViolation {
  code: PayloadVariantMatrixViolationCode;
  message: string;
  ordinal: number | null;
}

export interface PayloadVariantMatrixRowPreview {
  ordinal: number;
  parameters: Readonly<Record<string, string>> | null;
  contentHash: string | null;
  codePoints: number | null;
  utf8Bytes: number | null;
  codePointDelta: number | null;
  utf8ByteDelta: number | null;
  duplicateOutputOrdinals: readonly number[];
  matchesControl: boolean | null;
}

export interface PayloadVariantMatrixPreflight {
  source: {
    kind: "revision" | "draft";
    revisionId: string | null;
    contentHash: string;
    codePoints: number;
    utf8Bytes: number | null;
  };
  transform: { id: PayloadTransformId; version: 1 };
  rows: readonly PayloadVariantMatrixRowPreview[];
  totals: { rowCount: number; codePoints: number; utf8Bytes: number };
  limits: typeof payloadVariantMatrixLimits;
  preflightHash: string | null;
  violations: readonly PayloadVariantMatrixViolation[];
  creatable: boolean;
}

export interface PayloadVariantMatrixEvaluation {
  preflight: PayloadVariantMatrixPreflight;
  outputs: readonly (string | null)[];
}

export interface EvaluatePayloadVariantMatrixInput {
  source: { kind: "revision" | "draft"; revisionId: string | null; text: string };
  transformId: PayloadTransformId;
  version: 1;
  parameterSets: readonly Readonly<Record<string, string>>[];
}

function utf8Bytes(value: string, subject: string): number {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) {
        throw new Error(`${subject} contains an unpaired UTF-16 surrogate.`);
      }
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) {
      throw new Error(`${subject} contains an unpaired UTF-16 surrogate.`);
    }
  }
  return new TextEncoder().encode(value).byteLength;
}

function unavailableRow(
  ordinal: number,
  parameters: Readonly<Record<string, string>> | null = null
): PayloadVariantMatrixRowPreview {
  return {
    ordinal,
    parameters,
    contentHash: null,
    codePoints: null,
    utf8Bytes: null,
    codePointDelta: null,
    utf8ByteDelta: null,
    duplicateOutputOrdinals: [],
    matchesControl: null
  };
}

/**
 * Evaluates an explicit one-factor matrix without side effects. The returned
 * output strings are intentionally separate from the API-safe preview so a
 * caller can persist the exact values only after a successful preflight.
 */
export function evaluatePayloadVariantMatrix(input: EvaluatePayloadVariantMatrixInput): PayloadVariantMatrixEvaluation {
  const sourceCodePoints = countUnicodeCodePoints(input.source.text);
  const sourceContentHash = sha256Json(input.source.text);
  const rows: PayloadVariantMatrixRowPreview[] = [];
  const outputs: Array<string | null> = [];
  const violations: PayloadVariantMatrixViolation[] = [];
  const parameterOrdinals = new Map<string, number>();
  let sourceUtf8Bytes: number;
  try {
    sourceUtf8Bytes = utf8Bytes(input.source.text, "Payload variant matrix source");
  } catch (error) {
    return {
      preflight: {
        source: {
          kind: input.source.kind,
          revisionId: input.source.revisionId,
          contentHash: sourceContentHash,
          codePoints: sourceCodePoints,
          utf8Bytes: null
        },
        transform: { id: input.transformId, version: input.version },
        rows,
        totals: { rowCount: input.parameterSets.length, codePoints: sourceCodePoints, utf8Bytes: 0 },
        limits: payloadVariantMatrixLimits,
        preflightHash: null,
        violations: [{
          code: "invalid-source",
          message: error instanceof Error ? error.message : String(error),
          ordinal: null
        }],
        creatable: false
      },
      outputs
    };
  }
  let totalCodePoints = sourceCodePoints;
  let totalUtf8Bytes = sourceUtf8Bytes;
  let totalParameterCodePoints = 0;

  if (input.parameterSets.length === 0) {
    violations.push({ code: "no-rows", message: "A variant matrix requires at least one row.", ordinal: null });
  }

  if (input.parameterSets.length > payloadVariantMatrixLimits.maxRows) {
    violations.push({
      code: "too-many-rows",
      message: `A variant matrix may contain at most ${payloadVariantMatrixLimits.maxRows} rows.`,
      ordinal: null
    });
  }

  const definition = getPayloadTransform(input.transformId);
  if (definition.version !== input.version) {
    violations.push({
      code: "unsupported-version",
      message: `Unsupported ${input.transformId} version ${input.version}.`,
      ordinal: null
    });
  }

  if (violations.some((violation) => violation.code === "no-rows" || violation.code === "too-many-rows" || violation.code === "unsupported-version")) {
    return {
      preflight: {
        source: {
          kind: input.source.kind,
          revisionId: input.source.revisionId,
          contentHash: sourceContentHash,
          codePoints: sourceCodePoints,
          utf8Bytes: sourceUtf8Bytes
        },
        transform: { id: input.transformId, version: input.version },
        rows,
        totals: { rowCount: input.parameterSets.length, codePoints: totalCodePoints, utf8Bytes: totalUtf8Bytes },
        limits: payloadVariantMatrixLimits,
        preflightHash: null,
        violations,
        creatable: false
      },
      outputs
    };
  }

  const normalizedRows: Array<Readonly<Record<string, string>> | null> = [];
  for (const [index, requestedParameters] of input.parameterSets.entries()) {
    const ordinal = index + 1;
    let parameters: Readonly<Record<string, string>>;
    try {
      parameters = normalizePayloadTransformParameters(input.transformId, requestedParameters);
    } catch (error) {
      normalizedRows.push(null);
      violations.push({
        code: "invalid-parameters",
        message: error instanceof Error ? error.message : String(error),
        ordinal
      });
      continue;
    }
    normalizedRows.push(parameters);

    const parameterHash = sha256Json(parameters as JsonObject);
    const priorOrdinal = parameterOrdinals.get(parameterHash);
    if (priorOrdinal !== undefined) {
      violations.push({
        code: "duplicate-parameters",
        message: `Row ${ordinal} has the same effective parameters as row ${priorOrdinal}.`,
        ordinal
      });
    } else {
      parameterOrdinals.set(parameterHash, ordinal);
    }
    totalParameterCodePoints += Object.entries(parameters)
      .reduce((total, [name, value]) => total + countUnicodeCodePoints(name) + countUnicodeCodePoints(value), 0);

  }

  if (totalParameterCodePoints > payloadVariantMatrixLimits.maxTotalParameterCodePoints) {
    violations.push({
      code: "total-parameters-exceeded",
      message: `Variant parameters contain ${totalParameterCodePoints} Unicode code points; the matrix limit is ${payloadVariantMatrixLimits.maxTotalParameterCodePoints}.`,
      ordinal: null
    });
    return {
      preflight: {
        source: {
          kind: input.source.kind,
          revisionId: input.source.revisionId,
          contentHash: sourceContentHash,
          codePoints: sourceCodePoints,
          utf8Bytes: sourceUtf8Bytes
        },
        transform: { id: input.transformId, version: input.version },
        rows: normalizedRows.map((parameters, index) => unavailableRow(index + 1, parameters)),
        totals: { rowCount: input.parameterSets.length, codePoints: totalCodePoints, utf8Bytes: totalUtf8Bytes },
        limits: payloadVariantMatrixLimits,
        preflightHash: null,
        violations,
        creatable: false
      },
      outputs: normalizedRows.map(() => null)
    };
  }

  for (const [index, parameters] of normalizedRows.entries()) {
    const ordinal = index + 1;
    if (parameters === null) {
      rows.push(unavailableRow(ordinal));
      outputs.push(null);
      continue;
    }
    try {
      const output = applyPayloadTransform(input.transformId, input.source.text, parameters);
      const codePoints = countUnicodeCodePoints(output);
      const byteCount = utf8Bytes(output, `Payload variant matrix row ${ordinal}`);
      rows.push({
        ordinal,
        parameters,
        contentHash: sha256Json(output),
        codePoints,
        utf8Bytes: byteCount,
        codePointDelta: codePoints - sourceCodePoints,
        utf8ByteDelta: byteCount - sourceUtf8Bytes,
        duplicateOutputOrdinals: [],
        matchesControl: sha256Json(output) === sourceContentHash
      });
      outputs.push(output);
      totalCodePoints += codePoints;
      totalUtf8Bytes += byteCount;
    } catch (error) {
      rows.push(unavailableRow(ordinal, parameters));
      outputs.push(null);
      violations.push({
        code: "transform-failed",
        message: error instanceof Error ? error.message : String(error),
        ordinal
      });
    }
  }

  if (totalCodePoints > payloadVariantMatrixLimits.maxTotalCodePoints) {
    violations.push({
      code: "total-code-points-exceeded",
      message: `The control and variant outputs contain ${totalCodePoints} Unicode code points; the matrix limit is ${payloadVariantMatrixLimits.maxTotalCodePoints}.`,
      ordinal: null
    });
  }
  if (totalUtf8Bytes > payloadVariantMatrixLimits.maxTotalUtf8Bytes) {
    violations.push({
      code: "total-utf8-bytes-exceeded",
      message: `The control and variant outputs contain ${totalUtf8Bytes} UTF-8 bytes; the matrix limit is ${payloadVariantMatrixLimits.maxTotalUtf8Bytes}.`,
      ordinal: null
    });
  }

  const outputOrdinals = new Map<string, number[]>();
  for (const row of rows) {
    if (row.contentHash === null) continue;
    const ordinals = outputOrdinals.get(row.contentHash) ?? [];
    ordinals.push(row.ordinal);
    outputOrdinals.set(row.contentHash, ordinals);
  }
  const rowsWithCollisions = rows.map((row) => ({
    ...row,
    duplicateOutputOrdinals: row.contentHash === null
      ? []
      : (outputOrdinals.get(row.contentHash) ?? []).filter((ordinal) => ordinal !== row.ordinal)
  }));
  const normalizedParameterSets = rowsWithCollisions.flatMap((row) => row.parameters === null ? [] : [row.parameters]);
  const preflightHash = violations.length === 0
    ? sha256Json({
      schema: "lathe.payload-variant-matrix-preflight.v1",
      limits: payloadVariantMatrixLimits,
      source: {
        kind: input.source.kind,
        revisionId: input.source.revisionId,
        contentHash: sourceContentHash
      },
      transformId: input.transformId,
      version: input.version,
      parameterSets: normalizedParameterSets
    })
    : null;

  return {
    preflight: {
      source: {
        kind: input.source.kind,
        revisionId: input.source.revisionId,
        contentHash: sourceContentHash,
        codePoints: sourceCodePoints,
        utf8Bytes: sourceUtf8Bytes
      },
      transform: { id: input.transformId, version: input.version },
      rows: rowsWithCollisions,
      totals: { rowCount: input.parameterSets.length, codePoints: totalCodePoints, utf8Bytes: totalUtf8Bytes },
      limits: payloadVariantMatrixLimits,
      preflightHash,
      violations,
      creatable: violations.length === 0
    },
    outputs
  };
}
