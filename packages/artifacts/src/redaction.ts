import type { JsonValue } from "@lathe/domain";

export const REDACTED_CREDENTIAL = "[REDACTED CREDENTIAL]";

const SENSITIVE_KEY = /(?:authorization|proxy-authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|cookie|private[-_]?key|client[-_]?secret|secret)/i;
const REFERENCE_SUFFIX = /(?:id|ref|reference|name)$/i;
const HEADER_LINE = /^(\s*(?:authorization|proxy-authorization|x-api-key|api-key|cookie)\s*[:=]\s*).+$/gim;
const ASSIGNMENT = /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\b\s*[:=]\s*)["']?[^\s,"';}]+["']?/gi;

export interface RedactionResult<T> {
  value: T;
  count: number;
}

function scrubSecrets(value: string, secrets: readonly string[]): RedactionResult<string> {
  let output = value;
  let count = 0;
  for (const secret of new Set(secrets.filter((entry) => entry.length > 0))) {
    const pieces = output.split(secret);
    if (pieces.length > 1) {
      count += pieces.length - 1;
      output = pieces.join(REDACTED_CREDENTIAL);
    }
  }
  return { value: output, count };
}

export function redactArtifactJson(
  value: JsonValue,
  secrets: readonly string[] = [],
): RedactionResult<JsonValue> {
  if (typeof value === "string") return scrubSecrets(value, secrets);
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return { value, count: 0 };
  }
  if (Array.isArray(value)) {
    const output: JsonValue[] = [];
    let count = 0;
    for (const item of value) {
      const redacted = redactArtifactJson(item, secrets);
      output.push(redacted.value);
      count += redacted.count;
    }
    return { value: output, count };
  }

  const output: Record<string, JsonValue> = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) && !REFERENCE_SUFFIX.test(key)) {
      output[key] = REDACTED_CREDENTIAL;
      count += 1;
      continue;
    }
    const redacted = redactArtifactJson(item, secrets);
    output[key] = redacted.value;
    count += redacted.count;
  }
  return { value: output, count };
}

export function redactArtifactText(
  text: string,
  secrets: readonly string[] = [],
): RedactionResult<string> {
  const explicit = scrubSecrets(text, secrets);
  let count = explicit.count;
  let output = explicit.value.replace(HEADER_LINE, (_match, prefix: string) => {
    count += 1;
    return `${prefix}${REDACTED_CREDENTIAL}`;
  });
  output = output.replace(ASSIGNMENT, (_match, prefix: string) => {
    count += 1;
    return `${prefix}${REDACTED_CREDENTIAL}`;
  });
  return { value: output, count };
}

export function containsKnownSecret(bytes: Uint8Array, secrets: readonly string[]): boolean {
  if (secrets.length === 0) return false;
  const text = Buffer.from(bytes).toString("utf8");
  return secrets.some((secret) => secret.length > 0 && text.includes(secret));
}
