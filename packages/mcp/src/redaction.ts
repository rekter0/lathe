import { replaceKnownSecrets } from "@lathe/domain";
import type { JsonValue } from "./types.js";

const REFERENCE_SUFFIX = /(?:id|ref|reference|name)$/i;
const AUTH_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

function isSensitiveKey(key: string): boolean {
  const normalized = key.replaceAll(/[-_]/g, "").toLowerCase();
  return normalized.includes("authorization")
    || normalized.includes("apikey")
    || normalized.includes("secret")
    || normalized.includes("password")
    || normalized.includes("passwd")
    || normalized.includes("credential")
    || normalized.includes("privatekey")
    || normalized.includes("cookie")
    || normalized === "auth"
    || normalized.endsWith("auth")
    || normalized.endsWith("token");
}

function replaceSecrets(value: string, secrets: readonly string[], redactionEnabled: boolean): string {
  const result = redactionEnabled
    ? value.replace(AUTH_VALUE, (_match, scheme: string) => `${scheme} [REDACTED]`)
    : value;
  return replaceKnownSecrets(result, secrets, "[REDACTED]").value;
}

export function redactJson(
  value: unknown,
  secrets: readonly string[] = [],
  redactSensitiveKeys = true,
): JsonValue {
  if (value === null || typeof value === "boolean") return value;
  if (typeof value === "string") return replaceSecrets(value, secrets, redactSensitiveKeys);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "undefined") return null;
  if (Array.isArray(value)) return value.map((entry) => redactJson(entry, secrets, redactSensitiveKeys));
  if (typeof value !== "object") return String(value);

  const output: Record<string, JsonValue> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (redactSensitiveKeys && isSensitiveKey(key) && !REFERENCE_SUFFIX.test(key)) {
      output[key] = "[REDACTED]";
    } else {
      output[key] = redactJson(entry, secrets, redactSensitiveKeys);
    }
  }
  return output;
}
