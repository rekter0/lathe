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

  it("round-trips accepted payload lineage, helper evidence, and untrusted generator libraries without leaking identity or credentials", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-payload-finding-round-trip-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    const token = "artifact-token";
    const app = createApp({ repository: persistence.repository, contentStore: persistence.contentStore, events: new EventHub(), runCoordinator: new UnavailableRunCoordinator(), apiToken: token, dataDirectory });
    const headers = { authorization: `Bearer ${token}` };
    try {
      const credential = "payload-generator-credential";
      const accountIdentifier = "operator-account@example.test";
      const project = await persistence.repository.createProject({ name: "Payload provenance finding" });
      const provider = await persistence.repository.createProviderProfile({
        label: "Helper provider",
        protocol: "openai-chat",
        baseUrl: "https://helper.example.test/v1",
        credential,
        headers: { "x-account-reference": accountIdentifier },
        models: [{
          id: "helper-model", label: "Helper model", discovered: false,
          capabilities: { streaming: true, tools: false, images: false, files: false, jsonMode: false, maxContextTokens: null }
        }]
      });
      const generatorProfile = revision("payload-generator-profile", "Helper profile", {
        backend: {
          kind: "http-provider",
          providerProfileRevisionId: provider.id,
          modelId: "helper-model",
          maxOutputTokens: 512,
          reasoning: true,
          temperatures: { low: 0.2, balanced: 0.7, high: 1 }
        }
      });
      const generatorInstruction = revision("payload-generator-instruction", "Generator instruction", {
        template: "Return only the authorized test payload."
      });
      const technique = revision("payload-technique", "Hierarchy technique", {
        instructions: "Exercise instruction hierarchy boundaries.", conflictsWith: [], before: [], after: []
      });
      const pipeline = revision("payload-pipeline", "Encoding pipeline", {
        steps: [{ transformId: "base64-encode", version: 1, enabled: true }]
      });
      for (const asset of [generatorProfile, generatorInstruction, technique, pipeline]) {
        await persistence.repository.saveAssetRevision(asset);
      }
      const { session, branch } = await persistence.repository.createSession({ projectId: project.id, name: "Original payload session" });
      const sharedGenerationInput = {
        projectId: project.id,
        sessionId: session.id,
        branchId: branch.id,
        contextNodeId: null,
        feedback: null,
        operatorInstruction: "Develop the next authorized evaluation payload.",
        generatorProfileRevisionId: generatorProfile.id,
        instructionRevisionId: generatorInstruction.id,
        techniqueRevisionIds: [technique.id],
        // The pipeline is used later by a derived revision, not by generation.
        // Export must discover it from immutable revision provenance.
        pipelineRevisionId: null,
        variables: { objective: "Test instruction hierarchy" },
        contextOptions: {
          contextMode: "minimal" as const,
          includeProjectBrief: true,
          includeSessionBrief: true,
          includeTargetConfig: false,
          budgetChars: 20_000
        },
        candidateCount: 1,
        diversity: "balanced" as const
      };
      const generatedGroup = await persistence.repository.createPayloadGeneration({
        ...sharedGenerationInput,
        parentRevisionId: null,
        contextSnapshot: { text: "Original helper context", branchId: branch.id, contextNodeId: null, manifest: { includedNodeIds: [] } }
      });
      const firstTrace = await persistence.contentStore.put(new TextEncoder().encode(
        `${JSON.stringify({ event: "helper-output", authorization: credential, accountId: accountIdentifier })}\n`
      ));
      const generatedAttempt = await persistence.repository.createPayloadGenerationAttempt({
        generationId: generatedGroup.id,
        ordinal: 1,
        backendSnapshot: {
          kind: "http-provider",
          protocol: "openai-chat",
          authMode: "credential",
          accountIdentifier
        },
        providerProfileId: provider.id,
        modelId: "helper-model",
        configSnapshotId: null,
        nativeThreadId: accountIdentifier,
        nativeTurnId: "native-turn-one"
      });
      await persistence.repository.updatePayloadGenerationAttempt(generatedAttempt.id, {
        status: "completed",
        normalizedOutput: { text: "generated payload", reasoning: "first helper reasoning", accountIdentifier },
        usage: { inputTokens: 31, outputTokens: 8 },
        traceHash: firstTrace.sha256,
        startedAt: "2026-08-15T09:00:00.000Z",
        finishedAt: "2026-08-15T09:00:01.000Z"
      });
      await persistence.repository.updatePayloadGeneration(generatedGroup.id, { status: "completed" });
      const generated = await persistence.repository.createPayloadRevision({
        projectId: project.id,
        sessionId: session.id,
        generationId: generatedGroup.id,
        attemptId: generatedAttempt.id,
        parentRevisionId: null,
        ordinal: 1,
        operation: "generated",
        text: "generated payload",
        provenance: { kind: "helper-candidate", contextHash: generatedGroup.contextHash }
      });

      const refinedGroup = await persistence.repository.createPayloadGeneration({
        ...sharedGenerationInput,
        parentRevisionId: generated.id,
        feedback: "Make the payload more concise.",
        contextSnapshot: { text: "Original helper context", branchId: branch.id, contextNodeId: null, manifest: { includedNodeIds: [] } }
      });
      const refinedTrace = await persistence.contentStore.put(new TextEncoder().encode(
        `${JSON.stringify({ event: "helper-refinement", authorization: credential, accountId: accountIdentifier })}\n`
      ));
      const refinedAttempt = await persistence.repository.createPayloadGenerationAttempt({
        generationId: refinedGroup.id,
        ordinal: 1,
        backendSnapshot: {
          kind: "http-provider",
          protocol: "openai-chat",
          authMode: "credential",
          accountIdentifier
        },
        providerProfileId: provider.id,
        modelId: "helper-model",
        configSnapshotId: null,
        nativeThreadId: accountIdentifier,
        nativeTurnId: "native-turn-two"
      });
      await persistence.repository.updatePayloadGenerationAttempt(refinedAttempt.id, {
        status: "completed",
        normalizedOutput: { text: "refined payload", reasoning: "second helper reasoning", helperTraceHash: refinedTrace.sha256 },
        usage: { inputTokens: 42, outputTokens: 6 },
        traceHash: refinedTrace.sha256,
        startedAt: "2026-08-15T09:01:00.000Z",
        finishedAt: "2026-08-15T09:01:01.000Z"
      });
      await persistence.repository.updatePayloadGeneration(refinedGroup.id, { status: "completed" });
      const refined = await persistence.repository.createPayloadRevision({
        projectId: project.id,
        sessionId: session.id,
        generationId: refinedGroup.id,
        attemptId: refinedAttempt.id,
        parentRevisionId: generated.id,
        ordinal: 1,
        operation: "refined",
        text: "refined payload",
        provenance: { kind: "helper-refinement", feedback: "Make the payload more concise." }
      });
      const transformed = await persistence.repository.createPayloadRevision({
        projectId: project.id,
        sessionId: session.id,
        generationId: refinedGroup.id,
        attemptId: null,
        parentRevisionId: refined.id,
        ordinal: 1,
        operation: "transformed",
        text: "cmVmaW5lZCBwYXlsb2Fk",
        provenance: { transformId: "base64-encode", version: 1, pipelineRevisionId: pipeline.id }
      });
      const accepted = await persistence.repository.appendNode({
        sessionId: session.id,
        branchId: branch.id,
        parentId: null,
        role: "user",
        parts: [{ type: "text", text: transformed.text }],
        sourcePayloadRevisionId: transformed.id
      });
      const finding = await persistence.repository.createFinding({
        projectId: project.id,
        sessionId: session.id,
        branchId: branch.id,
        nodeId: accepted.id,
        title: "Payload lineage round trip",
        severity: "medium",
        summary: "An accepted payload with helper provenance.",
        expected: "Preserve reproducible lineage.",
        observed: "The payload was accepted into the target transcript.",
        tags: ["payload", "provenance"]
      });

      const exported = await app.request(`/api/findings/${finding.id}/export?projectId=${project.id}`, { headers });
      expect(exported.status).toBe(200);
      const archive = await exported.arrayBuffer();
      const inspected = importFindingArtifact(new Uint8Array(archive));
      const serializedBundle = JSON.stringify(inspected.manifest) + inspected.files
        .map((file) => new TextDecoder().decode(file.data))
        .join("\n");
      expect(serializedBundle).not.toContain(credential);
      expect(serializedBundle).not.toContain(accountIdentifier);
      expect(serializedBundle).toContain("REDACTED");
      expect(inspected.files.map((file) => file.path)).toEqual(expect.arrayContaining([
        "payloads/generations.json",
        "payloads/attempts.json",
        "payloads/revisions.json",
        `traces/evidence/${firstTrace.sha256}.ndjson`,
        `traces/evidence/${refinedTrace.sha256}.ndjson`
      ]));

      const form = new FormData();
      form.set("file", new File([archive], "payload-lineage.lathe-finding", { type: "application/zip" }));
      const importedResponse = await app.request("/api/artifacts/import", { method: "POST", headers, body: form });
      expect(importedResponse.status).toBe(201);
      const body = await importedResponse.json() as {
        session: { id: string };
        importedEvidenceAssets: AssetRevision[];
        importedPayloadGenerations: Array<{ id: string; parentRevisionId: string | null; generatorProfileRevisionId: string; instructionRevisionId: string | null; techniqueRevisionIds: string[]; pipelineRevisionId: string | null }>;
        importedPayloadAttempts: Array<{ id: string; generationId: string; traceHash: string | null; nativeThreadId: string | null; nativeTurnId: string | null; normalizedOutput: JsonObject }>;
        importedPayloadRevisions: Array<{ id: string; generationId: string | null; attemptId: string | null; parentRevisionId: string | null; operation: "generated" | "refined" | "edited" | "transformed"; text: string; provenance: JsonObject }>;
      };
      expect(JSON.stringify(body)).not.toContain(credential);
      expect(JSON.stringify(body)).not.toContain(accountIdentifier);
      expect(body.importedEvidenceAssets).toHaveLength(4);
      expect(body.importedEvidenceAssets.every((asset) => asset.trusted === false)).toBe(true);
      expect(new Set(body.importedEvidenceAssets.map((asset) => asset.kind))).toEqual(new Set([
        "payload-generator-profile",
        "payload-generator-instruction",
        "payload-technique",
        "payload-pipeline"
      ]));
      expect(body.importedPayloadGenerations).toHaveLength(2);
      expect(body.importedPayloadAttempts).toHaveLength(2);
      expect(body.importedPayloadRevisions).toHaveLength(3);

      const importedGenerated = body.importedPayloadRevisions.find((item) => item.operation === "generated")!;
      const importedRefined = body.importedPayloadRevisions.find((item) => item.operation === "refined")!;
      const importedTransformed = body.importedPayloadRevisions.find((item) => item.operation === "transformed")!;
      expect(importedRefined.parentRevisionId).toBe(importedGenerated.id);
      expect(importedTransformed.parentRevisionId).toBe(importedRefined.id);
      expect(importedGenerated.id).not.toBe(generated.id);
      expect(importedRefined.id).not.toBe(refined.id);
      expect(importedTransformed.id).not.toBe(transformed.id);

      const importedNodes = await persistence.repository.listNodes(body.session.id);
      expect(importedNodes).toHaveLength(1);
      expect(importedNodes[0]).toMatchObject({
        role: "user",
        parts: [{ type: "text", text: transformed.text }],
        sourcePayloadRevisionId: importedTransformed.id
      });
      const assetsById = new Map(body.importedEvidenceAssets.map((asset) => [asset.id, asset.kind]));
      for (const generation of body.importedPayloadGenerations) {
        expect(assetsById.get(generation.generatorProfileRevisionId)).toBe("payload-generator-profile");
        expect(assetsById.get(generation.instructionRevisionId!)).toBe("payload-generator-instruction");
        expect(generation.techniqueRevisionIds.map((id) => assetsById.get(id))).toEqual(["payload-technique"]);
        expect(generation.pipelineRevisionId).toBeNull();
      }
      expect(assetsById.get(String(importedTransformed.provenance.pipelineRevisionId))).toBe("payload-pipeline");
      expect(importedTransformed.provenance.pipelineRevisionId).not.toBe(pipeline.id);
      for (const revision of [importedGenerated, importedRefined]) {
        const attempt = body.importedPayloadAttempts.find((item) => item.id === revision.attemptId);
        expect(attempt?.generationId).toBe(revision.generationId);
      }
      expect(body.importedPayloadAttempts.every((attempt) => attempt.nativeThreadId === null && attempt.nativeTurnId === null)).toBe(true);
      for (const attempt of body.importedPayloadAttempts) {
        expect(attempt.traceHash).toMatch(/^[a-f0-9]{64}$/);
        expect([firstTrace.sha256, refinedTrace.sha256]).not.toContain(attempt.traceHash);
        const traceResponse = await app.request(`/api/traces/${attempt.traceHash}`, { headers });
        expect(traceResponse.status).toBe(200);
        const traceText = await traceResponse.text();
        expect(traceText).toContain("helper-");
        expect(traceText).toContain("REDACTED");
        expect(traceText).not.toContain(credential);
        expect(traceText).not.toContain(accountIdentifier);
      }
    } finally {
      await persistence.repository.close();
    }
  });
});
