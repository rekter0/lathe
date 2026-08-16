import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistence } from "@lathe/db";
import { nowIso, sha256Json, uuidv7, type AssetKind, type AssetRevision, type JsonObject } from "@lathe/domain";
import { createApp } from "../src/app.js";
import { EventHub } from "../src/events.js";
import { UnavailableRunCoordinator } from "../src/run-coordinator.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

function asset(kind: AssetKind, name: string): AssetRevision {
  const value: JsonObject = { version: 1, name };
  return {
    id: uuidv7(),
    assetId: uuidv7(),
    kind,
    revision: 1,
    name,
    description: `${name} fixture`,
    tags: ["test"],
    provenance: { test: true },
    value,
    contentHash: sha256Json(value),
    trusted: true,
    archivedAt: null,
    createdAt: nowIso()
  };
}

describe("session Payload Workbench settings routes", () => {
  it("persists complete settings per session and validates references", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-payload-session-settings-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    const token = "payload-session-settings-token";
    try {
      const project = await persistence.repository.createProject({ name: "Project" });
      const first = await persistence.repository.createSession({ projectId: project.id, name: "First" });
      const second = await persistence.repository.createSession({ projectId: project.id, name: "Second" });
      const profile = asset("payload-generator-profile", "Profile");
      const instruction = asset("payload-generator-instruction", "Instruction");
      const technique = asset("payload-technique", "Technique");
      const pipeline = asset("payload-pipeline", "Pipeline");
      await Promise.all([profile, instruction, technique, pipeline].map((item) => persistence.repository.saveAssetRevision(item)));

      const app = createApp({
        repository: persistence.repository,
        contentStore: persistence.contentStore,
        events: new EventHub(),
        runCoordinator: new UnavailableRunCoordinator(),
        apiToken: token,
        dataDirectory
      });
      const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };

      const empty = await app.request(`/api/sessions/${first.session.id}/payload-workbench/settings`, { headers });
      expect(empty.status).toBe(200);
      expect(await empty.json()).toEqual({ settings: null });

      const input = {
        generatorProfileRevisionId: profile.id,
        instructionRevisionId: instruction.id,
        techniqueRevisionIds: [technique.id],
        pipelineRevisionId: pipeline.id,
        operatorInstruction: "Generate a payload for this session.",
        variables: { objective: "Test the target", target_name: "Fixture" },
        candidateCount: 4,
        diversity: "high",
        contextMode: "minimal",
        includeProjectBrief: true,
        includeSessionBrief: true,
        includeTargetConfig: false,
        budgetChars: 32_000
      };
      const savedResponse = await app.request(`/api/sessions/${first.session.id}/payload-workbench/settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify(input)
      });
      expect(savedResponse.status).toBe(200);
      const saved = await savedResponse.json() as { settings: Record<string, unknown> };
      expect(saved.settings).toMatchObject({ sessionId: first.session.id, ...input });
      expect(saved.settings.createdAt).toEqual(expect.any(String));
      expect(saved.settings.updatedAt).toEqual(expect.any(String));

      const reopened = await app.request(`/api/sessions/${first.session.id}/payload-workbench/settings`, { headers });
      expect(await reopened.json()).toEqual(saved);
      const independent = await app.request(`/api/sessions/${second.session.id}/payload-workbench/settings`, { headers });
      expect(await independent.json()).toEqual({ settings: null });

      const duplicateTechniques = await app.request(`/api/sessions/${first.session.id}/payload-workbench/settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ ...input, techniqueRevisionIds: [technique.id, technique.id] })
      });
      expect(duplicateTechniques.status).toBe(400);

      const wrongKind = await app.request(`/api/sessions/${first.session.id}/payload-workbench/settings`, {
        method: "PUT",
        headers,
        body: JSON.stringify({ ...input, generatorProfileRevisionId: technique.id })
      });
      expect(wrongKind.status).toBe(409);
      expect(await wrongKind.text()).toContain("payload-generator-profile revision is unavailable");

      const missingGet = await app.request("/api/sessions/missing/payload-workbench/settings", { headers });
      expect(missingGet.status).toBe(404);
      const missingPut = await app.request("/api/sessions/missing/payload-workbench/settings", {
        method: "PUT",
        headers,
        body: JSON.stringify(input)
      });
      expect(missingPut.status).toBe(404);
    } finally {
      await persistence.repository.close();
    }
  });
});
