export type PayloadTransformId =
  | "base64-encode"
  | "base64-decode"
  | "url-encode"
  | "url-decode"
  | "hex-encode"
  | "hex-decode"
  | "uppercase"
  | "lowercase"
  | "reverse"
  | "rot13"
  | "json-escape"
  | "json-unescape"
  | "markdown-frame"
  | "xml-frame"
  | "json-frame"
  | "repeat-twice"
  | "render-variables";

export interface PayloadTransformDefinition {
  readonly id: PayloadTransformId;
  readonly version: 1;
  readonly label: string;
  readonly group: "encoding" | "text" | "framing" | "variables";
  apply(value: string, parameters?: Readonly<Record<string, string>>): string;
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

const variablePattern = /\{\{\s*([A-Za-z][A-Za-z0-9_.-]*)\s*\}\}/g;

export function renderPayloadVariables(value: string, variables: Readonly<Record<string, string>>): RenderVariablesResult {
  const referenced: string[] = [];
  const missing: string[] = [];
  const output = value.replace(variablePattern, (match, name: string) => {
    if (!referenced.includes(name)) referenced.push(name);
    const replacement = variables[name];
    if (replacement === undefined) {
      if (!missing.includes(name)) missing.push(name);
      return match;
    }
    return replacement;
  });
  return { value: output, referenced, missing };
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

function encodeHex(value: string): string {
  return [...new TextEncoder().encode(value)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
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

function rot13(value: string): string {
  return value.replace(/[A-Za-z]/g, (character) => {
    const base = character <= "Z" ? 65 : 97;
    return String.fromCharCode(((character.charCodeAt(0) - base + 13) % 26) + base);
  });
}

const definitions: readonly PayloadTransformDefinition[] = [
  { id: "base64-encode", version: 1, label: "Base64 encode", group: "encoding", apply: (value) => bytesToBase64(new TextEncoder().encode(value)) },
  { id: "base64-decode", version: 1, label: "Base64 decode", group: "encoding", apply: (value) => new TextDecoder("utf-8", { fatal: true }).decode(base64ToBytes(value)) },
  { id: "url-encode", version: 1, label: "URL encode", group: "encoding", apply: encodeURIComponent },
  { id: "url-decode", version: 1, label: "URL decode", group: "encoding", apply: decodeURIComponent },
  { id: "hex-encode", version: 1, label: "UTF-8 hex encode", group: "encoding", apply: encodeHex },
  { id: "hex-decode", version: 1, label: "UTF-8 hex decode", group: "encoding", apply: decodeHex },
  { id: "uppercase", version: 1, label: "Uppercase", group: "text", apply: (value) => value.toUpperCase() },
  { id: "lowercase", version: 1, label: "Lowercase", group: "text", apply: (value) => value.toLowerCase() },
  { id: "reverse", version: 1, label: "Reverse", group: "text", apply: (value) => [...value].reverse().join("") },
  { id: "rot13", version: 1, label: "ROT13", group: "text", apply: rot13 },
  { id: "json-escape", version: 1, label: "JSON escape", group: "text", apply: (value) => JSON.stringify(value).slice(1, -1) },
  { id: "json-unescape", version: 1, label: "JSON unescape", group: "text", apply: (value) => JSON.parse(`"${value}"`) as string },
  { id: "markdown-frame", version: 1, label: "Markdown fence", group: "framing", apply: (value) => `\`\`\`text\n${value}\n\`\`\`` },
  { id: "xml-frame", version: 1, label: "XML payload", group: "framing", apply: (value) => `<payload>\n${value}\n</payload>` },
  { id: "json-frame", version: 1, label: "JSON payload", group: "framing", apply: (value) => JSON.stringify({ payload: value }, null, 2) },
  { id: "repeat-twice", version: 1, label: "Repeat twice", group: "framing", apply: (value) => `${value}\n\n${value}` },
  {
    id: "render-variables",
    version: 1,
    label: "Render variables",
    group: "variables",
    apply: (value, parameters = {}) => {
      const rendered = renderPayloadVariables(value, parameters);
      if (rendered.missing.length > 0) throw new Error(`Missing payload variables: ${rendered.missing.join(", ")}`);
      return rendered.value;
    }
  }
];

export const payloadTransforms = definitions;

export function getPayloadTransform(id: PayloadTransformId): PayloadTransformDefinition {
  const definition = definitions.find((item) => item.id === id);
  if (!definition) throw new Error(`Unknown payload transform: ${id}`);
  return definition;
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
