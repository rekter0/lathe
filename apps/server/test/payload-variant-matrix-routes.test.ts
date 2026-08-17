import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistence } from "@lathe/db";
import { sha256Json, type PayloadRevision } from "@lathe/domain";
import { createApp } from "../src/app.js";
import { EventHub } from "../src/events.js";
import { UnavailableRunCoordinator } from "../src/run-coordinator.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function fixture() {
  const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-payload-matrix-"));
  directories.push(dataDirectory);
  const persistence = await createPersistence({ dataDirectory });
  const project = await persistence.repository.createProject({ name: "Project" });
  const { session, branch } = await persistence.repository.createSession({ projectId: project.id, name: "Session" });
  const { session: otherSession } = await persistence.repository.createSession({ projectId: project.id, name: "Other" });
  const token = "payload-matrix-token";
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
  return { persistence, session, otherSession, branch, request };
}

describe("payload variant matrix routes", () => {
  it("preflights without persistence and atomically creates an attributed control and siblings", async () => {
    const { persistence, session, branch, request } = await fixture();
    try {
      const input = {
        source: { revisionId: null, text: "Abc" },
        transformId: "caesar-rotate",
        version: 1,
        parameterSets: [{ shift: " 1 " }, { shift: "13" }]
      };
      const previewResponse = await request(`/api/sessions/${session.id}/payload-variant-matrices/preflight`, input);
      expect(previewResponse.status).toBe(200);
      const preview = await previewResponse.json() as {
        preflight: {
          preflightHash: string;
          creatable: boolean;
          rows: Array<{ parameters: Record<string, string>; contentHash: string }>;
        };
      };
      expect(preview.preflight).toMatchObject({
        creatable: true,
        rows: [
          { parameters: { shift: "1" }, contentHash: sha256Json("Bcd") },
          { parameters: { shift: "13" }, contentHash: sha256Json("Nop") }
        ]
      });
      expect(await persistence.repository.listPayloadRevisions(session.id)).toEqual([]);

      const createResponse = await request(`/api/sessions/${session.id}/payload-variant-matrices`, {
        ...input,
        preflightHash: preview.preflight.preflightHash
      });
      expect(createResponse.status).toBe(201);
      const created = await createResponse.json() as {
        matrix: { id: string; sourceRevisionId: string; sourceContentHash: string; count: number; preflightHash: string };
        variants: PayloadRevision[];
      };
      expect(created.matrix).toMatchObject({
        sourceContentHash: sha256Json("Abc"),
        count: 2,
        preflightHash: preview.preflight.preflightHash
      });
      expect(created.variants.map((revision) => revision.text)).toEqual(["Bcd", "Nop"]);
      expect(created.variants.every((revision) => revision.parentRevisionId === created.matrix.sourceRevisionId)).toBe(true);
      expect(created.variants).toMatchObject([
        {
          operation: "transformed",
          provenance: {
            kind: "variant-matrix",
            matrixId: created.matrix.id,
            preflightHash: preview.preflight.preflightHash,
            transformId: "caesar-rotate",
            version: 1,
            parameters: { shift: "1" },
            ordinal: 1,
            variantCount: 2,
            matchesControl: false,
            duplicateOutputOf: null
          }
        },
        { provenance: { parameters: { shift: "13" }, ordinal: 2 } }
      ]);
      expect(Object.hasOwn(created.variants[0]!.provenance, "sourceRevisionId")).toBe(false);
      const persisted = await persistence.repository.listPayloadRevisions(session.id);
      expect(persisted).toHaveLength(3);
      expect(await persistence.repository.listNodes(session.id)).toEqual([]);
      expect((await persistence.repository.listBranches(session.id)).find((item) => item.id === branch.id)?.headNodeId).toBeNull();
    } finally {
      await persistence.repository.close();
    }
  });

  it("records edits as a new control and rejects stale, invalid, or cross-session creation", async () => {
    const { persistence, session, otherSession, request } = await fixture();
    try {
      const source = await persistence.repository.createPayloadRevision({
        projectId: session.projectId,
        sessionId: session.id,
        generationId: null,
        attemptId: null,
        parentRevisionId: null,
        ordinal: 1,
        operation: "edited",
        text: "123",
        provenance: { kind: "test" }
      });
      const input = {
        source: { revisionId: source.id, text: "1234" },
        transformId: "caesar-rotate",
        version: 1,
        parameterSets: [{ shift: "1" }, { shift: "2" }]
      };
      const previewResponse = await request(`/api/sessions/${session.id}/payload-variant-matrices/preflight`, input);
      const preview = await previewResponse.json() as {
        preflight: { preflightHash: string; creatable: boolean; rows: Array<{ matchesControl: boolean; duplicateOutputOrdinals: number[] }> };
      };
      expect(preview.preflight).toMatchObject({
        creatable: true,
        rows: [
          { matchesControl: true, duplicateOutputOrdinals: [2] },
          { matchesControl: true, duplicateOutputOrdinals: [1] }
        ]
      });
      const stale = await request(`/api/sessions/${session.id}/payload-variant-matrices`, {
        ...input,
        preflightHash: "a".repeat(64)
      });
      expect(stale.status).toBe(409);
      expect(await persistence.repository.listPayloadRevisions(session.id)).toHaveLength(1);

      const createdResponse = await request(`/api/sessions/${session.id}/payload-variant-matrices`, {
        ...input,
        preflightHash: preview.preflight.preflightHash
      });
      expect(createdResponse.status).toBe(201);
      const created = await createdResponse.json() as { matrix: { sourceRevisionId: string }; variants: PayloadRevision[] };
      expect(created.matrix.sourceRevisionId).not.toBe(source.id);
      const control = await persistence.repository.getPayloadRevision(created.matrix.sourceRevisionId);
      expect(control).toMatchObject({ parentRevisionId: source.id, operation: "edited", text: "1234" });
      expect(created.variants).toMatchObject([
        { provenance: { matchesControl: true, duplicateOutputOf: null } },
        { provenance: { matchesControl: true, duplicateOutputOf: 1 } }
      ]);

      const invalidInput = {
        source: { revisionId: source.id, text: source.text },
        transformId: "caesar-rotate",
        version: 1,
        parameterSets: [{ shift: "99" }]
      };
      const invalidPreviewResponse = await request(`/api/sessions/${session.id}/payload-variant-matrices/preflight`, invalidInput);
      expect(invalidPreviewResponse.status).toBe(200);
      expect(await invalidPreviewResponse.json()).toMatchObject({
        preflight: {
          creatable: false,
          preflightHash: null,
          violations: [expect.objectContaining({ code: "invalid-parameters", ordinal: 1 })]
        }
      });
      const invalidCreate = await request(`/api/sessions/${session.id}/payload-variant-matrices`, {
        ...invalidInput,
        preflightHash: "b".repeat(64)
      });
      expect(invalidCreate.status).toBe(422);

      const duplicatePreview = await request(`/api/sessions/${session.id}/payload-variant-matrices/preflight`, {
        ...input,
        parameterSets: [{ shift: "1" }, { shift: " 1 " }]
      });
      expect(duplicatePreview.status).toBe(200);
      expect(await duplicatePreview.json()).toMatchObject({
        preflight: {
          creatable: false,
          violations: [expect.objectContaining({ code: "duplicate-parameters", ordinal: 2 })]
        }
      });

      const unexpectedField = await request(`/api/sessions/${session.id}/payload-variant-matrices/preflight`, {
        ...input,
        unexpected: true
      });
      expect(unexpectedField.status).toBe(400);

      const otherSource = await persistence.repository.createPayloadRevision({
        projectId: otherSession.projectId,
        sessionId: otherSession.id,
        generationId: null,
        attemptId: null,
        parentRevisionId: null,
        ordinal: 1,
        operation: "edited",
        text: "other",
        provenance: {}
      });
      const crossSession = await request(`/api/sessions/${session.id}/payload-variant-matrices/preflight`, {
        ...input,
        source: { revisionId: otherSource.id, text: otherSource.text }
      });
      expect(crossSession.status).toBe(409);
    } finally {
      await persistence.repository.close();
    }
  });
});
