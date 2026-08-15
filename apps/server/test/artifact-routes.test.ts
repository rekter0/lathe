import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistence } from "@lathe/db";
import { emptyResolvedConfig, nowIso, sha256Json, uuidv7, type AssetRevision, type JsonObject } from "@lathe/domain";
import { importFindingArtifact, importHarnessArtifact } from "@lathe/artifacts";
import { createApp } from "../src/app.js";
import { EventHub } from "../src/events.js";
import { UnavailableRunCoordinator } from "../src/run-coordinator.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

function revision(kind: AssetRevision["kind"], name: string, value: JsonObject, trusted = true): AssetRevision {
  return {
    id: uuidv7(), assetId: uuidv7(), kind, revision: 1, name, description: "fixture", tags: [],
    provenance: { test: true }, value, contentHash: sha256Json(value), trusted, archivedAt: null, createdAt: nowIso()
  };
}

describe("artifact routes", () => {
  it("never exports target environment or legacy MCP URL/header credentials", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-asset-export-redaction-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    const token = "artifact-token";
    const app = createApp({ repository: persistence.repository, contentStore: persistence.contentStore, events: new EventHub(), runCoordinator: new UnavailableRunCoordinator(), apiToken: token, dataDirectory });
    const headers = { authorization: `Bearer ${token}` };
    try {
      const spec = revision("tool-spec", "remote_tool", { name: "remote_tool", description: "Remote", inputSchema: { type: "object" } });
      const target = revision("target", "Target", {
        id: "target", label: "Existing container", kind: "container", runtime: "docker", container: "fixture-container",
        environment: { NON_OBVIOUS_NAME: "target-environment-secret" }
      });
      const mcp = revision("mcp-server", "Legacy MCP", {
        id: "mcp", revision: "1", name: "Legacy MCP",
        transport: {
          kind: "streamableHttp",
          url: "https://url-user:url-password@example.test/mcp?token=query-secret&view=compact",
          headers: {
            Authorization: { kind: "literal", value: "inline-header-secret" },
            Accept: { kind: "literal", value: "application/json" },
            "X-Secondary": { kind: "secret", secretId: "symbolic-secret-id" }
          }
        }
      });
      for (const asset of [spec, target, mcp]) await persistence.repository.saveAssetRevision(asset);
      const harness = revision("harness", "Credential-safe export", {
        promptBindings: [],
        toolBindings: [
          { revisionId: spec.id, enabled: true, mode: "real", implementationRevisionId: null, targetId: target.id, mcpServerId: null },
          { revisionId: spec.id, enabled: true, mode: "mcp", implementationRevisionId: null, targetId: null, mcpServerId: mcp.id }
        ],
        protocolOverrides: {}
      });
      await persistence.repository.saveAssetRevision(harness);

      const response = await app.request(`/api/harnesses/${harness.id}/export`, { headers });
      expect(response.status).toBe(200);
      const archive = await response.arrayBuffer();
      const imported = importHarnessArtifact(new Uint8Array(archive));
      const serialized = imported.files.map((file) => new TextDecoder().decode(file.data)).join("\n");
      for (const secret of ["target-environment-secret", "url-user", "url-password", "query-secret", "inline-header-secret"]) {
        expect(serialized).not.toContain(secret);
      }
      expect(serialized).toContain("NON_OBVIOUS_NAME");
      expect(serialized).toContain("fixture-container");
      expect(serialized).toContain("application/json");
      expect(serialized).toContain("symbolic-secret-id");

      const form = new FormData();
      form.set("file", new File([archive], "credential-safe.lathe-harness", { type: "application/zip" }));
      const importedResponse = await app.request("/api/artifacts/import", { method: "POST", headers, body: form });
      expect(importedResponse.status).toBe(201);
      expect(await importedResponse.text()).not.toContain("target-environment-secret");
    } finally {
      await persistence.repository.close();
    }
  });

  it("round-trips a harness with rewritten prompt/tool references and disabled scripts", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-artifact-route-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    const token = "artifact-token";
    const app = createApp({ repository: persistence.repository, contentStore: persistence.contentStore, events: new EventHub(), runCoordinator: new UnavailableRunCoordinator(), apiToken: token, dataDirectory });
    const headers = { authorization: `Bearer ${token}` };
    try {
      const prompt = revision("prompt", "Prompt", { content: "You are a test harness." });
      const spec = revision("tool-spec", "echo", { name: "echo", description: "Echo", inputSchema: { type: "object" } });
      const implementation = revision("tool-implementation", "echo handler", { source: "function build(){ return { program: '/bin/echo', args: [] }; } function formatResult(x){ return x; }" });
      await persistence.repository.saveAssetRevision(prompt);
      await persistence.repository.saveAssetRevision(spec);
      await persistence.repository.saveAssetRevision(implementation);
      const harnessValue: JsonObject = {
        promptBindings: [{ revisionId: prompt.id, enabled: true }],
        toolBindings: [{ revisionId: spec.id, enabled: true, mode: "real", implementationRevisionId: implementation.id, targetId: null, mcpServerId: null }],
        protocolOverrides: {}
      };
      const harness = revision("harness", "Round trip", harnessValue);
      await persistence.repository.saveAssetRevision(harness);

      const exported = await app.request(`/api/harnesses/${harness.id}/export`, { headers });
      expect(exported.status).toBe(200);
      const form = new FormData();
      form.set("file", new File([await exported.arrayBuffer()], "round-trip.lathe-harness", { type: "application/zip" }));
      const importedResponse = await app.request("/api/artifacts/import", { method: "POST", headers, body: form });
      expect(importedResponse.status).toBe(201);
      const body = await importedResponse.json() as { importedAsset: AssetRevision; importedReferences: AssetRevision[]; scriptsEnabled: boolean };
      expect(body.scriptsEnabled).toBe(false);
      expect(body.importedReferences).toHaveLength(3);
      expect(body.importedReferences.every((item) => item.trusted === false)).toBe(true);
      const importedIds = new Set(body.importedReferences.map((item) => item.id));
      const value = body.importedAsset.value as JsonObject;
      const promptBinding = (value.promptBindings as JsonObject[])[0]!;
      const toolBinding = (value.toolBindings as JsonObject[])[0]!;
      expect(importedIds.has(String(promptBinding.revisionId))).toBe(true);
      expect(importedIds.has(String(toolBinding.revisionId))).toBe(true);
      expect(importedIds.has(String(toolBinding.implementationRevisionId))).toBe(true);
      expect([prompt.id, spec.id, implementation.id]).not.toContain(promptBinding.revisionId);
    } finally {
      await persistence.repository.close();
    }
  });

  it("redacts historical provider credentials from textual evidence traces", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-finding-redaction-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    const token = "artifact-token";
    const app = createApp({ repository: persistence.repository, contentStore: persistence.contentStore, events: new EventHub(), runCoordinator: new UnavailableRunCoordinator(), apiToken: token, dataDirectory });
    const headers = { authorization: `Bearer ${token}` };
    try {
      const project = await persistence.repository.createProject({ name: "Historical trace" });
      const oldProvider = await persistence.repository.createProviderProfile({
        label: "Rotating gateway",
        protocol: "openai-chat",
        baseUrl: "https://gateway.example/v1",
        credential: "archived-provider-secret",
        models: [{
          id: "fixture", label: "Fixture", discovered: false,
          capabilities: { streaming: true, tools: true, images: false, files: false, jsonMode: false, maxContextTokens: null }
        }]
      });
      await persistence.repository.createProviderRevision(oldProvider.id, { credential: "replacement-provider-secret" });
      const { session, branch } = await persistence.repository.createSession({ projectId: project.id, name: "Session" });
      const user = await persistence.repository.appendNode({ sessionId: session.id, branchId: branch.id, parentId: null, role: "user", parts: [{ type: "text", text: "test" }] });
      const snapshot = await persistence.repository.createConfigSnapshot(session.id, emptyResolvedConfig());
      const run = await persistence.repository.createRun({ sessionId: session.id, branchId: branch.id, contextNodeId: user.id, configSnapshotId: snapshot.id });
      const assistant = await persistence.repository.appendNode({ sessionId: session.id, branchId: branch.id, parentId: user.id, role: "assistant", parts: [{ type: "text", text: "observed" }], sourceRunId: run.id, configSnapshotId: snapshot.id });
      const trace = await persistence.contentStore.put(new TextEncoder().encode('{"authorization":"archived-provider-secret"}\n'));
      await persistence.repository.updateRun(run.id, { status: "completed", resultNodeId: assistant.id, traceHash: trace.sha256, finishedAt: nowIso() });
      const finding = await persistence.repository.createFinding({
        projectId: project.id, sessionId: session.id, branchId: branch.id, nodeId: assistant.id,
        title: "Credential evidence", severity: "high", summary: "summary", expected: "safe", observed: "leak", tags: []
      });

      const response = await app.request(`/api/findings/${finding.id}/export?projectId=${project.id}`, { headers });
      expect(response.status).toBe(200);
      const imported = importFindingArtifact(new Uint8Array(await response.arrayBuffer()));
      const evidence = imported.files.find((file) => file.path.endsWith(`${trace.sha256}.ndjson`));
      expect(evidence?.mediaType).toBe("application/x-ndjson");
      const text = new TextDecoder().decode(evidence!.data);
      expect(text).not.toContain("archived-provider-secret");
      expect(text).toContain("REDACTED");
    } finally {
      await persistence.repository.close();
    }
  });

  it("restores finding snapshots, run links, annotations, usage, and inspectable evidence without trusting scripts", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-finding-round-trip-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    const token = "artifact-token";
    const app = createApp({ repository: persistence.repository, contentStore: persistence.contentStore, events: new EventHub(), runCoordinator: new UnavailableRunCoordinator(), apiToken: token, dataDirectory });
    const headers = { authorization: `Bearer ${token}` };
    try {
      const project = await persistence.repository.createProject({ name: "Reproducible finding" });
      await persistence.repository.createProviderProfile({
        label: "Evidence provider",
        protocol: "openai-chat",
        baseUrl: "https://example.test/v1",
        credential: "round-trip-provider-secret",
        models: []
      });
      const prompt = revision("prompt", "Evidence prompt", { content: "Keep all evidence." });
      const spec = revision("tool-spec", "evidence_tool", { name: "evidence_tool", description: "Collect evidence", inputSchema: { type: "object" } });
      const implementation = revision("tool-implementation", "Untrusted evidence handler", {
        source: "globalThis.__latheImportedScriptExecuted = true; function build(){ throw new Error('must stay inert'); } function formatResult(x){ return x; }"
      });
      await persistence.repository.saveAssetRevision(prompt);
      await persistence.repository.saveAssetRevision(spec);
      await persistence.repository.saveAssetRevision(implementation);
      const { session, branch } = await persistence.repository.createSession({ projectId: project.id, name: "Original" });
      const user = await persistence.repository.appendNode({ sessionId: session.id, branchId: branch.id, parentId: null, role: "user", parts: [{ type: "text", text: "attempt" }] });
      const config = emptyResolvedConfig();
      config.promptBlocks = [{ revisionId: prompt.id, name: prompt.name, content: "Keep all evidence.", enabled: true, order: 0 }];
      config.tools = [{
        toolRevisionId: spec.id,
        implementationRevisionId: implementation.id,
        name: "evidence_tool",
        description: "Collect evidence",
        inputSchema: { type: "object" },
        enabled: true,
        mode: "real",
        targetId: null,
        mcpServerId: null
      }];
      config.temperature = 0.25;
      const snapshot = await persistence.repository.createConfigSnapshot(session.id, config);
      const run = await persistence.repository.createRun({ sessionId: session.id, branchId: branch.id, contextNodeId: user.id, configSnapshotId: snapshot.id });
      const assistant = await persistence.repository.appendNode({
        sessionId: session.id,
        branchId: branch.id,
        parentId: user.id,
        role: "assistant",
        parts: [{ type: "text", text: "blocked" }],
        sourceRunId: run.id,
        configSnapshotId: snapshot.id
      });
      const providerTrace = await persistence.contentStore.put(new TextEncoder().encode('{"authorization":"round-trip-provider-secret","event":"blocked"}\n'));
      const rawResult = await persistence.contentStore.put(new TextEncoder().encode('{"token":"round-trip-provider-secret","exitCode":7}'));
      await persistence.repository.updateRun(run.id, {
        resultNodeId: assistant.id,
        status: "failed",
        classification: "content-policy",
        operatorLabel: "confirmed jailbreak defense",
        operatorNotes: "Retain this operator assessment.",
        normalizedOutput: { text: "blocked", rawResultHash: rawResult.sha256 },
        usage: { inputTokens: 23, outputTokens: 4 },
        traceHash: providerTrace.sha256,
        startedAt: "2026-08-15T08:00:00.000Z",
        finishedAt: "2026-08-15T08:00:01.000Z"
      });
      const finding = await persistence.repository.createFinding({
        projectId: project.id,
        sessionId: session.id,
        branchId: branch.id,
        nodeId: assistant.id,
        title: "Round-trip evidence",
        severity: "high",
        summary: "summary",
        expected: "blocked",
        observed: "blocked with evidence",
        tags: ["round-trip"]
      });

      const exported = await app.request(`/api/findings/${finding.id}/export?projectId=${project.id}`, { headers });
      expect(exported.status).toBe(200);
      const form = new FormData();
      form.set("file", new File([await exported.arrayBuffer()], "round-trip.lathe-finding", { type: "application/zip" }));
      const importedResponse = await app.request("/api/artifacts/import", { method: "POST", headers, body: form });
      expect(importedResponse.status).toBe(201);
      const body = await importedResponse.json() as {
        session: { id: string };
        importedEvidenceAssets: AssetRevision[];
        importedSnapshots: Array<{ id: string }>;
        importedRuns: Array<{ id: string }>;
        scriptsEnabled: boolean;
      };
      expect(body.scriptsEnabled).toBe(false);
      expect(body.importedEvidenceAssets).toHaveLength(3);
      expect(body.importedEvidenceAssets.every((asset) => asset.trusted === false)).toBe(true);
      expect((globalThis as Record<string, unknown>).__latheImportedScriptExecuted).toBeUndefined();

      const [importedRun] = await persistence.repository.listRuns(body.session.id);
      expect(importedRun).toMatchObject({
        status: "failed",
        classification: "content-policy",
        operatorLabel: "confirmed jailbreak defense",
        operatorNotes: "Retain this operator assessment.",
        usage: { inputTokens: 23, outputTokens: 4 },
        startedAt: "2026-08-15T08:00:00.000Z",
        finishedAt: "2026-08-15T08:00:01.000Z"
      });
      expect(importedRun!.id).toBe(body.importedRuns[0]!.id);
      expect(importedRun!.traceHash).toMatch(/^[a-f0-9]{64}$/);
      expect(importedRun!.traceHash).not.toBe(providerTrace.sha256);
      const normalized = importedRun!.normalizedOutput as JsonObject;
      expect(normalized.rawResultHash).toMatch(/^[a-f0-9]{64}$/);
      expect(normalized.rawResultHash).not.toBe(rawResult.sha256);

      const snapshotResponse = await app.request(`/api/config-snapshots/${importedRun!.configSnapshotId}`, { headers });
      expect(snapshotResponse.status).toBe(200);
      const snapshotBody = await snapshotResponse.json() as { snapshot: { config: ReturnType<typeof emptyResolvedConfig> } };
      expect(snapshotBody.snapshot.config.temperature).toBe(0.25);
      const importedAssetIds = new Set(body.importedEvidenceAssets.map((asset) => asset.id));
      expect(importedAssetIds.has(snapshotBody.snapshot.config.promptBlocks[0]!.revisionId)).toBe(true);
      expect(importedAssetIds.has(snapshotBody.snapshot.config.tools[0]!.toolRevisionId)).toBe(true);
      expect(importedAssetIds.has(snapshotBody.snapshot.config.tools[0]!.implementationRevisionId!)).toBe(true);
      expect(snapshotBody.snapshot.config.promptBlocks[0]!.revisionId).not.toBe(prompt.id);

      const importedNodes = await persistence.repository.listNodes(body.session.id);
      expect(importedNodes[1]).toMatchObject({ sourceRunId: importedRun!.id, configSnapshotId: importedRun!.configSnapshotId });
      expect(importedRun!.contextNodeId).toBe(importedNodes[0]!.id);
      expect(importedRun!.resultNodeId).toBe(importedNodes[1]!.id);

      const traceResponse = await app.request(`/api/traces/${importedRun!.traceHash}`, { headers });
      expect(traceResponse.status).toBe(200);
      const traceText = await traceResponse.text();
      expect(traceText).toContain("blocked");
      expect(traceText).toContain("REDACTED");
      expect(traceText).not.toContain("round-trip-provider-secret");
      const rawResponse = await app.request(`/api/traces/${String(normalized.rawResultHash)}`, { headers });
      expect(rawResponse.status).toBe(200);
      const rawText = await rawResponse.text();
      expect(rawText).toContain("exitCode");
      expect(rawText).toContain("REDACTED");
      expect(rawText).not.toContain("round-trip-provider-secret");
    } finally {
      await persistence.repository.close();
    }
  });
});
