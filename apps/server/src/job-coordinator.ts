import { previewBatchVariation, previewPayloadFanout, runBoundedPool, type BatchVaryPlan, type PayloadFanoutPlan, type PoolProgress, type ReplayPlan } from "@lathe/automation";
import type { AutomationJob, BranchRef, JsonObject, JsonValue, ResolvedConfig } from "@lathe/domain";
import type { LatheRepository } from "@lathe/db";
import type { EventHub } from "./events.js";
import type { RunCoordinator } from "./run-coordinator.js";

export class JobCoordinator {
  private readonly controllers = new Map<string, AbortController>();

  constructor(private readonly repository: LatheRepository, private readonly runs: RunCoordinator, private readonly events: EventHub) {}

  start(job: AutomationJob, resume = false): void {
    if (this.controllers.has(job.id)) return;
    const controller = new AbortController();
    this.controllers.set(job.id, controller);
    void this.execute(job, controller, resume).finally(() => this.controllers.delete(job.id));
  }

  async resume(jobId: string): Promise<boolean> {
    if (this.controllers.has(jobId)) return false;
    const job = await this.repository.getAutomationJob(jobId);
    if (!job || !["paused", "interrupted"].includes(job.status)) return false;
    this.start(job, true);
    return true;
  }

  cancel(jobId: string): boolean {
    const controller = this.controllers.get(jobId);
    if (!controller) return false;
    controller.abort(new DOMException("Cancelled by operator", "AbortError"));
    return true;
  }

  private async execute(job: AutomationJob, controller: AbortController, resume: boolean): Promise<void> {
    await this.repository.updateAutomationJob(job.id, {
      status: "running",
      error: null,
      ...(resume ? {} : { progress: { completed: 0, failed: 0, results: [], failures: [], itemRuns: {} } })
    });
    this.events.publish(`job:${job.id}`, "job.started", { jobId: job.id });
    try {
      if (job.kind === "replay") await this.replay(job, controller.signal);
      else await this.parallel(job, controller.signal);
      if (controller.signal.aborted) {
        await this.repository.updateAutomationJob(job.id, { status: "cancelled" });
        this.events.publish(`job:${job.id}`, "job.cancelled", { jobId: job.id });
      } else {
        await this.repository.updateAutomationJob(job.id, { status: "completed" });
        this.events.publish(`job:${job.id}`, "job.completed", { jobId: job.id });
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const paused = /approval|required|awaiting-tool|run .* ended as (?:failed|interrupted|cancelled|tool-failure)/i.test(message);
      await this.repository.updateAutomationJob(job.id, {
        status: paused ? "paused" : controller.signal.aborted ? "cancelled" : "failed",
        error: { message }
      });
      this.events.publish(`job:${job.id}`, paused ? "job.paused" : "job.failed", { message });
    }
  }

  private async parallel(job: AutomationJob, signal: AbortSignal): Promise<void> {
    const allItems = job.kind === "payload-fanout"
      ? previewPayloadFanout(job.plan as PayloadFanoutPlan)
      : previewBatchVariation(job.plan as BatchVaryPlan);
    const storedJob = await this.repository.getAutomationJob(job.id);
    const priorProgress = storedJob?.progress ?? {};
    const priorResults = Array.isArray(priorProgress.results)
      ? priorProgress.results.filter((item): item is JsonObject => Boolean(item && typeof item === "object" && !Array.isArray(item) && typeof item.itemId === "string"))
      : [];
    const completedIds = new Set(priorResults.map((item) => String(item.itemId)));
    const itemRuns: JsonObject = priorProgress.itemRuns && typeof priorProgress.itemRuns === "object" && !Array.isArray(priorProgress.itemRuns)
      ? structuredClone(priorProgress.itemRuns) as JsonObject
      : {};
    const items = allItems.filter((item) => !completedIds.has(item.id));
    type CompletedItem = { runId: string; branchId: string };
    let latestProgress: PoolProgress<CompletedItem> = { completed: [], failed: [] };
    let progressWrite = Promise.resolve();
    let progressWriteError: unknown;
    const persistProgress = (current: PoolProgress<CompletedItem>): Promise<void> => {
      const progress = structuredClone(current);
      const results = [
        ...priorResults,
        ...progress.completed.map(({ item, value }) => ({ itemId: item.id, ...value }))
      ];
      const value: JsonObject = {
        completed: results.length,
        failed: progress.failed.length,
        total: allItems.length,
        results: results as unknown as JsonValue,
        failures: progress.failed.map(({ item, error }) => ({ itemId: item.id, error })) as unknown as JsonValue,
        itemRuns: structuredClone(itemRuns)
      };
      const write = progressWrite.then(async () => {
        await this.repository.updateAutomationJob(job.id, { progress: value });
        this.events.publish(`job:${job.id}`, "job.progress", value);
      });
      progressWrite = write.catch((error) => { progressWriteError ??= error; });
      return write;
    };
    const progress = await runBoundedPool(items, job.concurrency, async (item, itemSignal) => {
      if (itemSignal.aborted) throw itemSignal.reason;
      const existing = itemRuns[item.id];
      if (existing && typeof existing === "object" && !Array.isArray(existing) && typeof existing.runId === "string" && typeof existing.branchId === "string") {
        const run = await this.repository.getRun(existing.runId);
        if (run?.status === "completed") {
          if (run.classification === "tool-failure") throw new Error(`Run ${run.id} ended as tool-failure`);
          return { runId: existing.runId, branchId: existing.branchId };
        }
        if (run?.status === "awaiting-tool") throw new Error(`Run ${run.id} paused for tool approval`);
        if (run && ["queued", "streaming"].includes(run.status)) {
          const status = await this.waitForRun(run.id, itemSignal);
          if (status === "completed") {
            const completedRun = await this.repository.getRun(run.id);
            if (completedRun?.classification === "tool-failure") throw new Error(`Run ${run.id} ended as tool-failure`);
            return { runId: run.id, branchId: existing.branchId };
          }
          if (status === "awaiting-tool") throw new Error(`Run ${run.id} paused for tool approval`);
          throw new Error(`Run ${run.id} ended as ${status}`);
        }
      }
      const branchIdValue = item.input.branchId ?? item.input.sourceBranchId;
      if (typeof branchIdValue !== "string") throw new Error("Automation item requires branchId or sourceBranchId");
      let branchId = branchIdValue;
      if (job.kind === "batch-vary") {
        const branches = await this.repository.listBranches(job.sessionId);
        const source = branches.find((branch) => branch.id === branchIdValue);
        if (!source) throw new Error("Batch source branch not found");
        const branchName = `batch-${job.id.slice(-8)}-${item.index + 1}`;
        branchId = branches.find((candidate) => candidate.name === branchName)?.id
          ?? (await this.repository.createBranch(job.sessionId, branchName, source.headNodeId)).id;
      }
      const branches = await this.repository.listBranches(job.sessionId);
      const branch = branches.find((entry) => entry.id === branchId);
      if (!branch) throw new Error("Automation branch not found");
      const payload = typeof item.input.payload === "string" ? item.input.payload : JSON.stringify(item.input.payload ?? "");
      const config = item.input.config && typeof item.input.config === "object" && !Array.isArray(item.input.config)
        ? item.input.config as unknown as ResolvedConfig
        : undefined;
      const started = await this.runs.start({
        sessionId: job.sessionId,
        branchId,
        contextNodeId: branch.headNodeId,
        userMessage: payload,
        ...(config === undefined ? {} : { configOverride: config })
      });
      itemRuns[item.id] = { runId: started.id, branchId };
      await persistProgress(latestProgress);
      const status = await this.waitForRun(started.id, itemSignal);
      if (status === "awaiting-tool") throw new Error(`Run ${started.id} paused for tool approval`);
      if (status !== "completed") throw new Error(`Run ${started.id} ended as ${status}`);
      if ((await this.repository.getRun(started.id))?.classification === "tool-failure") throw new Error(`Run ${started.id} ended as tool-failure`);
      return { runId: started.id, branchId };
    }, {
      signal,
      stopOnError: true,
      onProgress: (progress) => {
        latestProgress = structuredClone(progress);
        void persistProgress(latestProgress);
      }
    });
    await progressWrite;
    if (progressWriteError) throw progressWriteError;
    if (progress.failed.length > 0) {
      throw new Error(progress.failed[0]?.error ?? "Automation item failed");
    }
  }

  private async replay(job: AutomationJob, signal: AbortSignal): Promise<void> {
    const plan = job.plan as ReplayPlan;
    let branch = (await this.repository.listBranches(job.sessionId)).find((item) => item.id === plan.destinationBranchId);
    if (!branch) throw new Error("Replay destination branch not found");
    const storedJob = await this.repository.getAutomationJob(job.id);
    const storedProgress = storedJob?.progress ?? {};
    let lastRunId = typeof storedProgress.lastRunId === "string" ? storedProgress.lastRunId : null;
    let completed = typeof storedProgress.completed === "number" && Number.isInteger(storedProgress.completed) ? storedProgress.completed : 0;
    for (const step of plan.steps.slice(completed)) {
      if (signal.aborted) throw signal.reason;
      const activeBranch: BranchRef | undefined = branch;
      if (!activeBranch) throw new Error("Replay destination branch disappeared");
      if (step.kind === "user") {
        const text = step.parts.filter((part) => part.type === "text").map((part) => part.text).join("\n");
        const started = await this.runs.start({ sessionId: job.sessionId, branchId: activeBranch.id, contextNodeId: activeBranch.headNodeId, userMessage: text });
        lastRunId = started.id;
        const status = await this.waitForRun(started.id, signal);
        if (status !== "completed" && status !== "awaiting-tool") throw new Error(`Replay run ended as ${status}`);
      } else {
        if (!lastRunId) throw new Error("Replay tool result has no preceding model run");
        for (const part of step.parts) {
          if (part.type === "tool-result") await this.runs.resolveToolCall(lastRunId, part.callId, { result: part.result, isError: part.isError });
        }
      }
      completed += 1;
      branch = (await this.repository.listBranches(job.sessionId)).find((item) => item.id === activeBranch.id);
      await this.repository.updateAutomationJob(job.id, { progress: { completed, total: plan.steps.length, lastRunId } });
      this.events.publish(`job:${job.id}`, "job.progress", { completed, total: plan.steps.length, lastRunId });
    }
    if (lastRunId) {
      const lastRun = await this.repository.getRun(lastRunId);
      if (lastRun?.status === "awaiting-tool") throw new Error(`Run ${lastRun.id} paused for tool approval`);
      if (lastRun?.classification === "tool-failure") throw new Error(`Run ${lastRun.id} ended as tool-failure`);
      if (lastRun && lastRun.status !== "completed") throw new Error(`Replay run ended as ${lastRun.status}`);
    }
  }

  private async waitForRun(runId: string, signal: AbortSignal): Promise<string> {
    if (signal.aborted) {
      await this.runs.cancel(runId);
      throw signal.reason;
    }
    while (!signal.aborted) {
      const run = await this.repository.getRun(runId);
      if (!run) throw new Error("Automation run disappeared");
      if (!["queued", "streaming"].includes(run.status)) return run.status;
      await new Promise<void>((resolve, reject) => {
        const abort = () => {
          clearTimeout(timer);
          void this.runs.cancel(runId).finally(() => reject(signal.reason));
        };
        const timer = setTimeout(() => {
          signal.removeEventListener("abort", abort);
          resolve();
        }, 100);
        signal.addEventListener("abort", abort, { once: true });
      });
    }
    throw signal.reason;
  }
}
