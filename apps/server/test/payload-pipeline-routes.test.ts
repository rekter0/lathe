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

function pipelineAsset(value: JsonObject): AssetRevision {
  return {
    id: uuidv7(),
    assetId: uuidv7(),
    kind: "payload-pipeline",
    revision: 1,
    name: "Partially failing pipeline",
    description: "Persists successful intermediates before a deterministic failure.",
    tags: ["test"],
    provenance: { test: true },
    value,
    contentHash: sha256Json(value),
    trusted: true,
    archivedAt: null,
    createdAt: nowIso()
  };
}

describe("payload pipeline derivation", () => {
  it("persists every successful intermediate and returns the last one when a later step fails", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-payload-pipeline-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    const token = "payload-pipeline-token";
    try {
      const project = await persistence.repository.createProject({ name: "Project" });
      const { session } = await persistence.repository.createSession({ projectId: project.id, name: "Session" });
      const pipeline = pipelineAsset({
        steps: [
          { transformId: "uppercase", version: 1, enabled: true },
          { transformId: "reverse", version: 1, enabled: true },
          { transformId: "hex-decode", version: 1, enabled: true },
          { transformId: "lowercase", version: 1, enabled: true }
        ]
      });
      await persistence.repository.saveAssetRevision(pipeline);
      const seed = await persistence.repository.createPayloadRevision({
        projectId: project.id,
        sessionId: session.id,
        generationId: null,
        attemptId: null,
        parentRevisionId: null,
        ordinal: 1,
        operation: "edited",
        text: "abc",
        provenance: { kind: "test-seed" }
      });
      const app = createApp({
        repository: persistence.repository,
        contentStore: persistence.contentStore,
        events: new EventHub(),
        runCoordinator: new UnavailableRunCoordinator(),
        apiToken: token,
        dataDirectory
      });

      const response = await app.request(`/api/payload-revisions/${seed.id}/derive`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "pipeline", pipelineRevisionId: pipeline.id, variables: {} })
      });

      expect(response.status).toBe(201);
      const body = await response.json() as {
        revision: PayloadRevision;
        revisions: PayloadRevision[];
        completed: boolean;
        error: string | null;
      };
      expect(body.completed).toBe(false);
      expect(body.error).toMatch(/hexadecimal digits/i);
      expect(body.revisions.map((revision) => revision.text)).toEqual(["ABC", "CBA"]);
      expect(body.revisions[0]).toMatchObject({
        parentRevisionId: seed.id,
        operation: "transformed",
        provenance: { kind: "pipeline-step", pipelineRevisionId: pipeline.id, stepIndex: 0, transformId: "uppercase", version: 1, parameters: {} }
      });
      expect(body.revisions[1]).toMatchObject({
        parentRevisionId: body.revisions[0]?.id,
        operation: "transformed",
        provenance: { kind: "pipeline-step", pipelineRevisionId: pipeline.id, stepIndex: 1, transformId: "reverse", version: 1, parameters: {} }
      });
      expect(body.revision.id).toBe(body.revisions[1]?.id);

      const persisted = await persistence.repository.listPayloadRevisions(session.id);
      expect(persisted).toHaveLength(3);
      expect(new Set(persisted.map((revision) => revision.id))).toEqual(new Set([seed.id, ...body.revisions.map((revision) => revision.id)]));

      const invalidPipeline = await app.request("/api/library/assets", {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({
          kind: "payload-pipeline",
          name: "Invalid parameters",
          value: { steps: [{ transformId: "caesar-rotate", version: 1, enabled: true, parameters: { shift: "99" } }] },
          trusted: true
        })
      });
      expect(invalidPipeline.status).toBe(400);
      expect(JSON.stringify(await invalidPipeline.json())).toMatch(/Shift must be at most 25/);

      const emptySeed = await persistence.repository.createPayloadRevision({
        projectId: project.id,
        sessionId: session.id,
        generationId: null,
        attemptId: null,
        parentRevisionId: null,
        ordinal: 1,
        operation: "edited",
        text: " ",
        provenance: { kind: "empty-output-seed" }
      });
      const emptyResponse = await app.request(`/api/payload-revisions/${emptySeed.id}/derive`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "transform", transformId: "base64-decode", version: 1 })
      });
      expect(emptyResponse.status).toBe(201);
      expect(await emptyResponse.json()).toMatchObject({ revision: { text: "", operation: "transformed" } });

      const emptyPipeline = pipelineAsset({
        steps: [
          { transformId: "base64-decode", version: 1, enabled: true },
          { transformId: "uppercase", version: 1, enabled: true }
        ]
      });
      await persistence.repository.saveAssetRevision(emptyPipeline);
      const emptyPipelineResponse = await app.request(`/api/payload-revisions/${emptySeed.id}/derive`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "pipeline", pipelineRevisionId: emptyPipeline.id, variables: {} })
      });
      expect(emptyPipelineResponse.status).toBe(201);
      const emptyPipelineBody = await emptyPipelineResponse.json() as { completed: boolean; revisions: PayloadRevision[] };
      expect(emptyPipelineBody).toMatchObject({
        completed: true,
        revisions: [
          { text: "", parentRevisionId: emptySeed.id },
          { text: "", operation: "transformed" }
        ]
      });
      expect(emptyPipelineBody.revisions[1]?.parentRevisionId).toBe(emptyPipelineBody.revisions[0]?.id);

      const caesarResponse = await app.request(`/api/payload-revisions/${seed.id}/derive`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
        body: JSON.stringify({ kind: "transform", transformId: "caesar-rotate", version: 1 })
      });
      expect(caesarResponse.status).toBe(201);
      expect(await caesarResponse.json()).toMatchObject({
        revision: {
          text: "nop",
          provenance: { kind: "transform", transformId: "caesar-rotate", version: 1, parameters: { shift: "13" } }
        }
      });
    } finally {
      await persistence.repository.close();
    }
  });
});
