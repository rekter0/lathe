import type {
  McpServerProfile,
  ResolvedMcpTransport,
  SecretResolver,
  StaticValue,
} from "./types.js";

const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const CREDENTIAL_NAME = /(?:authorization|api[-_]?key|token|password|passwd|cookie|private[-_]?key|client[-_]?secret|secret|(?:^|[-_])auth(?:$|[-_]))/i;

export class McpProfileError extends Error {
  readonly code:
    | "invalid_profile"
    | "invalid_transport"
    | "invalid_static_value"
    | "secret_not_found";

  constructor(code: McpProfileError["code"], message: string) {
    super(message);
    this.name = "McpProfileError";
    this.code = code;
  }
}

async function resolveStaticValue(
  input: StaticValue,
  resolveSecret: SecretResolver,
): Promise<{ value: string; secret?: string }> {
  if (input.kind === "literal") {
    if (input.value.includes("\0")) {
      throw new McpProfileError("invalid_static_value", "Static values cannot contain NUL bytes");
    }
    return { value: input.value };
  }

  if (!input.secretId.trim()) {
    throw new McpProfileError("invalid_static_value", "Secret references need an id");
  }
  const secret = await resolveSecret(input.secretId);
  if (secret === undefined) {
    throw new McpProfileError("secret_not_found", `Secret '${input.secretId}' was not found`);
  }
  if (secret.includes("\0")) {
    throw new McpProfileError("invalid_static_value", "Resolved secrets cannot contain NUL bytes");
  }
  return {
    value: `${input.prefix ?? ""}${secret}${input.suffix ?? ""}`,
    secret,
  };
}

export async function resolveMcpTransport(
  profile: McpServerProfile,
  resolveSecret: SecretResolver,
): Promise<ResolvedMcpTransport> {
  if (!profile.id.trim() || !profile.revision.trim() || !profile.name.trim()) {
    throw new McpProfileError(
      "invalid_profile",
      "MCP profiles require an id, revision, and name",
    );
  }

  if (profile.transport.kind === "stdio") {
    const { command, args = [], cwd, env = {} } = profile.transport;
    if (!command.trim() || command.includes("\0")) {
      throw new McpProfileError("invalid_transport", "stdio command is invalid");
    }
    if (args.some((argument) => argument.includes("\0")) || cwd?.includes("\0")) {
      throw new McpProfileError("invalid_transport", "stdio arguments and cwd cannot contain NUL bytes");
    }

    const resolvedEnv: Record<string, string> = {};
    const secretValues: string[] = [];
    for (const [name, staticValue] of Object.entries(env)) {
      if (!ENVIRONMENT_NAME.test(name)) {
        throw new McpProfileError("invalid_transport", `Invalid environment name '${name}'`);
      }
      if (CREDENTIAL_NAME.test(name) && staticValue.kind !== "secret") {
        throw new McpProfileError(
          "invalid_static_value",
          `Credential environment value '${name}' must use a secret reference`,
        );
      }
      const resolved = await resolveStaticValue(staticValue, resolveSecret);
      resolvedEnv[name] = resolved.value;
      if (resolved.secret) secretValues.push(resolved.secret, resolved.value);
    }

    return {
      kind: "stdio",
      command,
      args: [...args],
      ...(cwd === undefined ? {} : { cwd }),
      env: resolvedEnv,
      secretValues,
      ...(profile.transport.executionTargetId === undefined ? {} : { executionTargetId: profile.transport.executionTargetId }),
    };
  }

  let url: URL;
  try {
    url = new URL(profile.transport.url);
  } catch {
    throw new McpProfileError("invalid_transport", "Streamable HTTP URL is invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new McpProfileError(
      "invalid_transport",
      "Streamable HTTP profiles only support http: and https:",
    );
  }
  if (url.username || url.password) {
    throw new McpProfileError(
      "invalid_transport",
      "Streamable HTTP URLs cannot contain embedded credentials; use a secret-backed header",
    );
  }
  const sensitiveQueryName = [...url.searchParams.keys()].find((name) => CREDENTIAL_NAME.test(name));
  if (sensitiveQueryName !== undefined) {
    throw new McpProfileError(
      "invalid_static_value",
      `Credential query parameter '${sensitiveQueryName}' is not allowed; use a secret-backed header`,
    );
  }

  const headers: Record<string, string> = {};
  const secretValues: string[] = [];
  for (const [name, staticValue] of Object.entries(profile.transport.headers ?? {})) {
    if (!HEADER_NAME.test(name)) {
      throw new McpProfileError("invalid_transport", `Invalid HTTP header name '${name}'`);
    }
    if (CREDENTIAL_NAME.test(name) && staticValue.kind !== "secret") {
      throw new McpProfileError(
        "invalid_static_value",
        `Credential header '${name}' must use a secret reference`,
      );
    }
    const resolved = await resolveStaticValue(staticValue, resolveSecret);
    if (/\r|\n/.test(resolved.value)) {
      throw new McpProfileError("invalid_static_value", "HTTP header values cannot contain newlines");
    }
    headers[name] = resolved.value;
    if (resolved.secret) secretValues.push(resolved.secret, resolved.value);
  }

  return {
    kind: "streamableHttp",
    url,
    headers,
    secretValues,
  };
}

/**
 * Produce a defensive public clone for legacy profiles as well as current
 * secret-reference-only profiles. New profiles reject inline URL credentials,
 * but existing databases must remain safe to inspect before they are revised.
 */
export function publicMcpProfile(profile: McpServerProfile): McpServerProfile {
  const safe = structuredClone(profile);
  if (safe.transport.kind === "streamableHttp") {
    try {
      const url = new URL(safe.transport.url);
      if (url.username) url.username = "";
      if (url.password) url.password = "";
      for (const name of [...url.searchParams.keys()]) {
        if (CREDENTIAL_NAME.test(name)) url.searchParams.delete(name);
      }
      safe.transport.url = url.toString();
    } catch {
      // Invalid legacy profiles will be rejected on use. Avoid attempting to
      // interpret or rewrite an otherwise opaque non-URL value here.
    }
    for (const [name, value] of Object.entries(safe.transport.headers ?? {})) {
      if (CREDENTIAL_NAME.test(name) && value.kind === "literal") {
        delete safe.transport.headers![name];
      }
    }
  } else {
    for (const [name, value] of Object.entries(safe.transport.env ?? {})) {
      if (CREDENTIAL_NAME.test(name) && value.kind === "literal") {
        delete safe.transport.env![name];
      }
    }
  }
  return safe;
}
