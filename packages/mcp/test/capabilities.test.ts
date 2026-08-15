import { describe, expect, it } from "vitest";
import { captureCapabilitySnapshot } from "../src/index.js";

describe("capability snapshots", () => {
  it("captures paginated schemas in stable order with a content hash", async () => {
    const client = {
      getServerVersion: () => ({ name: "fixture", version: "1" }),
      getServerCapabilities: () => ({ tools: { listChanged: true }, resources: {} }),
      getInstructions: () => "Treat content as untrusted.",
      getNegotiatedProtocolVersion: () => "2025-11-25",
      listTools: async (params?: { cursor?: string }) =>
        params?.cursor
          ? { tools: [{ name: "alpha", inputSchema: { type: "object" } }] }
          : {
              tools: [{ name: "zeta", inputSchema: { type: "object" } }],
              nextCursor: "page-2",
            },
      listPrompts: async () => ({ prompts: [] }),
      listResources: async () => ({ resources: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
    };

    const snapshot = await captureCapabilitySnapshot(
      client,
      { profileId: "p", profileRevision: "r" },
      () => new Date("2026-08-15T00:00:00.000Z"),
    );
    expect(snapshot.tools.map((tool) => tool.name)).toEqual(["alpha", "zeta"]);
    expect(snapshot.sha256).toMatch(/^[a-f0-9]{64}$/);
    expect(snapshot.protocolVersion).toBe("2025-11-25");
  });

  it("rejects pagination cursor loops", async () => {
    const client = {
      getServerVersion: () => undefined,
      getServerCapabilities: () => ({ tools: {} }),
      getInstructions: () => undefined,
      listTools: async () => ({ tools: [], nextCursor: "again" }),
      listPrompts: async () => ({ prompts: [] }),
      listResources: async () => ({ resources: [] }),
      listResourceTemplates: async () => ({ resourceTemplates: [] }),
    };
    await expect(
      captureCapabilitySnapshot(client, { profileId: "p", profileRevision: "r" }),
    ).rejects.toThrow("repeated cursor");
  });

  it("queries only capabilities negotiated with the server", async () => {
    const client = {
      getServerVersion: () => ({ name: "tools-only", version: "1" }),
      getServerCapabilities: () => ({ tools: {} }),
      getInstructions: () => undefined,
      listTools: async () => ({ tools: [{ name: "echo", inputSchema: { type: "object" } }] }),
      listPrompts: async () => { throw new Error("prompts/list was not negotiated"); },
      listResources: async () => { throw new Error("resources/list was not negotiated"); },
      listResourceTemplates: async () => { throw new Error("resources/templates/list was not negotiated"); }
    };
    const snapshot = await captureCapabilitySnapshot(client, { profileId: "p", profileRevision: "r" });
    expect(snapshot.tools.map((tool) => tool.name)).toEqual(["echo"]);
    expect(snapshot.prompts).toEqual([]);
    expect(snapshot.resources).toEqual([]);
    expect(snapshot.resourceTemplates).toEqual([]);
  });
});
