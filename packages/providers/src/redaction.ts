import type { JsonObject, JsonValue } from "./types.js";

export const REDACTED = "[REDACTED]";

const SENSITIVE_KEY =
  /(?:^|[-_])(authorization|api[-_]?key|token|secret|password|credential|cookie)(?:$|[-_])/i;
const AUTH_VALUE = /\b(Bearer|Basic)\s+[A-Za-z0-9._~+/=-]+/gi;

function redactKnownSecrets(value: string, secrets: readonly string[]): string {
  let redacted = value.replace(AUTH_VALUE, (_match, scheme: string) => `${scheme} ${REDACTED}`);
  for (const secret of secrets) {
    if (secret.length >= 4) redacted = redacted.split(secret).join(REDACTED);
  }
  return redacted;
}

export function redactHeaders(
  headers: Headers | Readonly<Record<string, string>>,
  secrets: readonly string[] = [],
): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  return Object.fromEntries(
    entries.map(([name, value]) => [
      name,
      SENSITIVE_KEY.test(name) ? REDACTED : redactKnownSecrets(value, secrets),
    ]),
  );
}

export function redactJson(value: JsonValue, secrets: readonly string[] = []): JsonValue {
  if (typeof value === "string") return redactKnownSecrets(value, secrets);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactJson(item, secrets));

  const redacted: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = SENSITIVE_KEY.test(key) ? REDACTED : redactJson(item, secrets);
  }
  return redacted;
}

export function redactText(value: string, secrets: readonly string[] = []): string {
  return redactKnownSecrets(value, secrets);
}

export function redactUrl(value: string, secrets: readonly string[] = []): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    for (const key of [...url.searchParams.keys()]) {
      if (SENSITIVE_KEY.test(key)) url.searchParams.set(key, REDACTED);
    }
    return redactKnownSecrets(url.toString(), secrets);
  } catch {
    return redactKnownSecrets(value, secrets);
  }
}
