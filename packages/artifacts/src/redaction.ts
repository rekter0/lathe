import { replaceKnownSecrets, type JsonValue } from "@lathe/domain";

export const REDACTED_CREDENTIAL = "[REDACTED CREDENTIAL]";

const SENSITIVE_KEY = /(?:authorization|proxy-authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|cookie|private[-_]?key|client[-_]?secret|secret)/i;
const RUNTIME_ACCOUNT_KEY = /^(?:auth(?:mode|state)?|account(?:id|identifier|type|plan)?|planType)$/i;
const REFERENCE_SUFFIX = /(?:id|ref|reference|name)$/i;
const HEADER_LINE = /^(\s*(?:authorization|proxy-authorization|x-api-key|api-key|cookie)\s*[:=]\s*).+$/gim;
const ASSIGNMENT = /(\b(?:api[_-]?key|access[_-]?token|refresh[_-]?token|password|client[_-]?secret)\b\s*[:=]\s*)["']?[^\s,"';}]+["']?/gi;
const RUNTIME_ACCOUNT_ASSIGNMENT = /(\b(?:auth(?:mode|state)?|account(?:id|identifier|type|plan)?|planType)\b\s*[:=]\s*)["']?[^\s,"';}]+["']?/gi;

export interface RedactionResult<T> {
  value: T;
  count: number;
}

function scrubSecrets(value: string, secrets: readonly string[]): RedactionResult<string> {
  return replaceKnownSecrets(value, secrets, REDACTED_CREDENTIAL);
}

export function redactArtifactJson(
  value: JsonValue,
  secrets: readonly string[] = [],
  redactionEnabled = true,
): RedactionResult<JsonValue> {
  if (typeof value === "string") return scrubSecrets(value, secrets);
  if (value === null || typeof value === "boolean" || typeof value === "number") {
    return { value, count: 0 };
  }
  if (Array.isArray(value)) {
    const output: JsonValue[] = [];
    let count = 0;
    for (const item of value) {
      const redacted = redactArtifactJson(item, secrets, redactionEnabled);
      output.push(redacted.value);
      count += redacted.count;
    }
    return { value: output, count };
  }

  const output: Record<string, JsonValue> = {};
  let count = 0;
  for (const [key, item] of Object.entries(value)) {
    if (redactionEnabled && (RUNTIME_ACCOUNT_KEY.test(key) || (SENSITIVE_KEY.test(key) && !REFERENCE_SUFFIX.test(key)))) {
      output[key] = REDACTED_CREDENTIAL;
      count += 1;
      continue;
    }
    const redacted = redactArtifactJson(item, secrets, redactionEnabled);
    output[key] = redacted.value;
    count += redacted.count;
  }
  return { value: output, count };
}

export function redactArtifactText(
  text: string,
  secrets: readonly string[] = [],
  redactionEnabled = true,
): RedactionResult<string> {
  const explicit = scrubSecrets(text, secrets);
  let count = explicit.count;
  let output = explicit.value;
  if (redactionEnabled) {
    output = output.replace(RUNTIME_ACCOUNT_ASSIGNMENT, (_match, prefix: string) => {
      count += 1;
      return `${prefix}${REDACTED_CREDENTIAL}`;
    });
    output = output.replace(HEADER_LINE, (_match, prefix: string) => {
      count += 1;
      return `${prefix}${REDACTED_CREDENTIAL}`;
    });
    output = output.replace(ASSIGNMENT, (_match, prefix: string) => {
      count += 1;
      return `${prefix}${REDACTED_CREDENTIAL}`;
    });
  }
  return { value: output, count };
}

export function containsKnownSecret(bytes: Uint8Array, secrets: readonly string[]): boolean {
  if (secrets.length === 0) return false;
  const text = Buffer.from(bytes).toString("utf8");
  return replaceKnownSecrets(text, secrets, "").count > 0;
}
