import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistence } from "@lathe/db";
import { emptyResolvedConfig } from "@lathe/domain";
import { createApp } from "../src/app.js";
import { EventHub } from "../src/events.js";
import { UnavailableRunCoordinator } from "../src/run-coordinator.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

describe("automation API validation", () => {
  it("rejects mismatched plans, foreign branches, and invalid varied configs before persistence", async () => {
    const dataDirectory = await mkdtemp(join(tmpdir(), "lathe-automation-api-"));
    directories.push(dataDirectory);
    const persistence = await createPersistence({ dataDirectory });
    const token = "automation-token";
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
      const project = await persistence.repository.createProject({ name: "Project" });
      const { session, branch } = await persistence.repository.createSession({ projectId: project.id, name: "Session" });
      const otherProject = await persistence.repository.createProject({ name: "Other" });
      const { branch: otherBranch } = await persistence.repository.createSession({ projectId: otherProject.id, name: "Other session" });

      const request = (value: unknown) => app.request("/api/automation", {
        method: "POST",
        headers,
        body: JSON.stringify(value)
      });
      expect((await request({
        projectId: project.id,
        sessionId: session.id,
        kind: "payload-fanout",
        plan: { pointer: "/payload", values: ["probe"], template: {} }
      })).status).toBe(400);
      expect((await request({
        projectId: project.id,
        sessionId: session.id,
        kind: "payload-fanout",
        plan: { payload: "probe", branchIds: [otherBranch.id] }
      })).status).toBe(422);
      expect((await request({
        projectId: project.id,
        sessionId: session.id,
        kind: "batch-vary",
        plan: {
          pointer: "/config/temperature",
          values: [3],
          template: { sourceBranchId: branch.id, payload: "probe", config: emptyResolvedConfig() }
        }
      })).status).toBe(422);
      expect((await request({
        projectId: project.id,
        sessionId: session.id,
        kind: "payload-fanout",
        concurrency: 2,
        plan: { payload: "probe", branchIds: [branch.id] }
      })).status).toBe(202);
      expect(await persistence.repository.listAutomationJobs(session.id)).toHaveLength(1);
    } finally {
      await persistence.repository.close();
    }
  });
});
