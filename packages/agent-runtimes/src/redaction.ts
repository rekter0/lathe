import type { JsonValue } from "./types.js";

const REDACTED = "[REDACTED]";
const SENSITIVE_KEY = /(?:^|[_-])(?:access|refresh|id)?token(?:$|[_-])|secret|password|authorization|cookie|api[_-]?key|email|account[_-]?id|chatgpt[_-]?account|codexhome/i;
const SENSITIVE_QUERY_KEY = /token|secret|password|auth|key|credential|session/i;

function redactUrls(text: string): string {
  return text.replace(/https?:\/\/[^\s"'<>]+/gu, (candidate) => {
    try {
      const url = new URL(candidate);
      for (const name of Array.from(url.searchParams.keys())) {
        if (SENSITIVE_QUERY_KEY.test(name)) url.searchParams.set(name, REDACTED);
      }
      if (url.username || url.password) {
        url.username = REDACTED;
        url.password = "";
      }
      return url.toString();
    } catch {
      return candidate;
    }
  });
}

export function redactRuntimeText(value: string): string {
  return redactUrls(value)
    .replace(/\bBearer\s+[^\s,"'}]+/giu, `Bearer ${REDACTED}`)
    .replace(/\b(?:sk|sess|pat)-[A-Za-z0-9_-]{8,}\b/gu, REDACTED)
    .replace(/\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\b/gu, REDACTED)
    .replace(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/giu, REDACTED)
    .replace(/((?:chatgpt[_ -]?)?account(?:[_ -]?id)?\s*[:=]\s*)["']?[^\s,"'}]+/giu, `$1${REDACTED}`)
    .replace(/((?:access|refresh|id)?token|api[_ -]?key|authorization|cookie|password|secret)(\s*[:=]\s*)["']?[^\s,"'}]+/giu, `$1$2${REDACTED}`);
}

export function redactRuntimeJson(value: unknown, key = ""): JsonValue {
  if (SENSITIVE_KEY.test(key)) return REDACTED;
  if (value === null) return null;
  if (typeof value === "string") return redactRuntimeText(value);
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  if (typeof value === "boolean") return value;
  if (Array.isArray(value)) return value.map((entry) => redactRuntimeJson(entry));
  if (typeof value === "object") {
    const result: Record<string, JsonValue> = {};
    for (const [entryKey, entryValue] of Object.entries(value as Record<string, unknown>)) {
      result[entryKey] = redactRuntimeJson(entryValue, entryKey);
    }
    return result;
  }
  return String(value);
}
