import { timingSafeEqual } from "node:crypto";
import type { MiddlewareHandler } from "hono";
import { redactJson, type AssetKind, type AssetRevision, type JsonObject, type JsonValue } from "@lathe/domain";

export const REDACTED_ASSET_VALUE = "<redacted>";

const ASSET_CREDENTIAL_NAME = /(?:authorization|proxy-authorization|api[-_]?key|token|password|passwd|cookie|private[-_]?key|client[-_]?secret|credential|secret|(?:^|[-_])auth(?:$|[-_]))/i;

function isJsonObject(value: JsonValue | undefined): value is JsonObject {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function sanitizedCredentialUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return value;
  }
  // Remove, rather than placeholder-substitute, credential URL components so
  // sanitized exported profiles remain valid and can be imported as disabled
  // revisions without reintroducing an inline credential location.
  if (url.username) url.username = "";
  if (url.password) url.password = "";
  for (const key of [...url.searchParams.keys()]) {
    if (ASSET_CREDENTIAL_NAME.test(key)) url.searchParams.delete(key);
  }
  return url.toString();
}

function sanitizeNamedStaticValues(value: JsonValue | undefined): JsonValue | undefined {
  if (!isJsonObject(value)) return value;
  return Object.fromEntries(Object.entries(value).flatMap(([name, entry]) => {
    if (!ASSET_CREDENTIAL_NAME.test(name)) return [[name, structuredClone(entry)]];
    if (isJsonObject(entry) && entry.kind === "secret" && typeof entry.secretId === "string") {
      // Secret identifiers and formatting affixes are symbolic configuration,
      // not resolved credential material.
      return [[name, structuredClone(entry)]];
    }
    // Dropping an unsafe legacy inline value keeps the public/exported profile
    // structurally valid; a redaction marker would itself be interpreted as an
    // inline credential when the disabled revision is reviewed or imported.
    return [];
  }));
}

/**
 * Return an API/export-safe immutable asset DTO. Execution-target environment
 * names remain visible for operator review, but values never leave the server.
 * MCP secret references remain symbolic while unsafe legacy inline credentials
 * are redacted.
 */
export function sanitizeAssetRevision<T extends AssetRevision>(asset: T): T {
  const safe = structuredClone(asset);
  if (!isJsonObject(safe.value)) return safe;

  if (safe.kind === "target") {
    const environment = safe.value.environment;
    if (isJsonObject(environment)) {
      safe.value.environment = Object.fromEntries(Object.keys(environment).map((name) => [name, REDACTED_ASSET_VALUE]));
    }
    return safe;
  }

  if (safe.kind !== "mcp-server" || !isJsonObject(safe.value.transport)) return safe;
  const transport = safe.value.transport;
  if (typeof transport.url === "string") transport.url = sanitizedCredentialUrl(transport.url);
  if (transport.headers !== undefined) transport.headers = sanitizeNamedStaticValues(transport.headers) ?? null;
  if (transport.env !== undefined) transport.env = sanitizeNamedStaticValues(transport.env) ?? null;
  return safe;
}

function credentialValuesFromUrl(value: string): string[] {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return [];
  }
  const values: string[] = [];
  for (const encoded of [url.username, url.password]) {
    if (!encoded) continue;
    try { values.push(decodeURIComponent(encoded)); } catch { values.push(encoded); }
  }
  for (const [name, entry] of url.searchParams) if (ASSET_CREDENTIAL_NAME.test(name) && entry) values.push(entry);
  return values;
}

/** Known inline values that must be scrubbed if they also occur in evidence. */
export function assetCredentialValues(asset: AssetRevision): string[] {
  if (!isJsonObject(asset.value)) return [];
  const values: string[] = [];
  if (asset.kind === "target" && isJsonObject(asset.value.environment)) {
    for (const value of Object.values(asset.value.environment)) if (typeof value === "string" && value) values.push(value);
  }
  if (asset.kind !== "mcp-server" || !isJsonObject(asset.value.transport)) return values;
  const transport = asset.value.transport;
  if (typeof transport.url === "string") values.push(...credentialValuesFromUrl(transport.url));
  for (const field of [transport.headers, transport.env]) {
    if (!isJsonObject(field)) continue;
    for (const [name, entry] of Object.entries(field)) {
      if (!ASSET_CREDENTIAL_NAME.test(name)) continue;
      if (typeof entry === "string" && entry) values.push(entry);
      else if (isJsonObject(entry) && entry.kind === "literal" && typeof entry.value === "string" && entry.value) values.push(entry.value);
    }
  }
  return values;
}

export class UnsafeAssetCredentialError extends Error {
  override readonly name = "UnsafeAssetCredentialError";
}

/** Reject new MCP profiles that would persist credentials outside secret refs. */
export function assertSafeAssetCredentials(kind: AssetKind, value: JsonValue): void {
  if (kind !== "mcp-server" || !isJsonObject(value) || !isJsonObject(value.transport)) return;
  const transport = value.transport;
  if (transport.kind === "streamableHttp" && typeof transport.url === "string") {
    let url: URL;
    try {
      url = new URL(transport.url);
    } catch {
      throw new UnsafeAssetCredentialError("MCP Streamable HTTP URL is invalid");
    }
    if (!["http:", "https:"].includes(url.protocol)) {
      throw new UnsafeAssetCredentialError("MCP Streamable HTTP URL must use http: or https:");
    }
    if (url.username || url.password) {
      throw new UnsafeAssetCredentialError("MCP URLs cannot contain embedded credentials; use a secret-backed header");
    }
    const sensitiveParameter = [...url.searchParams.keys()].find((name) => ASSET_CREDENTIAL_NAME.test(name));
    if (sensitiveParameter) {
      throw new UnsafeAssetCredentialError(`MCP URL query parameter '${sensitiveParameter}' may contain credentials; use a secret-backed header`);
    }
  }
  for (const [fieldName, field] of [["header", transport.headers], ["environment", transport.env]] as const) {
    if (!isJsonObject(field)) continue;
    for (const [name, entry] of Object.entries(field)) {
      if (!ASSET_CREDENTIAL_NAME.test(name)) continue;
      if (!isJsonObject(entry) || entry.kind !== "secret" || typeof entry.secretId !== "string" || !entry.secretId.trim()) {
        throw new UnsafeAssetCredentialError(`Credential ${fieldName} '${name}' must use a secret reference`);
      }
    }
  }
}

function equalToken(left: string, right: string): boolean {
  const leftBuffer = Buffer.from(left);
  const rightBuffer = Buffer.from(right);
  return leftBuffer.length === rightBuffer.length && timingSafeEqual(leftBuffer, rightBuffer);
}

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "").replace(/\.$/, "");
  if (normalized === "localhost" || normalized === "::1") return true;
  const octets = normalized.split(".");
  return octets.length === 4 && octets[0] === "127" && octets.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

function hostHeaderHostname(value: string): string | null {
  try {
    return new URL(`http://${value}`).hostname;
  } catch {
    return null;
  }
}

function rejection(context: Parameters<MiddlewareHandler>[0], code: string, message: string) {
  return context.json({ error: { code, message } }, 403);
}

export function localSecurity(token: string): MiddlewareHandler {
  return async (context, next) => {
    context.header("X-Content-Type-Options", "nosniff");
    context.header("Referrer-Policy", "no-referrer");
    context.header("Cross-Origin-Resource-Policy", "same-origin");
    context.header("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data: blob:; connect-src 'self'; object-src 'none'; base-uri 'none'; frame-ancestors 'none'");

    let requestUrl: URL;
    try {
      requestUrl = new URL(context.req.url);
    } catch {
      return rejection(context, "forbidden-host", "Lathe accepts requests only through a valid loopback URL.");
    }
    const hostHeader = context.req.header("host");
    const headerHostname = hostHeader ? hostHeaderHostname(hostHeader) : null;
    if (!isLoopbackHostname(requestUrl.hostname) || (hostHeader !== undefined && (!headerHostname || !isLoopbackHostname(headerHostname)))) {
      return rejection(context, "forbidden-host", "Lathe accepts requests only through a loopback host.");
    }

    if (!context.req.path.startsWith("/api/") || context.req.path === "/api/health") {
      await next();
      return;
    }

    const authorization = context.req.header("authorization") ?? "";
    const supplied = authorization.startsWith("Bearer ") ? authorization.slice(7) : "";
    if (!supplied || !equalToken(supplied, token)) {
      return context.json({ error: { code: "unauthorized", message: "Open Lathe using the tokenized URL printed by the server." } }, 401);
    }

    const origin = context.req.header("origin");
    if (origin) {
      let parsedOrigin: URL;
      try {
        parsedOrigin = new URL(origin);
      } catch {
        return rejection(context, "forbidden-origin", "Lathe requires a valid same-origin browser request.");
      }
      if (!isLoopbackHostname(parsedOrigin.hostname) || parsedOrigin.origin !== requestUrl.origin) {
        return rejection(context, "forbidden-origin", "Lathe accepts browser requests only from its exact origin.");
      }
    }

    const mutating = ["POST", "PUT", "PATCH", "DELETE"].includes(context.req.method.toUpperCase());
    const fetchSite = context.req.header("sec-fetch-site")?.toLowerCase();
    if (mutating && fetchSite && fetchSite !== "same-origin" && fetchSite !== "none") {
      return rejection(context, "forbidden-fetch-site", "Cross-site browser mutations are not accepted.");
    }
    await next();
  };
}

function redactKnownValues(value: JsonValue, secrets: string[]): JsonValue {
  if (typeof value === "string") return secrets.reduce((result, secret) => secret.length >= 4 ? result.split(secret).join("<redacted>") : result, value);
  if (Array.isArray(value)) return value.map((item) => redactKnownValues(item, secrets));
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, redactKnownValues(item, secrets)]));
  return value;
}

function redactProviderUrl(value: string | null, secrets: string[]): string | null {
  if (value === null) return null;
  let redacted = value;
  try {
    const url = new URL(value);
    if (url.username) url.username = "<redacted>";
    if (url.password) url.password = "<redacted>";
    for (const key of [...url.searchParams.keys()]) {
      if (/authorization|api[-_]?key|token|secret|password|credential|cookie/i.test(key)) url.searchParams.set(key, "<redacted>");
    }
    redacted = url.toString();
  } catch {
    // Persisted legacy profiles may contain invalid URLs; still scrub known values.
  }
  return redactKnownValues(redacted, secrets) as string;
}

export function sanitizeProvider<T extends { credential: string; headers: Record<string, string>; extraBody: JsonObject; baseUrl: string; endpointOverride: string | null }>(provider: T): Omit<T, "credential" | "headers" | "extraBody" | "baseUrl" | "endpointOverride"> & { hasCredential: boolean; headers: Record<string, string>; extraBody: JsonObject; baseUrl: string; endpointOverride: string | null } {
  const { credential, headers, extraBody, baseUrl, endpointOverride, ...safe } = provider;
  const secrets = [credential, ...Object.values(headers)].filter(Boolean);
  return {
    ...safe,
    headers: Object.fromEntries(Object.keys(headers).map((name) => [name, "<redacted>"])),
    extraBody: redactKnownValues(redactJson(extraBody), secrets) as JsonObject,
    baseUrl: redactProviderUrl(baseUrl, secrets)!,
    endpointOverride: redactProviderUrl(endpointOverride, secrets),
    hasCredential: credential.length > 0
  };
}

interface ProviderRevisionSecretFields {
  baseUrl?: string;
  endpointOverride?: string | null;
  headers?: Record<string, string>;
  extraBody?: JsonObject;
}

interface StoredProviderSecretFields {
  credential: string;
  baseUrl: string;
  endpointOverride: string | null;
  headers: Record<string, string>;
  extraBody: JsonObject;
}

function sameJson(left: JsonValue | undefined, right: JsonValue | undefined): boolean {
  return JSON.stringify(left) === JSON.stringify(right);
}

function restoreSanitizedJson(input: JsonValue, stored: JsonValue | undefined, sanitized: JsonValue | undefined): JsonValue {
  if (stored !== undefined && sanitized !== undefined && sameJson(input, sanitized)) return structuredClone(stored);
  if (Array.isArray(input)) {
    const storedItems = Array.isArray(stored) ? stored : [];
    const sanitizedItems = Array.isArray(sanitized) ? sanitized : [];
    return input.map((item, index) => restoreSanitizedJson(item, storedItems[index], sanitizedItems[index]));
  }
  if (isJsonObject(input)) {
    const storedObject = isJsonObject(stored) ? stored : {};
    const sanitizedObject = isJsonObject(sanitized) ? sanitized : {};
    return Object.fromEntries(Object.entries(input).map(([key, value]) => [
      key,
      restoreSanitizedJson(value, storedObject[key], sanitizedObject[key])
    ]));
  }
  return input;
}

function restoreSanitizedUrl(input: string | null, stored: string | null, sanitized: string | null): string | null {
  if (input === sanitized) return stored;
  if (input === null || stored === null || sanitized === null) return input;
  try {
    const inputUrl = new URL(input);
    const storedUrl = new URL(stored);
    const sanitizedUrl = new URL(sanitized);
    const occurrences = new Map<string, number>();
    const restoredEntries = [...inputUrl.searchParams].map(([name, value]) => {
      const index = occurrences.get(name) ?? 0;
      occurrences.set(name, index + 1);
      const sanitizedValue = sanitizedUrl.searchParams.getAll(name)[index];
      const storedValue = storedUrl.searchParams.getAll(name)[index];
      return [name, value === sanitizedValue && storedValue !== undefined ? storedValue : value] as const;
    });
    inputUrl.search = "";
    for (const [name, value] of restoredEntries) inputUrl.searchParams.append(name, value);
    return inputUrl.toString();
  } catch {
    return input;
  }
}

/** Restore values represented by API redaction markers before creating a revision. */
export function restoreProviderRevisionSecrets<T extends ProviderRevisionSecretFields>(input: T, stored: StoredProviderSecretFields): T {
  const sanitized = sanitizeProvider(stored);
  const restored = { ...input };
  if (input.baseUrl !== undefined) restored.baseUrl = restoreSanitizedUrl(input.baseUrl, stored.baseUrl, sanitized.baseUrl) ?? input.baseUrl;
  if (input.endpointOverride !== undefined) restored.endpointOverride = restoreSanitizedUrl(input.endpointOverride, stored.endpointOverride, sanitized.endpointOverride);
  if (input.headers !== undefined) {
    restored.headers = Object.fromEntries(Object.entries(input.headers).map(([name, value]) => [
      name,
      value === sanitized.headers[name] && stored.headers[name] !== undefined ? stored.headers[name] : value
    ]));
  }
  if (input.extraBody !== undefined) restored.extraBody = restoreSanitizedJson(input.extraBody, stored.extraBody, sanitized.extraBody) as JsonObject;
  return restored;
}
