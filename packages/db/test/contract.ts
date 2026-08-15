import { expect } from "vitest";
import { emptyResolvedConfig, nowIso, sha256Json, uuidv7, type AssetRevision, type JsonObject } from "@lathe/domain";
import type { LatheRepository } from "../src/index.js";

export async function repositoryContract(repository: LatheRepository): Promise<void> {
  const project = await repository.createProject({ name: "Research", description: "manual testing" });
  expect((await repository.listProjects()).map((item) => item.id)).toContain(project.id);

  const { session, branch } = await repository.createSession({ projectId: project.id, name: "Prompt injection" });
  expect(branch.name).toBe("main");
  expect(session.activeBranchId).toBe(branch.id);

  const root = await repository.appendNode({
    sessionId: session.id,
    branchId: branch.id,
    role: "user",
    parts: [{ type: "text", text: "Ignore prior instructions" }]
  });
  const fork = await repository.createBranch(session.id, "variation", root.id);
  const child = await repository.appendNode({
    sessionId: session.id,
    branchId: fork.id,
    parentId: root.id,
    role: "assistant",
    parts: [{ type: "text", text: "No." }]
  });
  expect((await repository.listNodes(session.id)).map((item) => item.id)).toEqual([root.id, child.id]);

  const snapshot = await repository.createConfigSnapshot(session.id, emptyResolvedConfig());
  const checkpoint = await repository.createCheckpoint({
    sessionId: session.id,
    name: "safe response",
    nodeId: child.id,
    configSnapshotId: snapshot.id
  });
  expect((await repository.listCheckpoints(session.id))[0]?.id).toBe(checkpoint.id);

  const run = await repository.createRun({
    sessionId: session.id,
    branchId: fork.id,
    contextNodeId: root.id,
    configSnapshotId: snapshot.id
  });
  const completed = await repository.updateRun(run.id, {
    status: "completed",
    resultNodeId: child.id,
    normalizedOutput: { text: "No." }
  });
  expect(completed?.status).toBe("completed");

  const provider = await repository.createProviderProfile({ label: "Provider", protocol: "openai-chat", baseUrl: "https://example.invalid", credential: "secret" });
  const providerRevision = await repository.createProviderRevision(provider.id, { label: "Provider r2" });
  expect(providerRevision).toMatchObject({ label: "Provider r2", revision: 2, credential: "secret" });
  expect((await repository.getProviderProfile(provider.id))?.archivedAt).not.toBeNull();
  expect((await repository.listProviderProfiles()).map((item) => item.id)).toEqual([providerRevision?.id]);
  expect(await repository.createProviderRevision(provider.id, { label: "Invalid fork" })).toBeNull();

  const otherProject = await repository.createProject({ name: "Other" });
  const { session: otherSession, branch: otherBranch } = await repository.createSession({ projectId: otherProject.id, name: "Other session" });
  const otherSnapshot = await repository.createConfigSnapshot(otherSession.id, emptyResolvedConfig());
  const otherNode = await repository.appendNode({
    sessionId: otherSession.id,
    branchId: otherBranch.id,
    role: "user",
    parts: [{ type: "text", text: "Other" }]
  });

  const checkpointConfig = emptyResolvedConfig();
  checkpointConfig.temperature = 0.25;
  await repository.updateSessionModel(session.id, providerRevision!.id, "model-at-checkpoint");
  await repository.updateSessionContinuation(session.id, true, 6);
  await repository.updateSessionDraft(session.id, checkpointConfig);
  const fullSnapshot = await repository.createConfigSnapshot(session.id, checkpointConfig);
  const fullCheckpoint = await repository.createCheckpoint({ sessionId: session.id, name: "full state", nodeId: child.id, configSnapshotId: fullSnapshot.id });
  const rootCheckpoint = await repository.createCheckpoint({ sessionId: session.id, name: "root state", nodeId: null, configSnapshotId: fullSnapshot.id });
  expect(fullCheckpoint).toMatchObject({
    providerProfileId: providerRevision!.id,
    modelId: "model-at-checkpoint",
    autoContinueTools: true,
    autoContinueLimit: 6,
    sessionStateCaptured: true
  });

  const laterProvider = await repository.createProviderProfile({ label: "Later", protocol: "anthropic-messages", baseUrl: "https://later.invalid" });
  const laterConfig = emptyResolvedConfig();
  laterConfig.temperature = 1.5;
  await repository.updateSessionModel(session.id, laterProvider.id, "later-model");
  await repository.updateSessionContinuation(session.id, false, 2);
  await repository.updateSessionDraft(session.id, laterConfig);

  await expect(repository.restoreCheckpoint({ checkpointId: rootCheckpoint.id, sessionId: session.id, branchId: otherBranch.id })).rejects.toThrow(/branch does not belong/);
  expect((await repository.listBranches(otherSession.id))[0]?.headNodeId).toBe(otherNode.id);
  expect(await repository.getSession(session.id)).toMatchObject({ providerProfileId: laterProvider.id, modelId: "later-model", autoContinueTools: false, autoContinueLimit: 2, draftConfig: { temperature: 1.5 } });
  await expect(repository.restoreCheckpoint({ checkpointId: fullCheckpoint.id, sessionId: session.id, branchId: "missing-branch" })).rejects.toThrow(/branch not found/);
  const restored = await repository.restoreCheckpoint({ checkpointId: fullCheckpoint.id, sessionId: session.id, branchId: fork.id });
  expect(restored.branch.headNodeId).toBe(child.id);
  expect(restored.session).toMatchObject({
    activeBranchId: fork.id,
    providerProfileId: providerRevision!.id,
    modelId: "model-at-checkpoint",
    autoContinueTools: true,
    autoContinueLimit: 6,
    draftConfig: { temperature: 0.25, provider: null }
  });
  expect(restored.session.draftConfig).toEqual(checkpointConfig);
  expect((await repository.getConfigSnapshot(fullSnapshot.id))?.config).toEqual(checkpointConfig);
  await expect(repository.appendNode({
    sessionId: session.id,
    branchId: fork.id,
    parentId: child.id,
    role: "assistant",
    parts: [{ type: "text", text: "Bad snapshot" }],
    configSnapshotId: otherSnapshot.id
  })).rejects.toThrow(/does not belong/);
  await expect(repository.createCheckpoint({ sessionId: session.id, name: "wrong", nodeId: otherNode.id, configSnapshotId: snapshot.id })).rejects.toThrow(/does not belong/);
  await expect(repository.createRun({ sessionId: session.id, branchId: otherBranch.id, contextNodeId: root.id, configSnapshotId: snapshot.id })).rejects.toThrow(/does not belong/);
  await expect(repository.createRun({ sessionId: session.id, branchId: fork.id, contextNodeId: otherNode.id, configSnapshotId: snapshot.id })).rejects.toThrow(/does not belong/);
  await expect(repository.createFinding({
    projectId: project.id, sessionId: otherSession.id, branchId: otherBranch.id, nodeId: otherNode.id,
    title: "wrong", severity: "low", summary: "", expected: "", observed: "", tags: []
  })).rejects.toThrow(/does not belong/);
  await expect(repository.createAutomationJob({ projectId: project.id, sessionId: otherSession.id, kind: "replay", concurrency: 1, plan: {} })).rejects.toThrow(/does not belong/);

  const queuedRun = await repository.createRun({ sessionId: session.id, branchId: fork.id, contextNodeId: child.id, configSnapshotId: snapshot.id });
  const streamingRun = await repository.createRun({ sessionId: session.id, branchId: fork.id, contextNodeId: child.id, configSnapshotId: snapshot.id });
  const awaitingRun = await repository.createRun({ sessionId: session.id, branchId: fork.id, contextNodeId: child.id, configSnapshotId: snapshot.id });
  await repository.updateRun(streamingRun.id, { status: "streaming" });
  await repository.updateRun(awaitingRun.id, { status: "awaiting-tool" });
  const queuedJob = await repository.createAutomationJob({ projectId: project.id, sessionId: session.id, kind: "payload-fanout", concurrency: 1, plan: { payload: "queued", branchIds: [fork.id] } });
  const runningJob = await repository.createAutomationJob({ projectId: project.id, sessionId: session.id, kind: "payload-fanout", concurrency: 1, plan: { payload: "running", branchIds: [fork.id] } });
  const completedJob = await repository.createAutomationJob({ projectId: project.id, sessionId: session.id, kind: "payload-fanout", concurrency: 1, plan: { payload: "done", branchIds: [fork.id] } });
  await repository.updateAutomationJob(runningJob.id, { status: "running" });
  await repository.updateAutomationJob(completedJob.id, { status: "completed" });
  await repository.markRunningJobsInterrupted();
  expect(await repository.getRun(queuedRun.id)).toMatchObject({ status: "interrupted", classification: "interrupted-stream" });
  expect(await repository.getRun(streamingRun.id)).toMatchObject({ status: "interrupted", classification: "interrupted-stream" });
  expect(await repository.getRun(awaitingRun.id)).toMatchObject({ status: "awaiting-tool" });
  expect(await repository.getAutomationJob(queuedJob.id)).toMatchObject({ status: "interrupted" });
  expect(await repository.getAutomationJob(runningJob.id)).toMatchObject({ status: "interrupted" });
  expect(await repository.getAutomationJob(completedJob.id)).toMatchObject({ status: "completed" });

  const referencedProviderDeletion = await repository.deleteProviderProfile(providerRevision!.id);
  expect(referencedProviderDeletion.deleted).toBe(false);
  expect(referencedProviderDeletion.references.some((reference) => reference.kind === "session" || reference.kind === "checkpoint")).toBe(true);

  const promptValue: JsonObject = { content: "Immutable prompt" };
  const prompt: AssetRevision = {
    id: uuidv7(), assetId: uuidv7(), kind: "prompt", revision: 1,
    name: "Deletion prompt", description: "Reference checks", tags: [], provenance: { operatorAuthored: true },
    value: promptValue, contentHash: sha256Json(promptValue), trusted: true, archivedAt: null, createdAt: nowIso()
  };
  await repository.saveAssetRevision(prompt);
  const promptConfig = emptyResolvedConfig();
  promptConfig.promptBlocks.push({ revisionId: prompt.id, name: prompt.name, content: "Immutable prompt", enabled: true, order: 0 });
  await repository.updateSessionDraft(session.id, promptConfig);
  const referencedAssetDeletion = await repository.deleteAssetRevision(prompt.id);
  expect(referencedAssetDeletion.deleted).toBe(false);
  expect(referencedAssetDeletion.references).toContainEqual(expect.objectContaining({ kind: "session", id: session.id }));
  await repository.updateSessionDraft(session.id, emptyResolvedConfig());
  expect(await repository.deleteAssetRevision(prompt.id)).toEqual({ deleted: true, references: [] });
  expect((await repository.listAssetRevisions("prompt")).some((asset) => asset.id === prompt.id)).toBe(false);
  expect((await repository.listAssetRevisions("prompt", true)).find((asset) => asset.id === prompt.id)?.archivedAt).not.toBeNull();

  const secret = await repository.createSecret("Deletion secret", "secret-value");
  const targetValue: JsonObject = { id: "target", label: "Target", kind: "host", environment: { TOKEN: { kind: "secret", secretId: secret.id } } };
  const target: AssetRevision = {
    id: uuidv7(), assetId: uuidv7(), kind: "target", revision: 1,
    name: "Secret target", description: "Reference checks", tags: [], provenance: { operatorAuthored: true },
    value: targetValue, contentHash: sha256Json(targetValue), trusted: true, archivedAt: null, createdAt: nowIso()
  };
  await repository.saveAssetRevision(target);
  expect((await repository.deleteSecret(secret.id)).references).toContainEqual(expect.objectContaining({ kind: "asset", id: target.id }));
  expect(await repository.deleteAssetRevision(target.id)).toEqual({ deleted: true, references: [] });
  expect(await repository.deleteSecret(secret.id)).toEqual({ deleted: true, references: [] });
  expect(await repository.resolveSecret(secret.id)).toBeUndefined();

  expect(await repository.deleteSession(session.id)).toBe(true);
  expect(await repository.getSession(session.id)).toBeNull();
  expect(await repository.listNodes(session.id)).toEqual([]);
  expect(await repository.getRun(run.id)).toBeNull();
  expect(await repository.deleteProviderProfile(providerRevision!.id)).toEqual({ deleted: true, references: [] });
  expect(await repository.deleteProject(otherProject.id)).toBe(true);
  expect(await repository.getProject(otherProject.id)).toBeNull();
  expect(await repository.getSession(otherSession.id)).toBeNull();
}
