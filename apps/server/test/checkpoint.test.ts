import { mkdtemp, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistence } from "@lathe/db";
import { emptyResolvedConfig, type Checkpoint } from "@lathe/domain";
import { createApp } from "../src/app.js";
import { EventHub } from "../src/events.js";
import { UnavailableRunCoordinator } from "../src/run-coordinator.js";

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true }))));

describe("checkpoint API", () => {
  it("atomically rejects cross-session/missing branches and restores the full captured session state", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-checkpoint-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    const token = "checkpoint-token";
    const headers = { authorization: `Bearer ${token}`, "content-type": "application/json" };
    const app = createApp({ repository: persistence.repository, contentStore: persistence.contentStore, events: new EventHub(), runCoordinator: new UnavailableRunCoordinator(), apiToken: token, dataDirectory });
    try {
      const firstProject = await persistence.repository.createProject({ name: "First" });
      const secondProject = await persistence.repository.createProject({ name: "Second" });
      const { session, branch } = await persistence.repository.createSession({ projectId: firstProject.id, name: "Session" });
      const { session: otherSession, branch: otherBranch } = await persistence.repository.createSession({ projectId: secondProject.id, name: "Other" });
      const otherNode = await persistence.repository.appendNode({ sessionId: otherSession.id, branchId: otherBranch.id, role: "user", parts: [{ type: "text", text: "must remain" }] });
      const firstProvider = await persistence.repository.createProviderProfile({ label: "First provider", protocol: "openai-chat", baseUrl: "https://first.invalid" });
      const secondProvider = await persistence.repository.createProviderProfile({ label: "Second provider", protocol: "anthropic-messages", baseUrl: "https://second.invalid" });

      const capturedConfig = emptyResolvedConfig();
      capturedConfig.temperature = 0.4;
      capturedConfig.maxOutputTokens = 512;
      await persistence.repository.updateSessionModel(session.id, firstProvider.id, "first-model");
      await persistence.repository.updateSessionContinuation(session.id, true, 7);
      await persistence.repository.updateSessionDraft(session.id, capturedConfig);
      const createdResponse = await app.request(`/api/sessions/${session.id}/checkpoints`, {
        method: "POST", headers, body: JSON.stringify({ name: "root checkpoint", nodeId: null })
      });
      expect(createdResponse.status).toBe(201);
      const checkpoint = (await createdResponse.json() as { checkpoint: Checkpoint }).checkpoint;
      expect(checkpoint).toMatchObject({ providerProfileId: firstProvider.id, modelId: "first-model", autoContinueTools: true, autoContinueLimit: 7, sessionStateCaptured: true });

      const changedConfig = emptyResolvedConfig();
      changedConfig.temperature = 1.2;
      await persistence.repository.updateSessionModel(session.id, secondProvider.id, "second-model");
      await persistence.repository.updateSessionContinuation(session.id, false, 2);
      await persistence.repository.updateSessionDraft(session.id, changedConfig);

      const crossSession = await app.request(`/api/checkpoints/${checkpoint.id}/restore?sessionId=${session.id}&branchId=${otherBranch.id}`, { method: "POST", headers });
      expect(crossSession.status).toBe(409);
      expect((await persistence.repository.listBranches(otherSession.id))[0]?.headNodeId).toBe(otherNode.id);
      expect(await persistence.repository.getSession(session.id)).toMatchObject({ providerProfileId: secondProvider.id, modelId: "second-model", autoContinueTools: false, autoContinueLimit: 2, draftConfig: { temperature: 1.2 } });

      const missingBranch = await app.request(`/api/checkpoints/${checkpoint.id}/restore?sessionId=${session.id}&branchId=missing`, { method: "POST", headers });
      expect(missingBranch.status).toBe(404);
      expect(await persistence.repository.getSession(session.id)).toMatchObject({ providerProfileId: secondProvider.id, modelId: "second-model" });

      const restoredResponse = await app.request(`/api/checkpoints/${checkpoint.id}/restore?sessionId=${session.id}&branchId=${branch.id}`, { method: "POST", headers });
      expect(restoredResponse.status).toBe(200);
      expect(await restoredResponse.json()).toMatchObject({
        branch: { id: branch.id, headNodeId: null },
        session: {
          activeBranchId: branch.id,
          providerProfileId: firstProvider.id,
          modelId: "first-model",
          autoContinueTools: true,
          autoContinueLimit: 7,
          draftConfig: { temperature: 0.4, maxOutputTokens: 512, provider: null }
        }
      });
      expect((await persistence.repository.getSession(session.id))?.draftConfig).toEqual(capturedConfig);
    } finally {
      await persistence.repository.close();
    }
  });
});
