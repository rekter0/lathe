export type PayloadTransformId =
  | "base64-encode"
  | "base64-decode"
  | "base32-encode"
  | "base32-decode"
  | "url-encode"
  | "url-decode"
  | "hex-encode"
  | "hex-decode"
  | "uppercase"
  | "lowercase"
  | "reverse"
  | "rot13"
  | "caesar-rotate"
  | "fullwidth"
  | "zero-width-insert"
  | "json-escape"
  | "json-unescape"
  | "markdown-frame"
  | "xml-frame"
  | "json-frame"
  | "repeat-twice"
  | "render-variables";

export type PayloadTransformGroup = "encoding" | "text" | "framing" | "variables";
export type PayloadTransformValueKind = "text" | "encoded-text" | "template";
export type PayloadTransformLossiness = "lossless" | "conditional" | "lossy";
export type PayloadTransformParameterType = "string" | "integer" | "boolean" | "enum";
export type PayloadTransformCompatibilityFlag =
  | "unicode-code-point-safe"
  | "utf8-aware"
  | "ascii-input"
  | "ascii-output"
  | "normalization-sensitive"
  | "provider-rendering-dependent";
export type PayloadTransformRiskFlag =
  | "strict-decoder"
  | "output-expansion"
  | "lossy"
  | "grapheme-sensitive"
  | "unicode-confusable"
  | "invisible-unicode";

export interface PayloadTransformParameterOption {
  readonly value: string;
  readonly label: string;
}

export interface PayloadTransformParameterDefinition {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly type: PayloadTransformParameterType;
  readonly required: boolean;
  readonly defaultValue?: string;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly options?: readonly PayloadTransformParameterOption[];
}

export interface PayloadTransformParameterSchema {
  readonly mode: "none" | "defined" | "variables";
  readonly fields: readonly PayloadTransformParameterDefinition[];
  readonly allowAdditional: boolean;
}

export interface PayloadTransformExpansionEstimate {
  readonly kind: "unchanged" | "bounded" | "input-dependent";
  readonly maxFactor: number | null;
  readonly fixedCodePoints: number;
  readonly summary: string;
}

export interface PayloadTransformWarning {
  readonly code: string;
  readonly severity: "info" | "warning";
  readonly message: string;
}

export interface PayloadTransformSizeLimits {
  readonly maxInputCodePoints: number;
  readonly maxOutputCodePoints: number;
}

export interface PayloadTransformParameterLimits {
  readonly maxEntries: number;
  readonly maxNameCodePoints: number;
  readonly maxValueCodePoints: number;
  readonly maxTotalCodePoints: number;
}

export interface PayloadTransformDefinition {
  readonly id: PayloadTransformId;
  readonly version: 1;
  readonly label: string;
  readonly description: string;
  readonly group: PayloadTransformGroup;
  /** Registry-v2 alias retained alongside the existing `group` field. */
  readonly category: PayloadTransformGroup;
  readonly tags: readonly string[];
  readonly parameterSchema: PayloadTransformParameterSchema;
  readonly parameterDefaults: Readonly<Record<string, string>>;
  readonly inputKind: PayloadTransformValueKind;
  readonly outputKind: PayloadTransformValueKind;
  readonly deterministic: true;
  /** True when an inverse operation is exposed for verification; callers must compare exact output. */
  readonly reversible: boolean;
  readonly lossiness: PayloadTransformLossiness;
  readonly expansion: PayloadTransformExpansionEstimate;
  readonly compatibility: readonly PayloadTransformCompatibilityFlag[];
  readonly riskFlags: readonly PayloadTransformRiskFlag[];
  readonly warnings: readonly PayloadTransformWarning[];
  readonly limits: PayloadTransformSizeLimits;
  readonly inverseTransformId?: PayloadTransformId;
  apply(value: string, parameters?: Readonly<Record<string, string>>): string;
}

export interface PayloadTransformParameterValidationResult {
  readonly valid: boolean;
  readonly parameters: Readonly<Record<string, string>>;
  readonly errors: readonly string[];
}

export interface PayloadPipelineStep {
  readonly transformId: PayloadTransformId;
  readonly version: 1;
  readonly enabled: boolean;
  readonly parameters?: Readonly<Record<string, string>>;
}

export interface PayloadPipelineStepResult {
  readonly index: number;
  readonly transformId: PayloadTransformId;
  readonly input: string;
  readonly output: string | null;
  readonly error: string | null;
}

export interface PayloadPipelineResult {
  readonly output: string;
  readonly steps: readonly PayloadPipelineStepResult[];
  readonly completed: boolean;
}

export interface RenderVariablesResult {
  readonly value: string;
  readonly referenced: readonly string[];
  readonly missing: readonly string[];
}

function deepFreeze<T>(value: T): T {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const nested of Object.values(value as Record<string, unknown>)) deepFreeze(nested);
  return Object.freeze(value) as T;
}

export const payloadTransformLimits: PayloadTransformSizeLimits = deepFreeze({
  maxInputCodePoints: 1_000_000,
  maxOutputCodePoints: 1_000_000
});

export const payloadTransformParameterLimits: PayloadTransformParameterLimits = deepFreeze({
  maxEntries: 256,
  maxNameCodePoints: 120,
  maxValueCodePoints: 20_000,
  maxTotalCodePoints: 200_000
});

const emptyParameters: Readonly<Record<string, string>> = deepFreeze({});
const noParameters: PayloadTransformParameterSchema = deepFreeze({ mode: "none", fields: [], allowAdditional: false });
const variableParameters: PayloadTransformParameterSchema = deepFreeze({ mode: "variables", fields: [], allowAdditional: true });
const unchangedExpansion: PayloadTransformExpansionEstimate = deepFreeze({
  kind: "unchanged",
  maxFactor: 1,
  fixedCodePoints: 0,
  summary: "Preserves the Unicode code-point count."
});

export function countUnicodeCodePoints(value: string): number {
  let count = 0;
  for (const _character of value) count += 1;
  return count;
}

function hasUnpairedSurrogate(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const current = value.charCodeAt(index);
    if (current >= 0xd800 && current <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (!(next >= 0xdc00 && next <= 0xdfff)) return true;
      index += 1;
    } else if (current >= 0xdc00 && current <= 0xdfff) return true;
  }
  return false;
}

function encodeUtf8(value: string, subject: string): Uint8Array {
  if (hasUnpairedSurrogate(value)) {
    throw new Error(`${subject} contains an unpaired UTF-16 surrogate and cannot be encoded as UTF-8 without data loss.`);
  }
  return new TextEncoder().encode(value);
}

function setOwnString(target: Record<string, string>, name: string, value: string): void {
  Object.defineProperty(target, name, { value, enumerable: true, configurable: true, writable: true });
}

function assertCodePointLimit(value: string, maximum: number, subject: string): number {
  let count = 0;
  for (const _character of value) {
    count += 1;
    if (count > maximum) throw new Error(`${subject} exceeds the ${maximum} Unicode code-point limit.`);
  }
  return count;
}

function appendBounded(chunks: string[], value: string, current: number, maximum: number, subject: string): number {
  const next = current + assertCodePointLimit(value, maximum - current, subject);
  chunks.push(value);
  return next;
}

const variablePattern = /\{\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}\}/g;

function renderPayloadVariablesWithLimit(
  value: string,
  variables: Readonly<Record<string, string>>,
  maximumOutputCodePoints: number
): RenderVariablesResult {
  const referenced: string[] = [];
  const missing: string[] = [];
  const chunks: string[] = [];
  let codePoints = 0;
  let priorEnd = 0;
  for (const match of value.matchAll(variablePattern)) {
    const index = match.index;
    const matched = match[0];
    const name = match[1];
    if (index === undefined || matched === undefined || name === undefined) continue;
    codePoints = appendBounded(chunks, value.slice(priorEnd, index), codePoints, maximumOutputCodePoints, "Rendered payload");
    if (!referenced.includes(name)) referenced.push(name);
    if (!Object.hasOwn(variables, name)) {
      if (!missing.includes(name)) missing.push(name);
      codePoints = appendBounded(chunks, matched, codePoints, maximumOutputCodePoints, "Rendered payload");
    } else {
      const replacement = variables[name];
      if (typeof replacement !== "string") throw new Error(`Payload variable ${name} must be a string.`);
      codePoints = appendBounded(chunks, replacement, codePoints, maximumOutputCodePoints, "Rendered payload");
    }
    priorEnd = index + matched.length;
  }
  appendBounded(chunks, value.slice(priorEnd), codePoints, maximumOutputCodePoints, "Rendered payload");
  return { value: chunks.join(""), referenced, missing };
}

export function renderPayloadVariables(value: string, variables: Readonly<Record<string, string>>): RenderVariablesResult {
  return renderPayloadVariablesWithLimit(value, variables, Number.POSITIVE_INFINITY);
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  const normalized = value.replace(/\s+/g, "");
  if (!normalized) return new Uint8Array();
  const binary = atob(normalized);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

const base32Alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

function encodeBase32(value: string, maximumOutputCodePoints: number): string {
  const bytes = encodeUtf8(value, "Base32 encode input");
  const unpaddedLength = Math.ceil((bytes.length * 8) / 5);
  const outputLength = Math.ceil(unpaddedLength / 8) * 8;
  if (outputLength > maximumOutputCodePoints) {
    throw new Error(`Base32 encode output exceeds the ${maximumOutputCodePoints} Unicode code-point limit.`);
  }
  let buffer = 0;
  let bits = 0;
  let output = "";
  for (const byte of bytes) {
    buffer = (buffer << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      output += base32Alphabet[(buffer >>> bits) & 31];
    }
  }
  if (bits > 0) output += base32Alphabet[(buffer << (5 - bits)) & 31];
  return output.padEnd(outputLength, "=");
}

function decodeBase32(value: string): string {
  const normalized = value.replace(/\s+/g, "").toUpperCase();
  if (!normalized) return "";
  if (!/^[A-Z2-7]*={0,6}$/.test(normalized)) {
    throw new Error("Base32 input may contain only RFC 4648 characters, optional trailing padding, and whitespace.");
  }
  const paddingStart = normalized.indexOf("=");
  const unpadded = paddingStart < 0 ? normalized : normalized.slice(0, paddingStart);
  const paddingLength = paddingStart < 0 ? 0 : normalized.length - paddingStart;
  const remainder = unpadded.length % 8;
  const expectedPadding = remainder === 0 ? 0 : remainder === 2 ? 6 : remainder === 4 ? 4 : remainder === 5 ? 3 : remainder === 7 ? 1 : -1;
  if (expectedPadding < 0 || (paddingLength > 0 && (normalized.length % 8 !== 0 || paddingLength !== expectedPadding))) {
    throw new Error("Base32 input has invalid length or padding.");
  }
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const character of unpadded) {
    buffer = (buffer << 5) | base32Alphabet.indexOf(character);
    bits += 5;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >>> bits) & 0xff);
    }
  }
  if (bits > 0 && (buffer & ((1 << bits) - 1)) !== 0) throw new Error("Base32 input has non-zero trailing bits.");
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
}

function encodeHex(value: string, maximumOutputCodePoints = Number.POSITIVE_INFINITY): string {
  const bytes = encodeUtf8(value, "UTF-8 hex encode input");
  if (bytes.length * 2 > maximumOutputCodePoints) {
    throw new Error(`UTF-8 hex encode output exceeds the ${maximumOutputCodePoints} Unicode code-point limit.`);
  }
  return [...bytes].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function decodeHex(value: string): string {
  const normalized = value.replace(/\s+/g, "").replace(/^0x/i, "");
  if (!normalized || normalized.length % 2 !== 0 || !/^[0-9a-f]+$/i.test(normalized)) {
    throw new Error("Hex input must contain an even number of hexadecimal digits.");
  }
  const bytes = new Uint8Array(normalized.length / 2);
  for (let index = 0; index < normalized.length; index += 2) {
    bytes[index / 2] = Number.parseInt(normalized.slice(index, index + 2), 16);
  }
  return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
}

function encodeUrl(value: string, maximumOutputCodePoints: number): string {
  const chunks: string[] = [];
  let codePoints = 0;
  for (const character of value) {
    codePoints = appendBounded(chunks, encodeURIComponent(character), codePoints, maximumOutputCodePoints, "URL encode output");
  }
  return chunks.join("");
}

function rot13(value: string): string {
  return value.replace(/[A-Za-z]/g, (character) => {
    const base = character <= "Z" ? 65 : 97;
    return String.fromCharCode(((character.charCodeAt(0) - base + 13) % 26) + base);
  });
}

function rotateAsciiLetters(value: string, shift: number): string {
  const normalizedShift = ((shift % 26) + 26) % 26;
  return value.replace(/[A-Za-z]/g, (character) => {
    const base = character <= "Z" ? 65 : 97;
    return String.fromCharCode(((character.charCodeAt(0) - base + normalizedShift) % 26) + base);
  });
}

function toFullwidth(value: string, convertSpace: boolean): string {
  const output: string[] = [];
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (codePoint === undefined) continue;
    if (convertSpace && codePoint === 0x20) output.push("\u3000");
    else if (codePoint >= 0x21 && codePoint <= 0x7e) output.push(String.fromCodePoint(codePoint + 0xfee0));
    else output.push(character);
  }
  return output.join("");
}

const zeroWidthCharacters = Object.freeze({
  "zero-width-space": "\u200b",
  "zero-width-non-joiner": "\u200c",
  "zero-width-joiner": "\u200d",
  "word-joiner": "\u2060"
} as const);

function insertZeroWidth(
  value: string,
  inputCodePoints: number,
  characterName: keyof typeof zeroWidthCharacters,
  interval: number,
  offset: number,
  maximumOutputCodePoints: number
): string {
  const firstInsertion = offset + interval;
  const insertionCount = firstInsertion <= inputCodePoints - 1
    ? Math.floor((inputCodePoints - 1 - firstInsertion) / interval) + 1
    : 0;
  if (inputCodePoints + insertionCount > maximumOutputCodePoints) {
    throw new Error(`Zero-width insertion output exceeds the ${maximumOutputCodePoints} Unicode code-point limit.`);
  }
  const marker = zeroWidthCharacters[characterName];
  const chunks: string[] = [];
  let completed = 0;
  for (const character of value) {
    chunks.push(character);
    completed += 1;
    if (completed < inputCodePoints && completed > offset && (completed - offset) % interval === 0) chunks.push(marker);
  }
  return chunks.join("");
}

function validateParameterRecord(
  definition: Pick<PayloadTransformDefinition, "label" | "parameterSchema" | "parameterDefaults">,
  parameters: Readonly<Record<string, string>> = {}
): PayloadTransformParameterValidationResult {
  const normalized: Record<string, string> = {};
  const errors: string[] = [];
  const entries = Object.entries(parameters);
  if (entries.length > payloadTransformParameterLimits.maxEntries) {
    return {
      valid: false,
      parameters: emptyParameters,
      errors: Object.freeze([`Parameters may contain at most ${payloadTransformParameterLimits.maxEntries} entries.`])
    };
  }
  let totalCodePoints = 0;
  for (const [name, value] of entries) {
    const nameCodePoints = countUnicodeCodePoints(name);
    if (nameCodePoints === 0) errors.push("Parameter names cannot be empty.");
    else if (nameCodePoints > payloadTransformParameterLimits.maxNameCodePoints) {
      errors.push(`Parameter name "${name.slice(0, 32)}" exceeds ${payloadTransformParameterLimits.maxNameCodePoints} Unicode code points.`);
    }
    if (typeof value !== "string") {
      errors.push(`Parameter "${name}" must be a string.`);
      continue;
    }
    const valueCodePoints = countUnicodeCodePoints(value);
    if (valueCodePoints > payloadTransformParameterLimits.maxValueCodePoints) {
      errors.push(`Parameter "${name}" exceeds ${payloadTransformParameterLimits.maxValueCodePoints} Unicode code points.`);
    }
    totalCodePoints += nameCodePoints + valueCodePoints;
  }
  if (totalCodePoints > payloadTransformParameterLimits.maxTotalCodePoints) {
    errors.push(`Parameters exceed the ${payloadTransformParameterLimits.maxTotalCodePoints} Unicode code-point aggregate limit.`);
  }
  const known = new Set(definition.parameterSchema.fields.map((field) => field.name));
  for (const field of definition.parameterSchema.fields) {
    const supplied = parameters[field.name] ?? definition.parameterDefaults[field.name] ?? field.defaultValue;
    if (supplied === undefined) {
      if (field.required) errors.push(`${field.label} is required.`);
      continue;
    }
    if (field.type === "integer") {
      const trimmed = supplied.trim();
      const number = Number(trimmed);
      if (!/^-?\d+$/.test(trimmed) || !Number.isSafeInteger(number)) errors.push(`${field.label} must be a safe integer.`);
      else if (field.minimum !== undefined && number < field.minimum) errors.push(`${field.label} must be at least ${field.minimum}.`);
      else if (field.maximum !== undefined && number > field.maximum) errors.push(`${field.label} must be at most ${field.maximum}.`);
      else setOwnString(normalized, field.name, String(number));
      continue;
    }
    if (field.type === "boolean") {
      const lowered = supplied.trim().toLowerCase();
      if (lowered !== "true" && lowered !== "false") errors.push(`${field.label} must be true or false.`);
      else setOwnString(normalized, field.name, lowered);
      continue;
    }
    if (field.type === "enum") {
      const trimmed = supplied.trim();
      if (!field.options?.some((option) => option.value === trimmed)) {
        errors.push(`${field.label} must be one of: ${field.options?.map((option) => option.value).join(", ") ?? ""}.`);
      } else setOwnString(normalized, field.name, trimmed);
      continue;
    }
    setOwnString(normalized, field.name, supplied);
  }
  for (const name of Object.keys(parameters).sort()) {
    if (known.has(name)) continue;
    if (definition.parameterSchema.allowAdditional) setOwnString(normalized, name, parameters[name] ?? "");
    else errors.push(`Unknown parameter "${name}" for ${definition.label}.`);
  }
  return { valid: errors.length === 0, parameters: Object.freeze(normalized), errors: Object.freeze(errors) };
}

interface TransformMetadata {
  readonly id: PayloadTransformId;
  readonly label: string;
  readonly description: string;
  readonly group: PayloadTransformGroup;
  readonly tags?: readonly string[];
  readonly parameterSchema?: PayloadTransformParameterSchema;
  readonly parameterDefaults?: Readonly<Record<string, string>>;
  readonly inputKind?: PayloadTransformValueKind;
  readonly outputKind?: PayloadTransformValueKind;
  readonly reversible?: boolean;
  readonly inverseTransformId?: PayloadTransformId;
  readonly lossiness?: PayloadTransformLossiness;
  readonly expansion?: PayloadTransformExpansionEstimate;
  readonly compatibility?: readonly PayloadTransformCompatibilityFlag[];
  readonly riskFlags?: readonly PayloadTransformRiskFlag[];
  readonly warnings?: readonly PayloadTransformWarning[];
}

interface TransformApplicationContext {
  readonly inputCodePoints: number;
  readonly limits: PayloadTransformSizeLimits;
}

function definePayloadTransform(
  metadata: TransformMetadata,
  implementation: (value: string, parameters: Readonly<Record<string, string>>, context: TransformApplicationContext) => string
): PayloadTransformDefinition {
  const parameterSchema = metadata.parameterSchema ?? noParameters;
  const parameterDefaults = metadata.parameterDefaults ?? emptyParameters;
  const compatibility = metadata.compatibility ?? ["unicode-code-point-safe"];
  const riskFlags = metadata.riskFlags ?? [];
  const common = {
    id: metadata.id,
    version: 1 as const,
    label: metadata.label,
    description: metadata.description,
    group: metadata.group,
    category: metadata.group,
    tags: metadata.tags ?? [metadata.group, "deterministic", ...compatibility, ...riskFlags],
    parameterSchema,
    parameterDefaults,
    inputKind: metadata.inputKind ?? "text",
    outputKind: metadata.outputKind ?? "text",
    deterministic: true as const,
    reversible: metadata.reversible ?? false,
    lossiness: metadata.lossiness ?? "lossless",
    expansion: metadata.expansion ?? unchangedExpansion,
    compatibility,
    riskFlags,
    warnings: metadata.warnings ?? [],
    limits: payloadTransformLimits
  } satisfies Omit<PayloadTransformDefinition, "apply" | "inverseTransformId">;
  return deepFreeze({
    ...common,
    ...(metadata.inverseTransformId === undefined ? {} : { inverseTransformId: metadata.inverseTransformId }),
    apply: (value: string, parameters?: Readonly<Record<string, string>>) => {
      const inputCodePoints = assertCodePointLimit(value, payloadTransformLimits.maxInputCodePoints, `${metadata.label} input`);
      const validation = validateParameterRecord({ label: metadata.label, parameterSchema, parameterDefaults }, parameters);
      if (!validation.valid) throw new Error(`Invalid parameters for ${metadata.label}: ${validation.errors.join(" ")}`);
      const output = implementation(value, validation.parameters, { inputCodePoints, limits: payloadTransformLimits });
      assertCodePointLimit(output, payloadTransformLimits.maxOutputCodePoints, `${metadata.label} output`);
      return output;
    }
  });
}

const definitions: readonly PayloadTransformDefinition[] = deepFreeze([
  definePayloadTransform({ id: "base64-encode", label: "Base64 encode", description: "Encode UTF-8 bytes as padded Base64.", group: "encoding", outputKind: "encoded-text", reversible: true, inverseTransformId: "base64-decode", expansion: { kind: "bounded", maxFactor: 16 / 3, fixedCodePoints: 4, summary: "Expands according to UTF-8 byte length." }, compatibility: ["utf8-aware", "ascii-output"], riskFlags: ["output-expansion"] }, (value, _parameters, context) => {
    const bytes = encodeUtf8(value, "Base64 encode input");
    if (4 * Math.ceil(bytes.length / 3) > context.limits.maxOutputCodePoints) throw new Error(`Base64 encode output exceeds the ${context.limits.maxOutputCodePoints} Unicode code-point limit.`);
    return bytesToBase64(bytes);
  }),
  definePayloadTransform({ id: "base64-decode", label: "Base64 decode", description: "Decode Base64 bytes as strict UTF-8.", group: "encoding", inputKind: "encoded-text", reversible: true, inverseTransformId: "base64-encode", lossiness: "conditional", compatibility: ["ascii-input", "utf8-aware"], riskFlags: ["strict-decoder"] }, (value) => new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(value))),
  definePayloadTransform({ id: "base32-encode", label: "Base32 encode", description: "Encode UTF-8 bytes with padded RFC 4648 Base32.", group: "encoding", outputKind: "encoded-text", reversible: true, inverseTransformId: "base32-decode", expansion: { kind: "bounded", maxFactor: 6.4, fixedCodePoints: 8, summary: "Expands according to UTF-8 byte length and eight-character padding blocks." }, compatibility: ["utf8-aware", "ascii-output"], riskFlags: ["output-expansion"] }, (value, _parameters, context) => encodeBase32(value, context.limits.maxOutputCodePoints)),
  definePayloadTransform({ id: "base32-decode", label: "Base32 decode", description: "Decode padded or unpadded RFC 4648 Base32 as strict UTF-8.", group: "encoding", inputKind: "encoded-text", reversible: true, inverseTransformId: "base32-encode", lossiness: "conditional", compatibility: ["ascii-input", "utf8-aware"], riskFlags: ["strict-decoder"] }, decodeBase32),
  definePayloadTransform({ id: "url-encode", label: "URL encode", description: "Percent-encode text with encodeURIComponent semantics.", group: "encoding", outputKind: "encoded-text", reversible: true, inverseTransformId: "url-decode", expansion: { kind: "bounded", maxFactor: 12, fixedCodePoints: 0, summary: "Each Unicode code point can expand to four encoded UTF-8 bytes." }, compatibility: ["unicode-code-point-safe", "utf8-aware", "ascii-output"], riskFlags: ["output-expansion"] }, (value, _parameters, context) => encodeUrl(value, context.limits.maxOutputCodePoints)),
  definePayloadTransform({ id: "url-decode", label: "URL decode", description: "Decode percent-encoded UTF-8 text.", group: "encoding", inputKind: "encoded-text", reversible: true, inverseTransformId: "url-encode", lossiness: "conditional", compatibility: ["ascii-input", "utf8-aware"], riskFlags: ["strict-decoder"] }, (value) => decodeURIComponent(value)),
  definePayloadTransform({ id: "hex-encode", label: "UTF-8 hex encode", description: "Encode every UTF-8 byte as lowercase hexadecimal.", group: "encoding", outputKind: "encoded-text", reversible: true, inverseTransformId: "hex-decode", expansion: { kind: "bounded", maxFactor: 8, fixedCodePoints: 0, summary: "Each Unicode code point occupies one to four UTF-8 bytes." }, compatibility: ["utf8-aware", "ascii-output"], riskFlags: ["output-expansion"] }, (value, _parameters, context) => encodeHex(value, context.limits.maxOutputCodePoints)),
  definePayloadTransform({ id: "hex-decode", label: "UTF-8 hex decode", description: "Decode hexadecimal bytes as strict UTF-8.", group: "encoding", inputKind: "encoded-text", reversible: true, inverseTransformId: "hex-encode", lossiness: "conditional", compatibility: ["ascii-input", "utf8-aware"], riskFlags: ["strict-decoder"] }, decodeHex),
  definePayloadTransform({ id: "uppercase", label: "Uppercase", description: "Apply Unicode uppercase conversion.", group: "text", lossiness: "lossy", expansion: { kind: "input-dependent", maxFactor: null, fixedCodePoints: 0, summary: "Unicode case conversion can change output length." }, riskFlags: ["lossy"] }, (value) => value.toUpperCase()),
  definePayloadTransform({ id: "lowercase", label: "Lowercase", description: "Apply Unicode lowercase conversion.", group: "text", lossiness: "lossy", expansion: { kind: "input-dependent", maxFactor: null, fixedCodePoints: 0, summary: "Unicode case conversion can change output length." }, riskFlags: ["lossy"] }, (value) => value.toLowerCase()),
  definePayloadTransform({ id: "reverse", label: "Reverse", description: "Reverse Unicode code points without splitting surrogate pairs.", group: "text", reversible: true, inverseTransformId: "reverse", riskFlags: ["grapheme-sensitive"], warnings: [{ code: "grapheme-order", severity: "warning", message: "Combining marks and multi-code-point graphemes reverse separately." }] }, (value) => [...value].reverse().join("")),
  definePayloadTransform({ id: "rot13", label: "ROT13", description: "Rotate ASCII letters by 13 positions.", group: "text", reversible: true, inverseTransformId: "rot13" }, rot13),
  definePayloadTransform({
    id: "caesar-rotate", label: "Caesar rotation", description: "Rotate ASCII letters by a configurable signed offset.", group: "text",
    parameterSchema: { mode: "defined", allowAdditional: false, fields: [{ name: "shift", label: "Shift", description: "Signed ASCII alphabet rotation.", type: "integer", required: true, defaultValue: "13", minimum: -25, maximum: 25 }] },
    parameterDefaults: { shift: "13" }, reversible: true, inverseTransformId: "caesar-rotate"
  }, (value, parameters) => rotateAsciiLetters(value, Number(parameters.shift))),
  definePayloadTransform({
    id: "fullwidth", label: "Fullwidth Unicode", description: "Map printable ASCII to visually similar fullwidth Unicode characters.", group: "text",
    parameterSchema: { mode: "defined", allowAdditional: false, fields: [{ name: "convertSpace", label: "Convert spaces", description: "Map ASCII spaces to ideographic spaces.", type: "boolean", required: true, defaultValue: "true" }] },
    parameterDefaults: { convertSpace: "true" }, lossiness: "conditional",
    compatibility: ["unicode-code-point-safe", "normalization-sensitive", "provider-rendering-dependent"], riskFlags: ["unicode-confusable"],
    warnings: [{ code: "unicode-confusables", severity: "warning", message: "Fullwidth characters may look like ASCII and may be folded by Unicode normalization." }]
  }, (value, parameters) => toFullwidth(value, parameters.convertSpace === "true")),
  definePayloadTransform({
    id: "zero-width-insert", label: "Zero-width insertion", description: "Insert an invisible Unicode character at a deterministic code-point interval.", group: "text",
    parameterSchema: {
      mode: "defined", allowAdditional: false, fields: [
        { name: "character", label: "Character", description: "Invisible character to insert.", type: "enum", required: true, defaultValue: "zero-width-space", options: [
          { value: "zero-width-space", label: "Zero-width space (U+200B)" },
          { value: "zero-width-non-joiner", label: "Zero-width non-joiner (U+200C)" },
          { value: "zero-width-joiner", label: "Zero-width joiner (U+200D)" },
          { value: "word-joiner", label: "Word joiner (U+2060)" }
        ] },
        { name: "interval", label: "Interval", description: "Insert after every N source code points.", type: "integer", required: true, defaultValue: "1", minimum: 1, maximum: 1_000 },
        { name: "offset", label: "Offset", description: "Skip this many source code points first.", type: "integer", required: true, defaultValue: "0", minimum: 0, maximum: 1_000_000 }
      ]
    },
    parameterDefaults: { character: "zero-width-space", interval: "1", offset: "0" }, lossiness: "conditional",
    expansion: { kind: "bounded", maxFactor: 2, fixedCodePoints: 0, summary: "At interval one, inserts one invisible code point between source code points." },
    compatibility: ["unicode-code-point-safe", "normalization-sensitive", "provider-rendering-dependent"], riskFlags: ["invisible-unicode", "output-expansion"],
    warnings: [{ code: "invisible-unicode", severity: "warning", message: "Editors, providers, or normalizers may remove or reinterpret invisible characters." }]
  }, (value, parameters, context) => insertZeroWidth(value, context.inputCodePoints, parameters.character as keyof typeof zeroWidthCharacters, Number(parameters.interval), Number(parameters.offset), context.limits.maxOutputCodePoints)),
  definePayloadTransform({ id: "json-escape", label: "JSON escape", description: "Escape text for a JSON string without surrounding quotes.", group: "text", outputKind: "encoded-text", reversible: true, inverseTransformId: "json-unescape", expansion: { kind: "bounded", maxFactor: 6, fixedCodePoints: 0, summary: "Control characters may expand to Unicode escapes." }, riskFlags: ["output-expansion"] }, (value) => JSON.stringify(value).slice(1, -1)),
  definePayloadTransform({ id: "json-unescape", label: "JSON unescape", description: "Decode JSON string contents without surrounding quotes.", group: "text", inputKind: "encoded-text", reversible: true, inverseTransformId: "json-escape", lossiness: "conditional", riskFlags: ["strict-decoder"] }, (value) => JSON.parse(`"${value}"`) as string),
  definePayloadTransform({ id: "markdown-frame", label: "Markdown fence", description: "Wrap the payload in a Markdown text fence.", group: "framing", expansion: { kind: "bounded", maxFactor: 1, fixedCodePoints: 12, summary: "Adds a fixed Markdown fence." }, compatibility: ["unicode-code-point-safe", "provider-rendering-dependent"], riskFlags: ["output-expansion"] }, (value) => `\`\`\`text\n${value}\n\`\`\``),
  definePayloadTransform({ id: "xml-frame", label: "XML payload", description: "Wrap the unescaped payload in an XML element.", group: "framing", expansion: { kind: "bounded", maxFactor: 1, fixedCodePoints: 21, summary: "Adds fixed payload tags." }, riskFlags: ["output-expansion"], warnings: [{ code: "xml-unescaped", severity: "info", message: "Payload text is intentionally not XML-escaped." }] }, (value) => `<payload>\n${value}\n</payload>`),
  definePayloadTransform({ id: "json-frame", label: "JSON payload", description: "Serialize the payload inside a formatted JSON object.", group: "framing", expansion: { kind: "input-dependent", maxFactor: 6, fixedCodePoints: 20, summary: "Adds an object wrapper and JSON escaping." }, riskFlags: ["output-expansion"] }, (value) => JSON.stringify({ payload: value }, null, 2)),
  definePayloadTransform({ id: "repeat-twice", label: "Repeat twice", description: "Repeat the exact payload with a blank line between copies.", group: "framing", expansion: { kind: "bounded", maxFactor: 2, fixedCodePoints: 2, summary: "Doubles the source and adds two newlines." }, riskFlags: ["output-expansion"] }, (value, _parameters, context) => {
    if (context.inputCodePoints * 2 + 2 > context.limits.maxOutputCodePoints) throw new Error(`Repeat twice output exceeds the ${context.limits.maxOutputCodePoints} Unicode code-point limit.`);
    return `${value}\n\n${value}`;
  }),
  definePayloadTransform({ id: "render-variables", label: "Render variables", description: "Replace named double-brace placeholders with supplied values.", group: "variables", parameterSchema: variableParameters, inputKind: "template", lossiness: "conditional", expansion: { kind: "input-dependent", maxFactor: null, fixedCodePoints: 0, summary: "Expansion depends on variable values." }, riskFlags: ["output-expansion"] }, (value, parameters, context) => {
    const rendered = renderPayloadVariablesWithLimit(value, parameters, context.limits.maxOutputCodePoints);
    if (rendered.missing.length > 0) throw new Error(`Missing payload variables: ${rendered.missing.join(", ")}`);
    return rendered.value;
  })
]);

export const payloadTransforms = definitions;

export function getPayloadTransform(id: PayloadTransformId): PayloadTransformDefinition {
  const definition = definitions.find((item) => item.id === id);
  if (!definition) throw new Error(`Unknown payload transform: ${id}`);
  return definition;
}

export function validatePayloadTransformParameters(
  id: PayloadTransformId,
  parameters?: Readonly<Record<string, string>>
): PayloadTransformParameterValidationResult {
  return validateParameterRecord(getPayloadTransform(id), parameters);
}

export function normalizePayloadTransformParameters(
  id: PayloadTransformId,
  parameters?: Readonly<Record<string, string>>
): Readonly<Record<string, string>> {
  const definition = getPayloadTransform(id);
  const validation = validateParameterRecord(definition, parameters);
  if (!validation.valid) throw new Error(`Invalid parameters for ${definition.label}: ${validation.errors.join(" ")}`);
  return validation.parameters;
}

export function inversePayloadTransformParameters(
  id: PayloadTransformId,
  parameters?: Readonly<Record<string, string>>
): Readonly<Record<string, string>> | null {
  const definition = getPayloadTransform(id);
  if (!definition.reversible || definition.inverseTransformId === undefined) return null;
  const normalized = normalizePayloadTransformParameters(id, parameters);
  if (id === "caesar-rotate") return Object.freeze({ shift: String(-Number(normalized.shift)) });
  return emptyParameters;
}

export function applyPayloadTransform(id: PayloadTransformId, value: string, parameters?: Readonly<Record<string, string>>): string {
  return getPayloadTransform(id).apply(value, parameters);
}

export function evaluatePayloadPipeline(value: string, steps: readonly PayloadPipelineStep[]): PayloadPipelineResult {
  let current = value;
  const results: PayloadPipelineStepResult[] = [];
  for (const [index, step] of steps.entries()) {
    if (!step.enabled) continue;
    const input = current;
    try {
      const transform = getPayloadTransform(step.transformId);
      if (transform.version !== step.version) throw new Error(`Unsupported ${step.transformId} version ${step.version}`);
      current = transform.apply(input, step.parameters);
      results.push({ index, transformId: step.transformId, input, output: current, error: null });
    } catch (error) {
      results.push({ index, transformId: step.transformId, input, output: null, error: error instanceof Error ? error.message : String(error) });
      return { output: current, steps: results, completed: false };
    }
  }
  return { output: current, steps: results, completed: true };
}
