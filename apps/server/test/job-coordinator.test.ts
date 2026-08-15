import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistence, type LatheRepository } from "@lathe/db";
import { EventHub } from "../src/events.js";
import { JobCoordinator } from "../src/job-coordinator.js";
import type { RunCoordinator, StartedRun, StartRunInput } from "../src/run-coordinator.js";

const directories: string[] = [];
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

class FixtureRuns implements RunCoordinator {
  starts = 0;
  constructor(private readonly repository: LatheRepository, private readonly result: "completed" | "failed" | "awaiting-tool") {}

  async start(input: StartRunInput): Promise<StartedRun> {
    this.starts += 1;
    const session = await this.repository.getSession(input.sessionId);
    if (!session) throw new Error("missing fixture session");
    const snapshot = await this.repository.createConfigSnapshot(session.id, input.configOverride ?? session.draftConfig);
    const run = await this.repository.createRun({
      sessionId: input.sessionId,
      branchId: input.branchId,
      contextNodeId: input.contextNodeId,
      configSnapshotId: snapshot.id,
    });
    await this.repository.updateRun(run.id, { status: this.result });
    return { id: run.id, status: "queued" };
  }

  async cancel(): Promise<boolean> { return true; }
  async resolveToolCall(): Promise<void> {}
  async resolveMcpApproval(): Promise<void> {}
}

async function waitForJob(repository: LatheRepository, sessionId: string, status: string): Promise<void> {
  const deadline = Date.now() + 2_000;
  while (Date.now() < deadline) {
    if ((await repository.listAutomationJobs(sessionId))[0]?.status === status) return;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${status} job`);
}

describe("automation job coordinator", () => {
  it("finishes successful fanout and pauses failed work instead of reporting completion", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lathe-job-"));
    directories.push(directory);
    const persistence = await createPersistence({ dataDirectory: directory });
    try {
      const project = await persistence.repository.createProject({ name: "Project" });
      const { session, branch } = await persistence.repository.createSession({ projectId: project.id, name: "Session" });
      const successful = await persistence.repository.createAutomationJob({
        projectId: project.id,
        sessionId: session.id,
        kind: "payload-fanout",
        concurrency: 3,
        plan: { payload: "probe", branchIds: [branch.id] },
      });
      new JobCoordinator(persistence.repository, new FixtureRuns(persistence.repository, "completed"), new EventHub()).start(successful);
      await waitForJob(persistence.repository, session.id, "completed");

      const failed = await persistence.repository.createAutomationJob({
        projectId: project.id,
        sessionId: session.id,
        kind: "payload-fanout",
        concurrency: 1,
        plan: { payload: "probe", branchIds: [branch.id] },
      });
      new JobCoordinator(persistence.repository, new FixtureRuns(persistence.repository, "failed"), new EventHub()).start(failed);
      await waitForJob(persistence.repository, session.id, "paused");
      expect((await persistence.repository.listAutomationJobs(session.id)).find((job) => job.id === failed.id)?.error).toMatchObject({ message: expect.stringContaining("ended as failed") });
    } finally {
      await persistence.repository.close();
    }
  });

  it("pauses rather than completing when an item awaits approval", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lathe-job-approval-"));
    directories.push(directory);
    const persistence = await createPersistence({ dataDirectory: directory });
    try {
      const project = await persistence.repository.createProject({ name: "Project" });
      const { session, branch } = await persistence.repository.createSession({ projectId: project.id, name: "Session" });
      const job = await persistence.repository.createAutomationJob({
        projectId: project.id,
        sessionId: session.id,
        kind: "payload-fanout",
        concurrency: 1,
        plan: { payload: "probe", branchIds: [branch.id] },
      });
      const runs = new FixtureRuns(persistence.repository, "awaiting-tool");
      const coordinator = new JobCoordinator(persistence.repository, runs, new EventHub());
      coordinator.start(job);
      await waitForJob(persistence.repository, session.id, "paused");
      const paused = await persistence.repository.getAutomationJob(job.id);
      const itemRuns = paused?.progress.itemRuns as Record<string, { runId: string }>;
      const runId = Object.values(itemRuns)[0]?.runId;
      expect(runId).toBeTruthy();
      await persistence.repository.updateRun(runId!, { status: "completed" });
      expect(await coordinator.resume(job.id)).toBe(true);
      await waitForJob(persistence.repository, session.id, "completed");
      expect(runs.starts).toBe(1);
      expect(await persistence.repository.getAutomationJob(job.id)).toMatchObject({ progress: { completed: 1, total: 1 } });
    } finally {
      await persistence.repository.close();
    }
  });

  it("serializes concurrent progress writes and retains every completed item", async () => {
    const directory = await mkdtemp(join(tmpdir(), "lathe-job-progress-"));
    directories.push(directory);
    const persistence = await createPersistence({ dataDirectory: directory });
    try {
      const project = await persistence.repository.createProject({ name: "Project" });
      const { session, branch } = await persistence.repository.createSession({ projectId: project.id, name: "Session" });
      const branches = [
        branch,
        await persistence.repository.createBranch(session.id, "two", null),
        await persistence.repository.createBranch(session.id, "three", null),
        await persistence.repository.createBranch(session.id, "four", null)
      ];
      const originalUpdate = persistence.repository.updateAutomationJob.bind(persistence.repository);
      let activeProgressWrites = 0;
      let maximumProgressWrites = 0;
      persistence.repository.updateAutomationJob = async (id, patch) => {
        if (patch.progress !== undefined) {
          activeProgressWrites += 1;
          maximumProgressWrites = Math.max(maximumProgressWrites, activeProgressWrites);
          await new Promise((resolve) => setTimeout(resolve, 5));
        }
        try {
          return await originalUpdate(id, patch);
        } finally {
          if (patch.progress !== undefined) activeProgressWrites -= 1;
        }
      };
      const job = await persistence.repository.createAutomationJob({
        projectId: project.id,
        sessionId: session.id,
        kind: "payload-fanout",
        concurrency: 3,
        plan: { payload: "probe", branchIds: branches.map((item) => item.id) }
      });
      new JobCoordinator(persistence.repository, new FixtureRuns(persistence.repository, "completed"), new EventHub()).start(job);
      await waitForJob(persistence.repository, session.id, "completed");
      expect(maximumProgressWrites).toBe(1);
      expect(await persistence.repository.getAutomationJob(job.id)).toMatchObject({
        progress: { completed: 4, failed: 0, total: 4 }
      });
    } finally {
      await persistence.repository.close();
    }
  });
});
