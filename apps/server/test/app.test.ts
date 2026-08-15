import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistence } from "@lathe/db";
import { emptyResolvedConfig, nowIso, sha256Json, uuidv7, type AssetRevision, type JsonObject } from "@lathe/domain";
import { createApp } from "../src/app.js";
import { EventHub } from "../src/events.js";
import { UnavailableRunCoordinator } from "../src/run-coordinator.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("Lathe API", () => {
  it("redacts credential-bearing asset fields and rejects new inline MCP URL credentials", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-api-asset-secrets-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    const token = "test-token";
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const app = createApp({
      repository: persistence.repository,
      contentStore: persistence.contentStore,
      events: new EventHub(),
      runCoordinator: new UnavailableRunCoordinator(),
      apiToken: token,
      dataDirectory
    });
    try {
      const targetValue: JsonObject = {
        id: "target-with-environment",
        label: "Container target",
        kind: "container",
        runtime: "docker",
        container: "lathe-fixture",
        environment: { VISIBLE_NAME: "target-environment-secret" }
      };
      const target: AssetRevision = {
        id: uuidv7(), assetId: uuidv7(), kind: "target", revision: 1,
        name: "Target", description: "Legacy target", tags: [], provenance: { imported: true },
        value: targetValue, contentHash: sha256Json(targetValue), trusted: false,
        archivedAt: null, createdAt: nowIso()
      };
      await persistence.repository.saveAssetRevision(target);

      const mcpValue: JsonObject = {
        id: "legacy-mcp",
        revision: "1",
        name: "Legacy MCP",
        transport: {
          kind: "streamableHttp",
          url: "https://url-user:url-password@example.test/mcp?token=query-secret&view=compact",
          headers: {
            Authorization: { kind: "literal", value: "inline-header-secret" },
            Accept: { kind: "literal", value: "application/json" }
          }
        }
      };
      const mcp: AssetRevision = {
        id: uuidv7(), assetId: uuidv7(), kind: "mcp-server", revision: 1,
        name: "MCP", description: "Legacy MCP", tags: [], provenance: { imported: true },
        value: mcpValue, contentHash: sha256Json(mcpValue), trusted: false,
        archivedAt: null, createdAt: nowIso()
      };
      await persistence.repository.saveAssetRevision(mcp);

      for (const path of ["/api/assets", "/api/mcp/profiles"]) {
        const response = await app.request(path, { headers });
        expect(response.status).toBe(200);
        const text = await response.text();
        for (const secret of ["target-environment-secret", "url-user", "url-password", "query-secret", "inline-header-secret"]) {
          expect(text).not.toContain(secret);
        }
        expect(text).toContain("application/json");
        if (path === "/api/assets") expect(text).toContain("VISIBLE_NAME");
      }

      const rejected = await app.request("/api/library/assets", {
        method: "POST",
        headers,
        body: JSON.stringify({
          kind: "mcp-server", name: "Unsafe", trusted: true,
          value: { id: "unsafe", revision: "1", name: "Unsafe", transport: { kind: "streamableHttp", url: "https://user:password@example.test/mcp" } }
        })
      });
      expect(rejected.status).toBe(400);
      expect(await rejected.text()).toContain("embedded credentials");

      const listedTargets = await app.request("/api/assets?kind=target", { headers });
      const publicTarget = (await listedTargets.json() as { assets: AssetRevision[] }).assets[0]!;
      const trusted = await app.request("/api/library/assets", {
        method: "POST",
        headers,
        body: JSON.stringify({
          assetId: publicTarget.assetId,
          kind: "target",
          name: publicTarget.name,
          description: publicTarget.description,
          tags: publicTarget.tags,
          provenance: { ...publicTarget.provenance, trustedFromRevisionId: publicTarget.id },
          value: publicTarget.value,
          trusted: true
        })
      });
      expect(trusted.status).toBe(201);
      expect(await trusted.text()).not.toContain("target-environment-secret");
      const revisions = (await persistence.repository.listAssetRevisions("target")).filter((item) => item.assetId === target.assetId);
      expect(revisions.find((item) => item.revision === 2)?.value).toMatchObject({ environment: { VISIBLE_NAME: "target-environment-secret" } });
    } finally {
      await persistence.repository.close();
    }
  });

  it("does not launch untrusted MCP server or execution-target revisions", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-api-mcp-trust-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    const token = "test-token";
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const app = createApp({
      repository: persistence.repository,
      contentStore: persistence.contentStore,
      events: new EventHub(),
      runCoordinator: new UnavailableRunCoordinator(),
      apiToken: token,
      dataDirectory
    });
    try {
      const untrustedProfileValue: JsonObject = {
        id: "untrusted-profile",
        revision: "1",
        name: "Untrusted stdio",
        transport: { kind: "stdio", command: "/path/that/must/not/run" }
      };
      const untrustedProfile: AssetRevision = {
        id: uuidv7(), assetId: uuidv7(), kind: "mcp-server", revision: 1,
        name: "Untrusted stdio", description: "Imported", tags: [], provenance: { imported: true },
        value: untrustedProfileValue, contentHash: sha256Json(untrustedProfileValue), trusted: false,
        archivedAt: null, createdAt: nowIso()
      };
      await persistence.repository.saveAssetRevision(untrustedProfile);
      const profileResponse = await app.request(`/api/mcp/${untrustedProfile.id}/capabilities`, { method: "POST", headers, body: "{}" });
      expect(profileResponse.status).toBe(409);
      expect(await profileResponse.text()).toContain("disabled until");

      const targetValue: JsonObject = { id: "untrusted-target", label: "Imported target", kind: "host", inheritEnvironment: false };
      const target: AssetRevision = {
        id: uuidv7(), assetId: uuidv7(), kind: "target", revision: 1,
        name: "Untrusted target", description: "Imported", tags: [], provenance: { imported: true },
        value: targetValue, contentHash: sha256Json(targetValue), trusted: false,
        archivedAt: null, createdAt: nowIso()
      };
      await persistence.repository.saveAssetRevision(target);
      const trustedProfileValue: JsonObject = {
        id: "trusted-profile",
        revision: "1",
        name: "Trusted profile with disabled target",
        transport: { kind: "stdio", command: "/path/that/must/not/run", executionTargetId: target.id }
      };
      const trustedProfile: AssetRevision = {
        id: uuidv7(), assetId: uuidv7(), kind: "mcp-server", revision: 1,
        name: "Trusted profile", description: "Operator trusted", tags: [], provenance: { operatorAuthored: true },
        value: trustedProfileValue, contentHash: sha256Json(trustedProfileValue), trusted: true,
        archivedAt: null, createdAt: nowIso()
      };
      await persistence.repository.saveAssetRevision(trustedProfile);
      const targetResponse = await app.request(`/api/mcp/${trustedProfile.id}/capabilities`, { method: "POST", headers, body: "{}" });
      expect(targetResponse.status).toBe(409);
      expect(await targetResponse.text()).toContain("execution target");
    } finally {
      await persistence.repository.close();
    }
  });

  it("requires the launch token and persists project/session state", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-api-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    const token = "test-token";
    const app = createApp({
      repository: persistence.repository,
      contentStore: persistence.contentStore,
      events: new EventHub(),
      runCoordinator: new UnavailableRunCoordinator(),
      apiToken: token,
      dataDirectory
    });
    try {
      expect((await app.request("/api/projects")).status).toBe(401);
      const projectResponse = await app.request("/api/projects", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ name: "Project" })
      });
      expect(projectResponse.status).toBe(201);
      const project = (await projectResponse.json() as { project: { id: string } }).project;
      const sessionResponse = await app.request("/api/sessions", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ projectId: project.id, name: "Session" })
      });
      expect(sessionResponse.status).toBe(201);
    } finally {
      await persistence.repository.close();
    }
  });

  it("discovers models without exposing credentials and supports immutable provider revisions and annotations", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-api-features-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    const token = "test-token";
    let observedAuthorization = "";
    const app = createApp({
      repository: persistence.repository,
      contentStore: persistence.contentStore,
      events: new EventHub(),
      runCoordinator: new UnavailableRunCoordinator(),
      apiToken: token,
      dataDirectory,
      providerFetch: async (_input, init) => {
        observedAuthorization = new Headers(init?.headers).get("authorization") ?? "";
        return Response.json({ data: [{ id: "fixture-model", owned_by: "fixture" }] });
      }
    });
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    try {
      const provider = await persistence.repository.createProviderProfile({
        label: "Fixture", protocol: "openai-chat", baseUrl: "https://fixture.invalid/v1?token=url-secret", endpointOverride: "https://fixture.invalid/chat?api_key=endpoint-secret", credential: "provider-secret",
        headers: { "x-private-header": "header-secret" },
        extraBody: { api_key: "body-secret", neutral: "prefix-header-secret-suffix" }
      });
      const providerList = await app.request("/api/providers", { headers });
      const providerListText = await providerList.text();
      expect(providerListText).not.toContain("provider-secret");
      expect(providerListText).not.toContain("header-secret");
      expect(providerListText).not.toContain("body-secret");
      expect(providerListText).not.toContain("url-secret");
      expect(providerListText).not.toContain("endpoint-secret");
      const discovery = await app.request(`/api/providers/${provider.id}/discover`, { method: "POST", headers });
      expect(discovery.status).toBe(200);
      const discoveryBody = await discovery.json();
      expect(discoveryBody).toMatchObject({ models: [{ id: "fixture-model", source: "discovered" }] });
      expect(observedAuthorization).toBe("Bearer provider-secret");
      expect(JSON.stringify(discoveryBody)).not.toContain("provider-secret");

      const revisionResponse = await app.request(`/api/providers/${provider.id}/revisions`, {
        method: "POST", headers, body: JSON.stringify({ label: "Fixture r2" })
      });
      expect(revisionResponse.status).toBe(201);
      const revisionBody = await revisionResponse.json() as { provider: { id: string; revision: number; hasCredential: boolean; credential?: string } };
      expect(revisionBody.provider).toMatchObject({ revision: 2, hasCredential: true });
      expect(revisionBody.provider.id).not.toBe(provider.id);
      expect(revisionBody.provider).not.toHaveProperty("credential");
      expect((await persistence.repository.listProviderProfiles()).map((item) => item.id)).toEqual([revisionBody.provider.id]);
      expect((await persistence.repository.getProviderProfile(provider.id))?.archivedAt).not.toBeNull();
      expect((await app.request(`/api/providers/${provider.id}/revisions`, {
        method: "POST", headers, body: JSON.stringify({ label: "Invalid fork" })
      })).status).toBe(404);

      const project = await persistence.repository.createProject({ name: "Project" });
      const { session, branch } = await persistence.repository.createSession({ projectId: project.id, name: "Session" });
      const continuation = await app.request(`/api/sessions/${session.id}/continuation`, {
        method: "PATCH", headers, body: JSON.stringify({ enabled: true, limit: 4 })
      });
      expect(await continuation.json()).toMatchObject({ session: { autoContinueTools: true, autoContinueLimit: 4 } });
      const snapshot = await persistence.repository.createConfigSnapshot(session.id, emptyResolvedConfig());
      const run = await persistence.repository.createRun({ sessionId: session.id, branchId: branch.id, contextNodeId: null, configSnapshotId: snapshot.id });
      const annotation = await app.request(`/api/runs/${run.id}/annotation`, {
        method: "PATCH", headers, body: JSON.stringify({ operatorLabel: "policy-bypass", operatorNotes: "Reproduced manually" })
      });
      expect(await annotation.json()).toMatchObject({ run: { classification: null, operatorLabel: "policy-bypass", operatorNotes: "Reproduced manually" } });

      let capturedConfig: unknown;
      const runApp = createApp({
        repository: persistence.repository,
        contentStore: persistence.contentStore,
        events: new EventHub(),
        runCoordinator: {
          start: async (input) => { capturedConfig = input.configOverride; return { id: "captured", status: "queued" }; },
          cancel: async () => false,
          resolveToolCall: async () => undefined,
          resolveMcpApproval: async () => undefined
        },
        apiToken: token,
        dataDirectory
      });
      const config = emptyResolvedConfig();
      expect((await runApp.request("/api/runs", {
        method: "POST", headers, body: JSON.stringify({ sessionId: session.id, branchId: branch.id, config })
      })).status).toBe(202);
      expect(capturedConfig).toEqual(config);
      expect((await runApp.request(`/api/sessions/${session.id}/config`, {
        method: "PATCH", headers, body: JSON.stringify({ config: { ...config, temperature: -1 } })
      })).status).toBe(400);

      const invalidProvider = await app.request("/api/providers", {
        method: "POST", headers, body: JSON.stringify({ label: "Bad", protocol: "openai-chat", baseUrl: "file:///tmp/socket", headers: { "x-test": "ok\r\ninjected: yes" } })
      });
      expect(invalidProvider.status).toBe(400);
    } finally {
      await persistence.repository.close();
    }
  });
});
