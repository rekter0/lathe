import { extname } from "node:path";
import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { z } from "zod";
import { exportFindingArtifact, exportHarnessArtifact, importArtifact, type ArtifactFileInput } from "@lathe/artifacts";
import {
  jsonValueSchema,
  messagePartSchema,
  nowIso,
  pathToRoot,
  resolvedConfigSchema,
  sha256Json,
  uuidv7,
  type AssetRevision,
  type ConfigSnapshot,
  type Finding,
  type JsonObject,
  type JsonValue,
  type MessageNode,
  type ModelRun,
  type ResolvedConfig
} from "@lathe/domain";
import type { ContentStore, LatheRepository } from "@lathe/db";
import {
  UnsafeAssetCredentialError,
  assertSafeAssetCredentials,
  assetCredentialValues,
  sanitizeAssetRevision
} from "./security.js";

const bytesResponse = (bytes: Uint8Array, fileName: string) => new Response(
  bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength) as ArrayBuffer,
  { headers: { "Content-Type": "application/zip", "Content-Disposition": `attachment; filename="${fileName}"`, "X-Content-Type-Options": "nosniff" } }
);

function safeExtension(fileName: string): string {
  const extension = extname(fileName).toLowerCase();
  return /^\.[a-z0-9]{1,10}$/.test(extension) ? extension : ".bin";
}

const assetRevisionSchema = z.object({
  id: z.string().min(1),
  assetId: z.string().min(1),
  kind: z.enum(["prompt", "tool-spec", "tool-implementation", "harness", "target", "mcp-server"]),
  revision: z.number().int().positive(),
  name: z.string().min(1).max(500),
  description: z.string().max(100_000),
  tags: z.array(z.string().max(1_000)).max(10_000),
  provenance: z.record(z.string(), jsonValueSchema),
  value: jsonValueSchema,
  contentHash: z.string().regex(/^[a-f0-9]{64}$/),
  trusted: z.boolean(),
  archivedAt: z.string().nullable(),
  createdAt: z.string().min(1)
});

const transcriptSchema = z.array(z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  parentId: z.string().nullable(),
  role: z.enum(["user", "assistant", "tool"]),
  parts: z.array(messagePartSchema).min(1).max(10_000),
  sourceRunId: z.string().nullable(),
  configSnapshotId: z.string().nullable(),
  createdAt: z.string().min(1)
})).max(100_000);

const isoDateSchema = z.string().min(1).refine((value) => !Number.isNaN(Date.parse(value)), "Invalid timestamp");
const sha256Schema = z.string().regex(/^[a-f0-9]{64}$/);
const configSnapshotSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  config: resolvedConfigSchema,
  contentHash: sha256Schema,
  createdAt: isoDateSchema
});
const configSnapshotsSchema = z.array(configSnapshotSchema).max(100_000);
const modelRunSchema = z.object({
  id: z.string().min(1),
  sessionId: z.string().min(1),
  branchId: z.string().min(1),
  contextNodeId: z.string().nullable(),
  resultNodeId: z.string().nullable(),
  configSnapshotId: z.string().min(1),
  status: z.enum(["queued", "streaming", "awaiting-tool", "completed", "failed", "cancelled", "interrupted"]),
  classification: z.enum(["transport", "authentication", "rate-limit", "invalid-request", "content-policy", "unavailable", "timeout", "parse-failure", "interrupted-stream", "cancelled", "tool-failure", "unknown"]).nullable(),
  operatorLabel: z.string().max(120).nullable(),
  operatorNotes: z.string().max(20_000).nullable(),
  normalizedOutput: jsonValueSchema.nullable(),
  usage: z.record(z.string(), jsonValueSchema).nullable(),
  traceHash: sha256Schema.nullable(),
  startedAt: isoDateSchema.nullable(),
  finishedAt: isoDateSchema.nullable(),
  createdAt: isoDateSchema
});
const modelRunsSchema = z.array(modelRunSchema).max(100_000);
const missingEvidenceSchema = z.object({ hashes: z.array(sha256Schema).max(100_000) });

function parseArtifactJson<T>(data: Uint8Array, schema: z.ZodType<T>, label: string): T {
  let value: unknown;
  try { value = JSON.parse(new TextDecoder().decode(data)); } catch { throw new HTTPException(422, { message: `${label} is not valid JSON` }); }
  const result = schema.safeParse(value);
  if (!result.success) throw new HTTPException(422, { message: `${label} has a malformed schema` });
  return result.data;
}

function assertUniqueIds(values: readonly { id: string }[], label: string): void {
  const ids = new Set<string>();
  for (const value of values) {
    if (ids.has(value.id)) throw new HTTPException(422, { message: `${label} contains duplicate id ${value.id}` });
    ids.add(value.id);
  }
}

function validateImportedAssetCredentials(asset: AssetRevision, label: string): void {
  try {
    assertSafeAssetCredentials(asset.kind, asset.value);
  } catch (error) {
    if (error instanceof UnsafeAssetCredentialError) {
      throw new HTTPException(422, { message: `${label} contains unsafe inline credentials: ${error.message}` });
    }
    throw error;
  }
}

function rewrittenRevisionId(revisions: ReadonlyMap<string, string>, sourceId: string, label: string): string {
  const rewritten = revisions.get(sourceId);
  if (!rewritten) throw new HTTPException(422, { message: `Finding bundle is missing referenced ${label} revision ${sourceId}` });
  return rewritten;
}

function rewriteConfigReferences(config: ResolvedConfig, revisions: ReadonlyMap<string, string>): ResolvedConfig {
  return {
    ...structuredClone(config),
    promptBlocks: config.promptBlocks.map((block) => ({
      ...block,
      revisionId: rewrittenRevisionId(revisions, block.revisionId, "prompt")
    })),
    tools: config.tools.map((tool) => ({
      ...tool,
      toolRevisionId: rewrittenRevisionId(revisions, tool.toolRevisionId, "tool"),
      implementationRevisionId: tool.implementationRevisionId === null
        ? null
        : rewrittenRevisionId(revisions, tool.implementationRevisionId, "tool implementation"),
      targetId: tool.targetId === null ? null : rewrittenRevisionId(revisions, tool.targetId, "execution target"),
      mcpServerId: tool.mcpServerId === null ? null : rewrittenRevisionId(revisions, tool.mcpServerId, "MCP server")
    }))
  };
}

function rewriteEvidenceReferences(
  value: JsonValue,
  storedHashes: ReadonlyMap<string, string>,
  declaredMissing: ReadonlySet<string>,
  key = ""
): JsonValue {
  if (typeof value === "string" && /(?:traceHash|rawResultHash)$/i.test(key) && /^[a-f0-9]{64}$/.test(value)) {
    const rewritten = storedHashes.get(value);
    if (rewritten) return rewritten;
    if (declaredMissing.has(value)) return null;
    throw new HTTPException(422, { message: `Finding run references evidence ${value} that is absent from the bundle` });
  }
  if (Array.isArray(value)) return value.map((item) => rewriteEvidenceReferences(item, storedHashes, declaredMissing, key));
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([childKey, item]) => [childKey, rewriteEvidenceReferences(item, storedHashes, declaredMissing, childKey)]));
  }
  return value;
}

function expectedAssetKind(path: string, role: string): AssetRevision["kind"] | "reference" | null {
  if (role === "prompt") return "prompt";
  if (role === "tool-spec") return "tool-spec";
  if (role === "tool-script") return "tool-implementation";
  if (path.startsWith("config/references/")) return "reference";
  return null;
}

function referenceIdsFromConfig(value: JsonValue, output: Set<string>): void {
  if (!value || typeof value !== "object" || Array.isArray(value)) return;
  const prompts = Array.isArray(value.promptBlocks) ? value.promptBlocks : [];
  const tools = Array.isArray(value.tools) ? value.tools : [];
  for (const prompt of prompts) if (prompt && typeof prompt === "object" && !Array.isArray(prompt) && typeof prompt.revisionId === "string") output.add(prompt.revisionId);
  for (const tool of tools) {
    if (!tool || typeof tool !== "object" || Array.isArray(tool)) continue;
    for (const key of ["toolRevisionId", "implementationRevisionId", "targetId", "mcpServerId"]) if (typeof tool[key] === "string") output.add(tool[key]);
  }
}

function evidenceHashes(value: JsonValue, output: Map<string, string>, key = ""): void {
  if (typeof value === "string" && /(?:traceHash|rawResultHash)$/i.test(key) && /^[a-f0-9]{64}$/.test(value)) {
    output.set(value, /rawResultHash$/i.test(key) ? "application/json" : "application/x-ndjson");
  }
  else if (Array.isArray(value)) value.forEach((item) => evidenceHashes(item, output, key));
  else if (value && typeof value === "object") for (const [childKey, item] of Object.entries(value)) evidenceHashes(item, output, childKey);
}

function artifactAssetPath(asset: AssetRevision): { path: string; role: "prompt" | "tool-spec" | "tool-script" | "config"; script?: true } {
  if (asset.kind === "prompt") return { path: `prompts/${asset.id}.json`, role: "prompt" };
  if (asset.kind === "tool-spec") return { path: `tools/specs/${asset.id}.json`, role: "tool-spec" };
  if (asset.kind === "tool-implementation") return { path: `tools/implementations/${asset.id}.json`, role: "tool-script", script: true };
  return { path: `config/references/${asset.id}.json`, role: "config" };
}

async function allSecrets(repository: LatheRepository): Promise<string[]> {
  // Historical runs and artifacts can still reference superseded provider
  // revisions, so export redaction must include archived credentials too.
  const providers = await repository.listProviderProfiles(true);
  const values = providers.flatMap((profile) => [profile.credential, ...Object.values(profile.headers)]);
  const sensitive = /authorization|api[-_]?key|token|secret|password|credential|cookie/i;
  const symbolicReference = /(?:id|ref|reference|name)$/i;
  const collect = (value: JsonValue, key = "") => {
    if (typeof value === "string" && sensitive.test(key) && !symbolicReference.test(key)) values.push(value);
    else if (Array.isArray(value)) value.forEach((item) => collect(item, key));
    else if (value && typeof value === "object") for (const [childKey, item] of Object.entries(value)) collect(item, childKey);
  };
  for (const profile of providers) {
    collect(profile.extraBody);
    for (const urlValue of [profile.baseUrl, profile.endpointOverride]) {
      if (!urlValue) continue;
      try {
        const url = new URL(urlValue);
        for (const value of [url.username, url.password]) {
          if (!value) continue;
          try { values.push(decodeURIComponent(value)); } catch { values.push(value); }
        }
        for (const [name, value] of url.searchParams) if (sensitive.test(name)) values.push(value);
      } catch {
        // Invalid legacy URLs are rejected on use; other known values are still scrubbed.
      }
    }
  }
  for (const asset of await repository.listAssetRevisions()) {
    collect(asset.value);
    values.push(...assetCredentialValues(asset));
  }
  for (const secret of await repository.listSecrets()) {
    const value = await repository.resolveSecret(secret.id);
    if (value) values.push(value);
  }
  return [...new Set(values.filter((value) => value.length >= 4))];
}

export function registerArtifactRoutes(app: Hono, repository: LatheRepository, contentStore: ContentStore): void {
  app.get("/api/harnesses/:id/export", async (context) => {
    const assets = await repository.listAssetRevisions();
    const harness = assets.find((asset) => asset.id === context.req.param("id") && asset.kind === "harness");
    if (!harness) throw new HTTPException(404, { message: "Harness revision not found" });
    const referencedIds = new Set<string>();
    const value = harness.value as JsonObject;
    for (const binding of [...(Array.isArray(value.promptBindings) ? value.promptBindings : []), ...(Array.isArray(value.toolBindings) ? value.toolBindings : [])]) {
      if (!binding || typeof binding !== "object" || Array.isArray(binding)) continue;
      for (const key of ["revisionId", "implementationRevisionId", "targetId", "mcpServerId"]) {
        if (typeof binding[key] === "string") referencedIds.add(binding[key]);
      }
    }
    const referenced = assets.filter((asset) => referencedIds.has(asset.id));
    const files: ArtifactFileInput[] = [
      { path: "config/harness.json", data: JSON.stringify(harness), role: "config", mediaType: "application/json" },
      ...referenced.map((asset) => ({
        path: `${asset.kind === "prompt" ? "prompts" : asset.kind === "tool-spec" ? "tools/specs" : asset.kind === "tool-implementation" ? "tools/implementations" : "config/references"}/${asset.id}.json`,
        data: JSON.stringify(sanitizeAssetRevision(asset)),
        role: (asset.kind === "prompt" ? "prompt" : asset.kind === "tool-spec" ? "tool-spec" : asset.kind === "tool-implementation" ? "tool-script" : "config") as "prompt" | "tool-spec" | "tool-script" | "config",
        mediaType: "application/json",
        ...(asset.kind === "tool-implementation" ? { script: true } : {})
      }))
    ];
    const archive = exportHarnessArtifact({
      artifactId: harness.id,
      generatorVersion: "0.1.0",
      metadata: { name: harness.name, revision: harness.revision, provenance: harness.provenance },
      summaryMarkdown: `# ${harness.name}\n\n${harness.description}\n\nExported from Lathe at ${nowIso()}.\n`,
      files,
      secretValues: await allSecrets(repository)
    });
    return bytesResponse(archive, `${harness.name.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}.lathe-harness`);
  });

  app.get("/api/findings/:id/export", async (context) => {
    const projectId = context.req.query("projectId");
    if (!projectId) throw new HTTPException(400, { message: "projectId is required" });
    const finding = (await repository.listFindings(projectId)).find((item) => item.id === context.req.param("id"));
    if (!finding) throw new HTTPException(404, { message: "Finding not found" });
    const [session, nodes, branches, runs] = await Promise.all([
      repository.getSession(finding.sessionId), repository.listNodes(finding.sessionId), repository.listBranches(finding.sessionId), repository.listRuns(finding.sessionId)
    ]);
    const branch = branches.find((item) => item.id === finding.branchId);
    if (!session || !branch) throw new HTTPException(409, { message: "Finding session or branch is missing" });
    const leafId = finding.nodeId ?? branch.headNodeId;
    const path = pathToRoot(nodes, leafId);
    const pathIds = new Set(path.map((node) => node.id));
    const relevantRuns = runs.filter((run) => (run.resultNodeId && pathIds.has(run.resultNodeId)) || (run.contextNodeId && pathIds.has(run.contextNodeId)));
    const snapshotIds = new Set(relevantRuns.map((run) => run.configSnapshotId));
    for (const node of path) if (node.configSnapshotId) snapshotIds.add(node.configSnapshotId);
    const snapshots = await Promise.all(Array.from(snapshotIds).map((id) => repository.getConfigSnapshot(id)));
    const referencedIds = new Set<string>();
    for (const snapshot of snapshots) if (snapshot) referenceIdsFromConfig(snapshot.config as unknown as JsonValue, referencedIds);
    const referencedAssets = (await repository.listAssetRevisions()).filter((asset) => referencedIds.has(asset.id));
    const attachmentIds = new Set(path.flatMap((node) => node.parts.filter((part) => part.type === "attachment").map((part) => part.attachmentId)));
    const attachments = (await repository.listAttachments(projectId)).filter((attachment) => attachmentIds.has(attachment.id));
    const files: ArtifactFileInput[] = [
      { path: "transcript/branch.json", data: JSON.stringify(path), role: "transcript", mediaType: "application/json" },
      { path: "config/snapshots.json", data: JSON.stringify(snapshots.filter(Boolean)), role: "config", mediaType: "application/json" },
      { path: "traces/runs.json", data: JSON.stringify(relevantRuns), role: "trace", mediaType: "application/json" },
      ...referencedAssets.map((asset) => {
        const location = artifactAssetPath(asset);
        return { ...location, data: JSON.stringify(sanitizeAssetRevision(asset)), mediaType: "application/json" };
      })
    ];
    const hashes = new Map<string, string>();
    for (const run of relevantRuns) {
      if (run.traceHash) hashes.set(run.traceHash, "application/x-ndjson");
      if (run.normalizedOutput) evidenceHashes(run.normalizedOutput, hashes);
    }
    const missingEvidence: string[] = [];
    for (const [hash, mediaType] of hashes) {
      try {
        const extension = mediaType === "application/json" ? "json" : "ndjson";
        files.push({ path: `traces/evidence/${hash}.${extension}`, data: await contentStore.get(hash), role: "trace", mediaType });
      } catch {
        missingEvidence.push(hash);
      }
    }
    if (missingEvidence.length > 0) files.push({ path: "traces/missing.json", data: JSON.stringify({ hashes: missingEvidence }), role: "trace", mediaType: "application/json" });
    for (const attachment of attachments) {
      files.push({ path: `attachments/${attachment.id}${safeExtension(attachment.fileName)}`, data: await contentStore.get(attachment.sha256), role: "attachment", mediaType: attachment.mediaType });
    }
    const archive = exportFindingArtifact({
      artifactId: finding.id,
      generatorVersion: "0.1.0",
      metadata: finding as unknown as JsonValue,
      summaryMarkdown: `# ${finding.title}\n\n**Severity:** ${finding.severity}\n\n${finding.summary}\n\n## Expected\n\n${finding.expected}\n\n## Observed\n\n${finding.observed}\n`,
      files,
      secretValues: await allSecrets(repository)
    });
    return bytesResponse(archive, `${finding.title.replaceAll(/[^a-z0-9]+/gi, "-").toLowerCase()}.lathe-finding`);
  });

  app.get("/api/config-snapshots/:id", async (context) => {
    const snapshot = await repository.getConfigSnapshot(context.req.param("id"));
    if (!snapshot) throw new HTTPException(404, { message: "Configuration snapshot not found" });
    return context.json({ snapshot });
  });

  app.post("/api/artifacts/import", async (context) => {
    const form = await context.req.formData();
    const file = form.get("file");
    if (!(file instanceof File)) throw new HTTPException(400, { message: "Multipart field 'file' is required" });
    if (file.size > 256 * 1024 * 1024) throw new HTTPException(413, { message: "Artifact exceeds compressed-size limit" });
    const bytes = new Uint8Array(await file.arrayBuffer());
    const imported = importArtifact(bytes);
    const stored = await contentStore.put(bytes);
    if (imported.manifest.kind === "harness") {
      const config = imported.files.find((entry) => entry.path === "config/harness.json");
      if (!config) throw new HTTPException(422, { message: "Harness bundle has no config/harness.json" });
      const parsed = parseArtifactJson(config.data, assetRevisionSchema, "Harness configuration") as AssetRevision;
      if (parsed.kind !== "harness" || !parsed.value || typeof parsed.value !== "object" || Array.isArray(parsed.value)) {
        throw new HTTPException(422, { message: "Harness configuration is malformed" });
      }
      const referenceFiles = imported.files.filter((entry) => entry.path !== "config/harness.json" && ["prompt", "tool-spec", "tool-script", "config"].includes(entry.role) && entry.mediaType === "application/json");
      const references: Array<{ source: AssetRevision; imported: AssetRevision }> = [];
      const revisionIds = new Map<string, string>();
      for (const entry of referenceFiles) {
        const source = parseArtifactJson(entry.data, assetRevisionSchema, `Referenced asset ${entry.path}`) as AssetRevision;
        if (!["prompt", "tool-spec", "tool-implementation", "target", "mcp-server"].includes(source.kind) || !source.id || !source.value) {
          throw new HTTPException(422, { message: `Referenced asset ${entry.path} is malformed` });
        }
        validateImportedAssetCredentials(source, `Referenced asset ${entry.path}`);
        const importedRevisionId = uuidv7();
        revisionIds.set(source.id, importedRevisionId);
        references.push({
          source,
          imported: {
            ...source,
            id: importedRevisionId,
            assetId: uuidv7(),
            revision: 1,
            provenance: { ...source.provenance, importedArtifactId: imported.manifest.artifactId, importedBlob: stored.sha256, sourceRevisionId: source.id },
            contentHash: sha256Json(source.value),
            trusted: false,
            archivedAt: null,
            createdAt: nowIso()
          }
        });
      }
      const rewriteBindings = (bindings: JsonValue | undefined, keys: string[]): JsonValue[] => {
        if (!Array.isArray(bindings)) return [];
        return bindings.map((binding) => {
          if (!binding || typeof binding !== "object" || Array.isArray(binding)) throw new HTTPException(422, { message: "Harness binding is malformed" });
          const rewritten: JsonObject = { ...binding };
          for (const key of keys) {
            const oldId = binding[key];
            if (oldId === null || oldId === undefined) continue;
            if (typeof oldId !== "string") throw new HTTPException(422, { message: `Harness binding ${key} is malformed` });
            const newId = revisionIds.get(oldId);
            if (!newId) throw new HTTPException(422, { message: `Harness bundle is missing referenced revision ${oldId}` });
            rewritten[key] = newId;
          }
          return rewritten;
        });
      };
      const sourceValue = parsed.value as JsonObject;
      const value: JsonObject = {
        ...sourceValue,
        promptBindings: rewriteBindings(sourceValue.promptBindings, ["revisionId"]),
        toolBindings: rewriteBindings(sourceValue.toolBindings, ["revisionId", "implementationRevisionId", "targetId", "mcpServerId"])
      };
      for (const reference of references) await repository.saveAssetRevision(reference.imported);
      const asset: AssetRevision = {
        ...parsed,
        id: uuidv7(),
        assetId: uuidv7(),
        revision: 1,
        provenance: { ...parsed.provenance, importedArtifactId: imported.manifest.artifactId, importedBlob: stored.sha256 },
        value,
        contentHash: sha256Json(value),
        trusted: false,
        archivedAt: null,
        createdAt: nowIso()
      };
      await repository.saveAssetRevision(asset);
      return context.json({
        manifest: imported.manifest,
        importedAsset: sanitizeAssetRevision(asset),
        importedReferences: references.map((item) => sanitizeAssetRevision(item.imported)),
        scriptsEnabled: false
      }, 201);
    }

    const metadata = imported.manifest.metadata as Partial<Finding>;
    const transcript = imported.files.find((entry) => entry.path === "transcript/branch.json");
    const snapshotsFile = imported.files.find((entry) => entry.path === "config/snapshots.json");
    const runsFile = imported.files.find((entry) => entry.path === "traces/runs.json");
    const sourceNodes = transcript ? parseArtifactJson(transcript.data, transcriptSchema, "Finding transcript") as MessageNode[] : [];
    const sourceSnapshots = snapshotsFile ? parseArtifactJson(snapshotsFile.data, configSnapshotsSchema, "Finding configuration snapshots") as ConfigSnapshot[] : [];
    const sourceRuns = runsFile ? parseArtifactJson(runsFile.data, modelRunsSchema, "Finding runs") as ModelRun[] : [];
    assertUniqueIds(sourceNodes, "Finding transcript");
    assertUniqueIds(sourceSnapshots, "Finding configuration snapshots");
    assertUniqueIds(sourceRuns, "Finding runs");
    for (const [index, source] of sourceNodes.entries()) {
      const expectedParent = index === 0 ? null : sourceNodes[index - 1]!.id;
      if (source.parentId !== expectedParent) throw new HTTPException(422, { message: "Finding transcript is not a contiguous branch path" });
    }
    const nodeIds = new Set(sourceNodes.map((node) => node.id));
    const snapshotSourceIds = new Set(sourceSnapshots.map((snapshot) => snapshot.id));
    const runSourceIds = new Set(sourceRuns.map((run) => run.id));
    for (const node of sourceNodes) {
      if (node.configSnapshotId && !snapshotSourceIds.has(node.configSnapshotId)) throw new HTTPException(422, { message: `Finding node references missing configuration snapshot ${node.configSnapshotId}` });
      if (node.sourceRunId && !runSourceIds.has(node.sourceRunId)) throw new HTTPException(422, { message: `Finding node references missing run ${node.sourceRunId}` });
    }
    for (const run of sourceRuns) {
      if (!snapshotSourceIds.has(run.configSnapshotId)) throw new HTTPException(422, { message: `Finding run references missing configuration snapshot ${run.configSnapshotId}` });
      if (run.contextNodeId && !nodeIds.has(run.contextNodeId)) throw new HTTPException(422, { message: `Finding run references missing context node ${run.contextNodeId}` });
      if (run.resultNodeId && !nodeIds.has(run.resultNodeId)) throw new HTTPException(422, { message: `Finding run references missing result node ${run.resultNodeId}` });
    }

    const referencedAttachmentIds = new Set(sourceNodes.flatMap((node) => node.parts.filter((part) => part.type === "attachment").map((part) => part.attachmentId)));
    const attachmentEntries = imported.files.filter((item) => item.role === "attachment").map((entry) => {
      if (!entry.path.startsWith("attachments/")) throw new HTTPException(422, { message: `Attachment path ${entry.path} is malformed` });
      const fileName = entry.path.slice("attachments/".length);
      const sourceId = [...referencedAttachmentIds].sort((left, right) => right.length - left.length).find((id) => fileName === id || (fileName.startsWith(`${id}.`) && /^\.[a-z0-9]{1,10}$/i.test(fileName.slice(id.length))));
      if (!sourceId) throw new HTTPException(422, { message: `Attachment path ${entry.path} does not match a transcript attachment` });
      return { entry, sourceId };
    });
    if (new Set(attachmentEntries.map((item) => item.sourceId)).size !== attachmentEntries.length) throw new HTTPException(422, { message: "Finding bundle contains duplicate attachment content" });
    const availableAttachmentIds = new Set(attachmentEntries.map((item) => item.sourceId));
    for (const attachmentId of referencedAttachmentIds) {
      if (!availableAttachmentIds.has(attachmentId)) throw new HTTPException(422, { message: `Finding transcript references missing attachment ${attachmentId}` });
    }

    const evidenceAssetEntries = imported.files.filter((item) => ["prompt", "tool-spec", "tool-script"].includes(item.role) || item.path.startsWith("config/references/"));
    const evidenceAssetSources = evidenceAssetEntries.map((entry) => {
      if (entry.mediaType !== "application/json") throw new HTTPException(422, { message: `Evidence asset ${entry.path} must be JSON` });
      const source = parseArtifactJson(entry.data, assetRevisionSchema, `Evidence asset ${entry.path}`) as AssetRevision;
      const expectedKind = expectedAssetKind(entry.path, entry.role);
      if (expectedKind === "reference" && source.kind !== "target" && source.kind !== "mcp-server") throw new HTTPException(422, { message: `Evidence asset ${entry.path} has an invalid kind` });
      if (expectedKind !== "reference" && expectedKind !== source.kind) throw new HTTPException(422, { message: `Evidence asset ${entry.path} has an invalid kind` });
      validateImportedAssetCredentials(source, `Evidence asset ${entry.path}`);
      return source;
    });
    assertUniqueIds(evidenceAssetSources, "Finding evidence assets");
    const assetRevisionIds = new Map(evidenceAssetSources.map((source) => [source.id, uuidv7()]));
    const rewrittenConfigs = new Map(sourceSnapshots.map((snapshot) => [snapshot.id, rewriteConfigReferences(snapshot.config, assetRevisionIds)]));

    const missingFile = imported.files.find((entry) => entry.path === "traces/missing.json");
    const declaredMissing = new Set(missingFile ? parseArtifactJson(missingFile.data, missingEvidenceSchema, "Missing evidence index").hashes : []);
    const evidenceEntries = imported.files.filter((entry) => entry.path.startsWith("traces/evidence/")).map((entry) => {
      const match = /^traces\/evidence\/([a-f0-9]{64})\.(json|ndjson)$/.exec(entry.path);
      if (!match?.[1] || entry.role !== "trace") throw new HTTPException(422, { message: `Evidence trace path ${entry.path} is malformed` });
      if ((match[2] === "json") !== (entry.mediaType === "application/json")) throw new HTTPException(422, { message: `Evidence trace ${entry.path} has an inconsistent media type` });
      return { entry, sourceHash: match[1] };
    });
    if (new Set(evidenceEntries.map((item) => item.sourceHash)).size !== evidenceEntries.length) throw new HTTPException(422, { message: "Finding bundle contains duplicate evidence hashes" });
    const storedEvidenceHashes = new Map<string, string>();
    for (const { entry, sourceHash } of evidenceEntries) storedEvidenceHashes.set(sourceHash, (await contentStore.put(entry.data)).sha256);
    for (const sourceHash of storedEvidenceHashes.keys()) declaredMissing.delete(sourceHash);
    const rewrittenRunEvidence = new Map(sourceRuns.map((run) => {
      const traceHash = run.traceHash === null
        ? null
        : storedEvidenceHashes.get(run.traceHash) ?? (declaredMissing.has(run.traceHash) ? null : undefined);
      if (traceHash === undefined) throw new HTTPException(422, { message: `Finding run references trace ${run.traceHash} that is absent from the bundle` });
      return [run.id, {
        traceHash,
        normalizedOutput: run.normalizedOutput === null ? null : rewriteEvidenceReferences(run.normalizedOutput, storedEvidenceHashes, declaredMissing)
      }];
    }));

    const project = await repository.createProject({ name: `Imported · ${typeof metadata.title === "string" ? metadata.title : imported.manifest.artifactId}`, description: "Read-only evidence imported from a Lathe finding bundle." });
    const { session, branch } = await repository.createSession({ projectId: project.id, name: "Imported finding" });
    const attachmentIds = new Map<string, string>();
    for (const { entry, sourceId } of attachmentEntries) {
      const storedAttachment = await contentStore.put(entry.data);
      const attachment = await repository.saveAttachment({
        projectId: project.id,
        fileName: entry.path.split("/").at(-1) ?? "attachment.bin",
        mediaType: entry.mediaType,
        size: storedAttachment.size,
        sha256: storedAttachment.sha256
      });
      attachmentIds.set(sourceId, attachment.id);
    }
    const importedEvidenceAssets: AssetRevision[] = [];
    for (const source of evidenceAssetSources) {
      const importedAsset: AssetRevision = {
        ...source, id: assetRevisionIds.get(source.id)!, assetId: uuidv7(), revision: 1,
        provenance: { ...source.provenance, importedArtifactId: imported.manifest.artifactId, importedBlob: stored.sha256, sourceRevisionId: source.id },
        contentHash: sha256Json(source.value), trusted: false, archivedAt: null, createdAt: nowIso()
      };
      await repository.saveAssetRevision(importedAsset);
      importedEvidenceAssets.push(importedAsset);
    }
    const snapshotIds = new Map<string, string>();
    const importedSnapshots: ConfigSnapshot[] = [];
    for (const source of sourceSnapshots) {
      const snapshot = await repository.createConfigSnapshot(session.id, rewrittenConfigs.get(source.id)!);
      snapshotIds.set(source.id, snapshot.id);
      importedSnapshots.push(snapshot);
    }
    const nodeIdsBySource = new Map(sourceNodes.map((node) => [node.id, uuidv7()]));
    const runIdsBySource = new Map(sourceRuns.map((run) => [run.id, uuidv7()]));
    let headNodeId: string | null = null;
    for (const source of sourceNodes) {
      const parts = source.parts.map((part) => {
        if (part.type !== "attachment") return part;
        return { ...part, attachmentId: attachmentIds.get(part.attachmentId)! };
      });
      const node = await repository.appendNode({
        id: nodeIdsBySource.get(source.id)!,
        sessionId: session.id,
        branchId: branch.id,
        parentId: headNodeId,
        role: source.role,
        parts,
        sourceRunId: source.sourceRunId === null ? null : runIdsBySource.get(source.sourceRunId)!,
        configSnapshotId: source.configSnapshotId === null ? null : snapshotIds.get(source.configSnapshotId)!
      });
      headNodeId = node.id;
    }
    const importedRuns: ModelRun[] = [];
    for (const source of sourceRuns) {
      const run = await repository.createRun({
        id: runIdsBySource.get(source.id)!,
        sessionId: session.id,
        branchId: branch.id,
        contextNodeId: source.contextNodeId === null ? null : nodeIdsBySource.get(source.contextNodeId)!,
        configSnapshotId: snapshotIds.get(source.configSnapshotId)!
      });
      const evidence = rewrittenRunEvidence.get(source.id)!;
      const restored = await repository.updateRun(run.id, {
        resultNodeId: source.resultNodeId === null ? null : nodeIdsBySource.get(source.resultNodeId)!,
        status: source.status,
        classification: source.classification,
        operatorLabel: source.operatorLabel,
        operatorNotes: source.operatorNotes,
        normalizedOutput: evidence.normalizedOutput,
        usage: source.usage,
        traceHash: evidence.traceHash,
        startedAt: source.startedAt,
        finishedAt: source.finishedAt
      });
      if (!restored) throw new HTTPException(500, { message: "Imported run could not be restored" });
      importedRuns.push(restored);
    }
    const finding = await repository.createFinding({
      projectId: project.id, sessionId: session.id, branchId: branch.id, nodeId: headNodeId,
      title: typeof metadata.title === "string" ? metadata.title : "Imported finding",
      severity: ["informational", "low", "medium", "high", "critical"].includes(String(metadata.severity)) ? metadata.severity as Finding["severity"] : "informational",
      summary: typeof metadata.summary === "string" ? metadata.summary : "",
      expected: typeof metadata.expected === "string" ? metadata.expected : "",
      observed: typeof metadata.observed === "string" ? metadata.observed : "",
      tags: Array.isArray(metadata.tags) ? metadata.tags.filter((tag): tag is string => typeof tag === "string") : ["imported"]
    });
    await repository.saveAttachment({ projectId: project.id, fileName: file.name, mediaType: "application/zip", size: stored.size, sha256: stored.sha256 });
    return context.json({
      manifest: imported.manifest,
      project,
      session,
      finding,
      importedEvidenceAssets: importedEvidenceAssets.map(sanitizeAssetRevision),
      importedSnapshots,
      importedRuns,
      importedMissingEvidence: [...declaredMissing],
      scriptsEnabled: false
    }, 201);
  });
}
