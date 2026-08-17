import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistence } from "@lathe/db";
import { nowIso, sha256Json, uuidv7, type AssetRevision, type JsonObject, type PayloadRevision } from "@lathe/domain";
import { createApp } from "../src/app.js";
import { EventHub } from "../src/events.js";
import { UnavailableRunCoordinator } from "../src/run-coordinator.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-payload-recipe-"));
  directories.push(dataDirectory);
  const persistence = await createPersistence({ dataDirectory });
  const project = await persistence.repository.createProject({ name: "Recipe project" });
  const { session, branch } = await persistence.repository.createSession({ projectId: project.id, name: "Source" });
  const { session: destination, branch: destinationBranch } = await persistence.repository.createSession({ projectId: project.id, name: "Destination" });
  const token = "payload-recipe-token";
  const app = createApp({
    repository: persistence.repository,
    contentStore: persistence.contentStore,
    events: new EventHub(),
    runCoordinator: new UnavailableRunCoordinator(),
    apiToken: token,
    dataDirectory
  });
  const request = (path: string, body: unknown) => app.request(path, {
    method: "POST",
    headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
    body: JSON.stringify(body)
  });
  return { persistence, app, token, session, destination, branch, destinationBranch, request };
}

async function revision(
  repository: Awaited<ReturnType<typeof createPersistence>>["repository"],
  session: { id: string; projectId: string },
  text: string,
  parentRevisionId: string | null,
  operation: "edited" | "transformed",
  provenance: JsonObject
): Promise<PayloadRevision> {
  return repository.createPayloadRevision({
    projectId: session.projectId,
    sessionId: session.id,
    generationId: null,
    attemptId: null,
    parentRevisionId,
    ordinal: 1,
    operation,
    text,
    provenance
  });
}

describe("payload recipe routes", () => {
  it("saves an authoritative self-contained lineage and replays detached intermediates into another session", async () => {
    const { persistence, app, token, session, destination, branch, destinationBranch, request } = await fixture();
    try {
      const seed = await revision(persistence.repository, session, "Hello {{name}}", null, "edited", { kind: "manual-seed" });
      const rendered = await revision(persistence.repository, session, "Hello Alice", seed.id, "transformed", {
        kind: "transform", transformId: "render-variables", version: 1, parameters: { name: "Alice", unused: "ignored" }
      });
      const upper = await revision(persistence.repository, session, "HELLO ALICE", rendered.id, "transformed", {
        kind: "transform", transformId: "uppercase", version: 1, parameters: {}
      });

      const saveResponse = await request(`/api/payload-revisions/${upper.id}/recipes`, {
        name: "Greeting recipe",
        description: "Captured deterministic lineage",
        tags: ["test", "test"]
      });
      expect(saveResponse.status).toBe(201);
      const saved = await saveResponse.json() as { recipe: AssetRevision };
      expect(saved.recipe).toMatchObject({ kind: "payload-recipe", name: "Greeting recipe", trusted: true, tags: ["test"] });
      expect(saved.recipe.provenance).toMatchObject({ sourceProjectId: session.projectId, sourceSessionId: session.id, sourceRevisionId: upper.id });
      const serializedValue = JSON.stringify(saved.recipe.value);
      expect(serializedValue).not.toContain(session.id);
      expect(serializedValue).not.toContain(seed.id);
      expect(saved.recipe.value).toMatchObject({
        version: 1,
        finalContentHash: upper.contentHash,
        variables: [{ name: "name", defaultValue: "Alice" }],
        steps: [
          { kind: "checkpoint", sourceOperation: "edited", text: "Hello {{name}}", contentHash: seed.contentHash, generator: null },
          { kind: "transform", transformId: "render-variables", version: 1, variableNames: ["name"], parameters: {}, capturedOutputText: "Hello Alice", outputContentHash: rendered.contentHash },
          { kind: "transform", transformId: "uppercase", version: 1, capturedOutputText: "HELLO ALICE", outputContentHash: upper.contentHash }
        ]
      });

      const previewResponse = await request(`/api/payload-recipes/${saved.recipe.id}/preview`, {
        sessionId: destination.id,
        variables: { name: "Bob" }
      });
      expect(previewResponse.status).toBe(200);
      const previewBody = await previewResponse.json() as { preview: { compatible: boolean; completed: boolean; preflightHash: string; finalText: string; matchesCaptured: boolean } };
      expect(previewBody.preview).toMatchObject({ compatible: true, completed: true, finalText: "HELLO BOB", matchesCaptured: false });
      expect(await persistence.repository.listPayloadRevisions(destination.id)).toEqual([]);

      const staleResponse = await request(`/api/payload-recipes/${saved.recipe.id}/replay`, {
        sessionId: destination.id,
        variables: { name: "Bob" },
        preflightHash: "0".repeat(64)
      });
      expect(staleResponse.status).toBe(409);
      expect(await persistence.repository.listPayloadRevisions(destination.id)).toEqual([]);

      const replayResponse = await request(`/api/payload-recipes/${saved.recipe.id}/replay`, {
        sessionId: destination.id,
        variables: { name: "Bob" },
        preflightHash: previewBody.preview.preflightHash
      });
      expect(replayResponse.status).toBe(201);
      const replayed = await replayResponse.json() as { completed: boolean; revision: PayloadRevision; revisions: PayloadRevision[] };
      expect(replayed.completed).toBe(true);
      expect(replayed.revisions.map((item) => item.text)).toEqual(["Hello {{name}}", "Hello Bob", "HELLO BOB"]);
      expect(replayed.revisions.map((item) => item.operation)).toEqual(["edited", "transformed", "transformed"]);
      expect(replayed.revisions.every((item) => item.generationId === null && item.attemptId === null)).toBe(true);
      expect(replayed.revisions[1]).toMatchObject({
        parentRevisionId: replayed.revisions[0]?.id,
        provenance: {
          kind: "recipe-replay",
          recipeRevisionId: saved.recipe.id,
          recipeContentHash: saved.recipe.contentHash,
          stepIndex: 1,
          stepCount: 3,
          stepKind: "transform",
          transformId: "render-variables",
          parameters: { name: "Bob" }
        }
      });
      expect(replayed.revision.id).toBe(replayed.revisions[2]?.id);
      expect(await persistence.repository.listNodes(destination.id)).toEqual([]);
      expect(await persistence.repository.listRuns(destination.id)).toEqual([]);
      expect(await persistence.repository.listPayloadGenerations(destination.id)).toEqual([]);
      expect((await persistence.repository.listBranches(session.id)).find((item) => item.id === branch.id)?.headNodeId).toBeNull();
      expect((await persistence.repository.listBranches(destination.id)).find((item) => item.id === destinationBranch.id)?.headNodeId).toBeNull();

      const resavedResponse = await request(`/api/payload-revisions/${replayed.revision.id}/recipes`, { name: "Replayed greeting" });
      expect(resavedResponse.status).toBe(201);
      expect(await resavedResponse.json()).toMatchObject({ recipe: { kind: "payload-recipe", value: { variables: [{ name: "name", defaultValue: "Bob" }] } } });

      const deleteResponse = await app.request(`/api/library/assets/${saved.recipe.id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${token}` }
      });
      expect(deleteResponse.status).toBe(409);
      const deletion = await deleteResponse.json() as { error: { code: string; references: Array<{ kind: string }> } };
      expect(deletion.error.code).toBe("resource-in-use");
      expect(deletion.error.references).toHaveLength(3);
      expect(deletion.error.references).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "payload-revision" })]));
    } finally {
      await persistence.repository.close();
    }
  });

  it("keeps unsupported transform versions inspectable and blocks replay before mutation", async () => {
    const { persistence, destination, request } = await fixture();
    try {
      const seedText = "abc";
      const outputText = "ABC";
      const corruptResponse = await request("/api/library/assets", {
        kind: "payload-recipe",
        name: "Corrupt captured recipe",
        value: {
          version: 1,
          finalContentHash: sha256Json(seedText),
          variables: [],
          steps: [{ kind: "checkpoint", sourceOperation: "edited", text: seedText, contentHash: "f".repeat(64), generator: null }]
        },
        trusted: true
      });
      expect(corruptResponse.status).toBe(400);
      expect(await corruptResponse.text()).toMatch(/does not match its content hash/i);

      const value = {
        version: 1,
        finalContentHash: sha256Json(outputText),
        variables: [],
        steps: [
          { kind: "checkpoint", sourceOperation: "edited", text: seedText, contentHash: sha256Json(seedText), generator: null },
          { kind: "transform", transformId: "uppercase", version: 2, parameters: {}, variableNames: [], inputContentHash: sha256Json(seedText), capturedOutputText: outputText, outputContentHash: sha256Json(outputText), pipelineRevisionId: null }
        ]
      } satisfies JsonObject;
      const recipe: AssetRevision = {
        id: uuidv7(), assetId: uuidv7(), kind: "payload-recipe", revision: 1, name: "Future recipe", description: "", tags: [],
        provenance: { test: true }, value, contentHash: sha256Json(value), trusted: true, archivedAt: null, createdAt: nowIso()
      };
      await persistence.repository.saveAssetRevision(recipe);

      const previewResponse = await request(`/api/payload-recipes/${recipe.id}/preview`, { sessionId: destination.id, variables: {} });
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json() as { preview: { compatible: boolean; preflightHash: null; violations: Array<{ code: string }> } };
      expect(preview.preview.compatible).toBe(false);
      expect(preview.preview.preflightHash).toBeNull();
      expect(preview.preview.violations).toContainEqual(expect.objectContaining({ code: "unsupported-version" }));

      const replayResponse = await request(`/api/payload-recipes/${recipe.id}/replay`, {
        sessionId: destination.id,
        variables: {},
        preflightHash: "0".repeat(64)
      });
      expect(replayResponse.status).toBe(422);
      expect(await persistence.repository.listPayloadRevisions(destination.id)).toEqual([]);

      const trustedValue = {
        ...value,
        steps: [
          value.steps[0],
          { ...value.steps[1], version: 1 }
        ]
      } satisfies JsonObject;
      const untrusted: AssetRevision = {
        ...recipe,
        id: uuidv7(),
        assetId: uuidv7(),
        name: "Imported untrusted recipe",
        value: trustedValue,
        contentHash: sha256Json(trustedValue),
        trusted: false
      };
      await persistence.repository.saveAssetRevision(untrusted);
      const untrustedPreviewResponse = await request(`/api/payload-recipes/${untrusted.id}/preview`, { sessionId: destination.id, variables: {} });
      const untrustedPreview = await untrustedPreviewResponse.json() as { preview: { compatible: boolean; preflightHash: null; violations: Array<{ code: string }> } };
      expect(untrustedPreview.preview.compatible).toBe(false);
      expect(untrustedPreview.preview.violations).toContainEqual(expect.objectContaining({ code: "untrusted-recipe" }));
      const untrustedReplay = await request(`/api/payload-recipes/${untrusted.id}/replay`, { sessionId: destination.id, variables: {}, preflightHash: "0".repeat(64) });
      expect(untrustedReplay.status).toBe(422);
      expect(await persistence.repository.listPayloadRevisions(destination.id)).toEqual([]);

      expect(await persistence.repository.deleteAssetRevision(untrusted.id)).toEqual({ deleted: true, references: [] });
      const archivedPreviewResponse = await request(`/api/payload-recipes/${untrusted.id}/preview`, { sessionId: destination.id, variables: {} });
      expect(archivedPreviewResponse.status).toBe(200);
      expect(await archivedPreviewResponse.json()).toMatchObject({ preview: { violations: expect.arrayContaining([expect.objectContaining({ code: "archived-recipe" })]) } });
      const archivedReplay = await request(`/api/payload-recipes/${untrusted.id}/replay`, { sessionId: destination.id, variables: {}, preflightHash: "0".repeat(64) });
      expect(archivedReplay.status).toBe(409);
    } finally {
      await persistence.repository.close();
    }
  });

  it("rejects conflicting captured defaults for the same referenced variable", async () => {
    const { persistence, session, request } = await fixture();
    try {
      const firstTemplate = await revision(persistence.repository, session, "{{name}}", null, "edited", { kind: "manual-seed" });
      const firstRender = await revision(persistence.repository, session, "Alice", firstTemplate.id, "transformed", { kind: "transform", transformId: "render-variables", version: 1, parameters: { name: "Alice" } });
      const secondTemplate = await revision(persistence.repository, session, "{{name}}", firstRender.id, "edited", { kind: "operator-edit" });
      const secondRender = await revision(persistence.repository, session, "Bob", secondTemplate.id, "transformed", { kind: "transform", transformId: "render-variables", version: 1, parameters: { name: "Bob" } });
      const response = await request(`/api/payload-revisions/${secondRender.id}/recipes`, { name: "Conflicting recipe" });
      expect(response.status).toBe(422);
      expect(await response.text()).toMatch(/conflicting captured defaults/i);
      expect(await persistence.repository.listAssetRevisions("payload-recipe")).toEqual([]);
    } finally {
      await persistence.repository.close();
    }
  });

  it("captures immutable generator dependencies as checkpoint evidence without replaying the helper", async () => {
    const { persistence, session, branch, destination, request } = await fixture();
    try {
      const saveAsset = async (kind: AssetRevision["kind"], name: string): Promise<AssetRevision> => {
        const value: JsonObject = { fixture: name };
        return persistence.repository.saveAssetRevision({
          id: uuidv7(), assetId: uuidv7(), kind, revision: 1, name, description: "", tags: [], provenance: { test: true },
          value, contentHash: sha256Json(value), trusted: true, archivedAt: null, createdAt: nowIso()
        });
      };
      const profile = await saveAsset("payload-generator-profile", "Profile");
      const instruction = await saveAsset("payload-generator-instruction", "Instruction");
      const technique = await saveAsset("payload-technique", "Technique");
      const pipeline = await saveAsset("payload-pipeline", "Pipeline");
      const contextSnapshot = { manifest: "exact-context" };
      const generation = await persistence.repository.createPayloadGeneration({
        projectId: session.projectId,
        sessionId: session.id,
        branchId: branch.id,
        contextNodeId: null,
        parentRevisionId: null,
        feedback: null,
        operatorInstruction: "Create one payload",
        generatorProfileRevisionId: profile.id,
        instructionRevisionId: instruction.id,
        techniqueRevisionIds: [technique.id],
        pipelineRevisionId: pipeline.id,
        variables: {},
        contextOptions: { contextMode: "none", includeProjectBrief: false, includeSessionBrief: false, includeTargetConfig: false, budgetChars: 2_000 },
        candidateCount: 1,
        diversity: "balanced",
        contextSnapshot
      });
      const attempt = await persistence.repository.createPayloadGenerationAttempt({
        generationId: generation.id,
        ordinal: 1,
        backendSnapshot: { kind: "fixture" }
      });
      const generated = await persistence.repository.createPayloadRevision({
        projectId: session.projectId,
        sessionId: session.id,
        generationId: generation.id,
        attemptId: attempt.id,
        parentRevisionId: null,
        ordinal: 1,
        operation: "generated",
        text: "captured helper output",
        provenance: { kind: "helper-candidate" }
      });
      const response = await request(`/api/payload-revisions/${generated.id}/recipes`, { name: "Generator checkpoint" });
      expect(response.status).toBe(201);
      const body = await response.json() as { recipe: AssetRevision };
      expect(body.recipe.value).toMatchObject({
        steps: [{
          kind: "checkpoint",
          sourceOperation: "generated",
          text: "captured helper output",
          generator: {
            profileRevisionId: profile.id,
            instructionRevisionId: instruction.id,
            techniqueRevisionIds: [technique.id],
            pipelineRevisionId: pipeline.id,
            contextHash: sha256Json(contextSnapshot)
          }
        }]
      });
      expect(JSON.stringify(body.recipe.value)).not.toContain(generation.id);

      const previewResponse = await request(`/api/payload-recipes/${body.recipe.id}/preview`, { sessionId: destination.id, variables: {} });
      const preview = await previewResponse.json() as { preview: { preflightHash: string } };
      const replayResponse = await request(`/api/payload-recipes/${body.recipe.id}/replay`, { sessionId: destination.id, variables: {}, preflightHash: preview.preview.preflightHash });
      expect(replayResponse.status).toBe(201);
      expect(await persistence.repository.listPayloadGenerations(destination.id)).toEqual([]);
      expect(await persistence.repository.listNodes(destination.id)).toEqual([]);
    } finally {
      await persistence.repository.close();
    }
  });
});
