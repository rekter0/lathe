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
