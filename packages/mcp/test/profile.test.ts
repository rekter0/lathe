import { describe, expect, it } from "vitest";
import { McpProfileError, publicMcpProfile, redactJson, resolveMcpTransport } from "../src/index.js";
import type { McpServerProfile } from "../src/index.js";

describe("MCP profiles", () => {
  it("resolves static bearer authentication without putting values in the profile", async () => {
    const profile: McpServerProfile = {
      id: "server-1",
      revision: "rev-1",
      name: "Remote server",
      transport: {
        kind: "streamableHttp",
        url: "https://example.test/mcp",
        headers: {
          Authorization: { kind: "secret", secretId: "token", prefix: "Bearer " },
          "X-Lathe": { kind: "literal", value: "manual" },
        },
      },
    };

    const resolved = await resolveMcpTransport(profile, async (id) =>
      id === "token" ? "top-secret" : undefined,
    );
    expect(resolved.kind).toBe("streamableHttp");
    if (resolved.kind !== "streamableHttp") return;
    expect(resolved.headers.Authorization).toBe("Bearer top-secret");
    expect(JSON.stringify(profile)).not.toContain("top-secret");
    expect(redactJson({ headers: resolved.headers }, resolved.secretValues)).toEqual({
      headers: { Authorization: "[REDACTED]", "X-Lathe": "manual" },
    });
  });

  it("can preserve sensitive-looking test content without exposing resolved secrets", () => {
    expect(redactJson({
      password: "test-only-password",
      text: "Bearer fake-red-team-token",
      shortEvidence: "example text",
      echoedCredential: "x"
    }, ["x"], false)).toEqual({
      password: "test-only-password",
      text: "Bearer fake-red-team-token",
      shortEvidence: "example text",
      echoedCredential: "[REDACTED]"
    });
  });

  it("protects a short secret together with its configured prefix and suffix", async () => {
    const profile: McpServerProfile = {
      id: "short-secret-server",
      revision: "rev-1",
      name: "Short secret fixture",
      transport: {
        kind: "streamableHttp",
        url: "https://example.test/mcp",
        headers: {
          "X-Custom-Auth": { kind: "secret", secretId: "short", prefix: "sk-", suffix: "-end" },
        },
      },
    };
    const resolved = await resolveMcpTransport(profile, async () => "x");
    expect(resolved.kind).toBe("streamableHttp");
    if (resolved.kind !== "streamableHttp") return;
    expect(resolved.headers["X-Custom-Auth"]).toBe("sk-x-end");
    expect(resolved.secretValues).toEqual(expect.arrayContaining(["x", "sk-x-end"]));
    expect(redactJson({ text: "example text; credential=sk-x-end" }, resolved.secretValues, false)).toEqual({
      text: "example text; credential=[REDACTED]",
    });
  });

  it("heuristically redacts credential-shaped text only in strict mode", () => {
    const evidence = {
      note: "Observed Bearer fake-red-team-token and Basic ZmFrZTpwYXNz",
      password: "test-only-password",
      auth: "test-only-auth",
      credential: "test-only-credential",
      sessionToken: "test-only-token",
      inputTokens: 42,
      echoedCredential: "stored-secret-value"
    };

    expect(redactJson(evidence, ["stored-secret-value"], true)).toEqual({
      note: "Observed Bearer [REDACTED] and Basic [REDACTED]",
      password: "[REDACTED]",
      auth: "[REDACTED]",
      credential: "[REDACTED]",
      sessionToken: "[REDACTED]",
      inputTokens: 42,
      echoedCredential: "[REDACTED]"
    });
    expect(redactJson(evidence, ["stored-secret-value"], false)).toEqual({
      note: "Observed Bearer fake-red-team-token and Basic ZmFrZTpwYXNz",
      password: "test-only-password",
      auth: "test-only-auth",
      credential: "test-only-credential",
      sessionToken: "test-only-token",
      inputTokens: 42,
      echoedCredential: "[REDACTED]"
    });
  });

  it("rejects missing secrets and invalid header values", async () => {
    const missing: McpServerProfile = {
      id: "server-1",
      revision: "rev-1",
      name: "Remote server",
      transport: {
        kind: "streamableHttp",
        url: "https://example.test/mcp",
        headers: { Authorization: { kind: "secret", secretId: "missing" } },
      },
    };
    await expect(resolveMcpTransport(missing, async () => undefined)).rejects.toMatchObject({
      code: "secret_not_found",
    } satisfies Partial<McpProfileError>);

    const injected: McpServerProfile = {
      ...missing,
      transport: {
        kind: "streamableHttp",
        url: "https://example.test/mcp",
        headers: { "X-Test": { kind: "literal", value: "ok\r\nBad: value" } },
      },
    };
    await expect(resolveMcpTransport(injected, async () => undefined)).rejects.toMatchObject({
      code: "invalid_static_value",
    });
  });

  it("rejects inline URL credentials and sanitizes unsafe legacy profiles", async () => {
    const embedded: McpServerProfile = {
      id: "legacy-server",
      revision: "rev-1",
      name: "Legacy server",
      transport: {
        kind: "streamableHttp",
        url: "https://url-user:url-password@example.test/mcp?token=query-secret&view=compact",
        headers: {
          Authorization: { kind: "literal", value: "inline-header-secret" },
          Accept: { kind: "literal", value: "application/json" },
        },
      },
    };

    await expect(resolveMcpTransport(embedded, async () => undefined)).rejects.toMatchObject({
      code: "invalid_transport",
    });
    const publicProfile = publicMcpProfile(embedded);
    expect(JSON.stringify(publicProfile)).not.toContain("url-user");
    expect(JSON.stringify(publicProfile)).not.toContain("url-password");
    expect(JSON.stringify(publicProfile)).not.toContain("query-secret");
    expect(JSON.stringify(publicProfile)).not.toContain("inline-header-secret");
    expect(JSON.stringify(publicProfile)).toContain("application/json");

    const queryOnly: McpServerProfile = {
      ...embedded,
      transport: { kind: "streamableHttp", url: "https://example.test/mcp?api_key=query-secret" },
    };
    await expect(resolveMcpTransport(queryOnly, async () => undefined)).rejects.toMatchObject({
      code: "invalid_static_value",
    });
  });
});
