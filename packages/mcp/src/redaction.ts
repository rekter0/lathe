import type { JsonValue } from "./types.js";

const SENSITIVE_KEY = /(?:authorization|proxy-authorization|api[-_]?key|access[-_]?token|refresh[-_]?token|password|passwd|cookie|private[-_]?key|client[-_]?secret|secret)/i;
const REFERENCE_SUFFIX = /(?:id|ref|reference|name)$/i;

function replaceSecrets(value: string, secrets: readonly string[]): string {
  let result = value;
  for (const secret of secrets) {
    if (secret.length > 0) result = result.split(secret).join("[REDACTED]");
  }
  return result;
}

export function redactJson(value: unknown, secrets: readonly string[] = []): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return replaceSecrets(value, secrets);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (Array.isArray(value)) return value.map((entry) => redactJson(entry, secrets));
  if (typeof value !== "object") return String(value);

  const output: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (SENSITIVE_KEY.test(key) && !REFERENCE_SUFFIX.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactJson(entry, secrets);
    }
  }
  return output;
}
