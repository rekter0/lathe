import { replaceKnownSecrets } from "@lathe/domain";
import type { JsonObject, JsonValue } from "./types.js";

export const REDACTED = "[REDACTED]";

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

interface ProviderSecretSource {
  readonly credential?: string | null;
  readonly headers?: Readonly<Record<string, string>>;
  readonly baseUrl?: string;
  readonly endpointOverride?: string | null;
  readonly extraBody?: JsonObject;
}

function collectStringLeaves(value: JsonValue, values: Set<string>): void {
  if (typeof value === "string") {
    if (value.length > 0) values.add(value);
    return;
  }
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectStringLeaves(item, values);
    return;
  }
  for (const item of Object.values(value)) collectStringLeaves(item, values);
}

function collectSensitiveJsonValues(value: JsonValue, values: Set<string>): void {
  if (value === null || typeof value !== "object") return;
  if (Array.isArray(value)) {
    for (const item of value) collectSensitiveJsonValues(item, values);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    if (isSensitiveKey(key)) collectStringLeaves(item, values);
    else collectSensitiveJsonValues(item, values);
  }
}

function collectUrlSecretValues(value: string | null | undefined, values: Set<string>): void {
  if (!value) return;
  try {
    const url = new URL(value);
    if (url.username) values.add(url.username);
    if (url.password) values.add(url.password);
    for (const [key, item] of url.searchParams) {
      if (isSensitiveKey(key) && item.length > 0) values.add(item);
    }
  } catch {
    // URL validation belongs to the caller. A malformed value contributes no
    // additional exact secrets here and is still handled by normal redaction.
  }
}

/**
 * Collect exact credential material owned by a provider profile. These values
 * remain protected even when heuristic evidence redaction is disabled.
 */
export function providerSecretValues(profile: ProviderSecretSource): string[] {
  const values = new Set<string>();
  if (profile.credential) values.add(profile.credential);
  for (const value of Object.values(profile.headers ?? {})) {
    if (value.length > 0) values.add(value);
  }
  collectUrlSecretValues(profile.baseUrl, values);
  collectUrlSecretValues(profile.endpointOverride, values);
  if (profile.extraBody) collectSensitiveJsonValues(profile.extraBody, values);
  return [...values];
}

function redactKnownSecrets(
  value: string,
  secrets: readonly string[],
  redactSensitivePatterns: boolean,
): string {
  const redacted = redactSensitivePatterns
    ? value.replace(AUTH_VALUE, (_match, scheme: string) => `${scheme} ${REDACTED}`)
    : value;
  return replaceKnownSecrets(redacted, secrets, REDACTED).value;
}

export function redactHeaders(
  headers: Headers | Readonly<Record<string, string>>,
  secrets: readonly string[] = [],
  redactSensitivePatterns = true,
): Record<string, string> {
  const entries = headers instanceof Headers ? [...headers.entries()] : Object.entries(headers);
  return Object.fromEntries(
    entries.map(([name, value]) => [
      name,
      redactSensitivePatterns && isSensitiveKey(name)
        ? REDACTED
        : redactKnownSecrets(value, secrets, redactSensitivePatterns),
    ]),
  );
}

export function redactJson(
  value: JsonValue,
  secrets: readonly string[] = [],
  redactSensitivePatterns = true,
): JsonValue {
  if (typeof value === "string") return redactKnownSecrets(value, secrets, redactSensitivePatterns);
  if (value === null || typeof value !== "object") return value;
  if (Array.isArray(value)) return value.map((item) => redactJson(item, secrets, redactSensitivePatterns));

  const redacted: JsonObject = {};
  for (const [key, item] of Object.entries(value)) {
    redacted[key] = redactSensitivePatterns && isSensitiveKey(key)
      ? REDACTED
      : redactJson(item, secrets, redactSensitivePatterns);
  }
  return redacted;
}

export function redactText(
  value: string,
  secrets: readonly string[] = [],
  redactSensitivePatterns = true,
): string {
  return redactKnownSecrets(value, secrets, redactSensitivePatterns);
}

export function redactUrl(
  value: string,
  secrets: readonly string[] = [],
  redactSensitivePatterns = true,
): string {
  try {
    const url = new URL(value);
    if (url.username) url.username = REDACTED;
    if (url.password) url.password = REDACTED;
    for (const key of [...url.searchParams.keys()]) {
      if (isSensitiveKey(key)) url.searchParams.set(key, REDACTED);
    }
    return redactKnownSecrets(url.toString(), secrets, redactSensitivePatterns);
  } catch {
    return redactKnownSecrets(value, secrets, redactSensitivePatterns);
  }
}
