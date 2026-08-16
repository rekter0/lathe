import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  applicationSettingsInputSchema,
  assetKindSchema,
  createPayloadGenerationAttemptSchema,
  createPayloadGenerationSchema,
  createPayloadRevisionSchema,
  emptyResolvedConfig,
  nowIso,
  payloadWorkbenchSettingsInputSchema,
  sessionPayloadWorkbenchSettingsInputSchema,
  sha256Json,
  updatePayloadGenerationAttemptSchema,
  updatePayloadGenerationSchema,
  updateSessionMetadataSchema,
  uuidv7,
  type AssetKind,
  type AssetRevision,
  type ApplicationSettings,
  type ApplicationSettingsInput,
  type Attachment,
  type AutomationJob,
  type BranchRef,
  type Checkpoint,
  type ConfigSnapshot,
  type Finding,
  type JsonObject,
  type JsonValue,
  type MessageNode,
  type MessagePart,
  type ModelRun,
  type CreatePayloadGenerationAttemptInput,
  type CreatePayloadGenerationInput,
  type CreatePayloadRevisionInput,
  type PayloadGeneration,
  type PayloadGenerationAttempt,
  type PayloadRevision,
  type PayloadWorkbenchSettings,
  type PayloadWorkbenchSettingsInput,
  type Project,
  type ProviderProfile,
  type ResolvedConfig,
  type RunClassification,
  type RunStatus,
  type SecretMetadata,
  type Session,
  type SessionPayloadWorkbenchSettings,
  type SessionPayloadWorkbenchSettingsInput
} from "@lathe/domain";

export interface CreateProjectInput {
  name: string;
  description?: string;
  targetName?: string;
  workspaceRoot?: string | null;
  defaultHarnessRevisionId?: string | null;
}

export interface CreateSessionInput {
  projectId: string;
  name: string;
  description?: string;
  providerProfileId?: string | null;
  modelId?: string | null;
  draftConfig?: ResolvedConfig;
}

export interface AppendNodeInput {
  id?: string;
  branchId: string;
  sessionId: string;
  parentId?: string | null;
  role: "user" | "assistant" | "tool";
  parts: MessagePart[];
  sourceRunId?: string | null;
  configSnapshotId?: string | null;
  sourcePayloadRevisionId?: string | null;
}

export interface UpdateSessionMetadataInput {
  name?: string | undefined;
  description?: string | undefined;
}

export interface CreateProviderInput {
  label: string;
  protocol: ProviderProfile["protocol"];
  baseUrl: string;
  endpointOverride?: string | null;
  credential?: string;
  headers?: Record<string, string>;
  extraBody?: JsonObject;
  models?: ProviderProfile["models"];
}

export interface CreateFindingInput extends Omit<Finding, "id" | "createdAt" | "updatedAt"> {}
export interface CreateAutomationInput extends Pick<AutomationJob, "projectId" | "sessionId" | "kind" | "concurrency" | "plan"> {}
export interface CreateCheckpointInput extends Pick<Checkpoint, "sessionId" | "name" | "nodeId" | "configSnapshotId"> {}
export interface CreateRunInput extends Pick<ModelRun, "sessionId" | "branchId" | "contextNodeId" | "configSnapshotId"> { id?: string }
export interface RestoreCheckpointInput { checkpointId: string; sessionId: string; branchId: string }
export interface RestoreCheckpointResult { checkpoint: Checkpoint; branch: BranchRef; session: Session }

export interface ResourceReference {
  kind: "project" | "session" | "checkpoint" | "snapshot" | "asset" | "automation" | "payload-settings" | "payload-generation" | "payload-revision" | "message";
  id: string;
  label: string;
  detail: string;
}

export interface ResourceDeletionResult {
  deleted: boolean;
  references: ResourceReference[];
}

export interface LatheRepository {
  readonly dialect: "sqlite" | "postgres";
  close(): Promise<void>;
  listProjects(): Promise<Project[]>;
  getProject(id: string): Promise<Project | null>;
  createProject(input: CreateProjectInput): Promise<Project>;
  updateProject(id: string, input: Partial<CreateProjectInput>): Promise<Project | null>;
  deleteProject(id: string): Promise<boolean>;
  listSessions(projectId: string): Promise<Session[]>;
  getSession(id: string): Promise<Session | null>;
  createSession(input: CreateSessionInput): Promise<{ session: Session; branch: BranchRef }>;
  updateSessionMetadata(id: string, input: UpdateSessionMetadataInput): Promise<Session | null>;
  updateSessionDraft(id: string, config: ResolvedConfig): Promise<Session | null>;
  updateSessionModel(id: string, providerProfileId: string | null, modelId: string | null): Promise<Session | null>;
  updateSessionContinuation(id: string, enabled: boolean, limit: number): Promise<Session | null>;
  deleteSession(id: string): Promise<boolean>;
  listNodes(sessionId: string): Promise<MessageNode[]>;
  getNode(id: string): Promise<MessageNode | null>;
  appendNode(input: AppendNodeInput): Promise<MessageNode>;
  listBranches(sessionId: string): Promise<BranchRef[]>;
  createBranch(sessionId: string, name: string, headNodeId: string | null): Promise<BranchRef>;
  moveBranch(id: string, headNodeId: string | null): Promise<BranchRef | null>;
  createConfigSnapshot(sessionId: string, config: ResolvedConfig): Promise<ConfigSnapshot>;
  getConfigSnapshot(id: string): Promise<ConfigSnapshot | null>;
  listCheckpoints(sessionId: string): Promise<Checkpoint[]>;
  createCheckpoint(input: CreateCheckpointInput): Promise<Checkpoint>;
  restoreCheckpoint(input: RestoreCheckpointInput): Promise<RestoreCheckpointResult>;
  createRun(input: CreateRunInput): Promise<ModelRun>;
  getRun(id: string): Promise<ModelRun | null>;
  updateRun(id: string, patch: Partial<Pick<ModelRun, "resultNodeId" | "status" | "classification" | "operatorLabel" | "operatorNotes" | "normalizedOutput" | "usage" | "traceHash" | "startedAt" | "finishedAt">>): Promise<ModelRun | null>;
  listRuns(sessionId: string): Promise<ModelRun[]>;
  listProviderProfiles(includeArchived?: boolean): Promise<ProviderProfile[]>;
  getProviderProfile(id: string): Promise<ProviderProfile | null>;
  createProviderProfile(input: CreateProviderInput): Promise<ProviderProfile>;
  createProviderRevision(id: string, input: Partial<CreateProviderInput>): Promise<ProviderProfile | null>;
  deleteProviderProfile(id: string): Promise<ResourceDeletionResult>;
  listSecrets(): Promise<SecretMetadata[]>;
  createSecret(label: string, value: string): Promise<SecretMetadata>;
  resolveSecret(id: string): Promise<string | undefined>;
  deleteSecret(id: string): Promise<ResourceDeletionResult>;
  saveAssetRevision(asset: AssetRevision): Promise<AssetRevision>;
  listAssetRevisions(kind?: AssetKind, includeArchived?: boolean): Promise<AssetRevision[]>;
  deleteAssetRevision(id: string): Promise<ResourceDeletionResult>;
  saveAttachment(input: Omit<Attachment, "id" | "createdAt">): Promise<Attachment>;
  getAttachment(id: string): Promise<Attachment | null>;
  listAttachments(projectId: string): Promise<Attachment[]>;
  createFinding(input: CreateFindingInput): Promise<Finding>;
  listFindings(projectId: string): Promise<Finding[]>;
  createAutomationJob(input: CreateAutomationInput): Promise<AutomationJob>;
  getAutomationJob(id: string): Promise<AutomationJob | null>;
  updateAutomationJob(id: string, patch: Partial<Pick<AutomationJob, "status" | "progress" | "error">>): Promise<AutomationJob | null>;
  listAutomationJobs(sessionId: string): Promise<AutomationJob[]>;
  getApplicationSettings(): Promise<ApplicationSettings>;
  upsertApplicationSettings(input: ApplicationSettingsInput): Promise<ApplicationSettings>;
  getPayloadWorkbenchSettings(): Promise<PayloadWorkbenchSettings | null>;
  upsertPayloadWorkbenchSettings(input: PayloadWorkbenchSettingsInput): Promise<PayloadWorkbenchSettings>;
  deletePayloadWorkbenchSettings(): Promise<boolean>;
  getSessionPayloadWorkbenchSettings(sessionId: string): Promise<SessionPayloadWorkbenchSettings | null>;
  upsertSessionPayloadWorkbenchSettings(sessionId: string, input: SessionPayloadWorkbenchSettingsInput): Promise<SessionPayloadWorkbenchSettings>;
  createPayloadGeneration(input: CreatePayloadGenerationInput): Promise<PayloadGeneration>;
  getPayloadGeneration(id: string, includeDeleted?: boolean): Promise<PayloadGeneration | null>;
  getActivePayloadGeneration(sessionId: string): Promise<PayloadGeneration | null>;
  listPayloadGenerations(sessionId: string, includeDeleted?: boolean): Promise<PayloadGeneration[]>;
  updatePayloadGeneration(id: string, patch: { status: PayloadGeneration["status"] }): Promise<PayloadGeneration | null>;
  deletePayloadGeneration(id: string): Promise<ResourceDeletionResult>;
  restorePayloadGeneration(id: string): Promise<PayloadGeneration | null>;
  createPayloadGenerationAttempt(input: CreatePayloadGenerationAttemptInput): Promise<PayloadGenerationAttempt>;
  getPayloadGenerationAttempt(id: string): Promise<PayloadGenerationAttempt | null>;
  listPayloadGenerationAttempts(generationId: string): Promise<PayloadGenerationAttempt[]>;
  updatePayloadGenerationAttempt(id: string, patch: Partial<Pick<PayloadGenerationAttempt, "status" | "classification" | "normalizedOutput" | "usage" | "traceHash" | "nativeThreadId" | "nativeTurnId" | "startedAt" | "finishedAt">>): Promise<PayloadGenerationAttempt | null>;
  createPayloadRevision(input: CreatePayloadRevisionInput): Promise<PayloadRevision>;
  getPayloadRevision(id: string, includeDeleted?: boolean): Promise<PayloadRevision | null>;
  listPayloadRevisions(sessionId: string, includeDeleted?: boolean): Promise<PayloadRevision[]>;
  listPayloadRevisionsForGeneration(generationId: string, includeDeleted?: boolean): Promise<PayloadRevision[]>;
  deletePayloadRevision(id: string): Promise<ResourceDeletionResult>;
  restorePayloadRevision(id: string): Promise<PayloadRevision | null>;
  markRunningJobsInterrupted(): Promise<void>;
}

type Schema = Record<string, any>;

function jsonReferences(value: JsonValue, id: string): boolean {
  if (value === id) return true;
  if (Array.isArray(value)) return value.some((item) => jsonReferences(item, id));
  if (value && typeof value === "object") return Object.values(value).some((item) => jsonReferences(item, id));
  return false;
}

function configReferencesAsset(config: ResolvedConfig, id: string): boolean {
  return config.promptBlocks.some((block) => block.revisionId === id)
    || config.tools.some((tool) => (
      tool.toolRevisionId === id
      || tool.implementationRevisionId === id
      || tool.targetId === id
      || tool.mcpServerId === id
    ));
}

function assetReference(asset: AssetRevision, detail: string): ResourceReference {
  return {
    kind: "asset",
    id: asset.id,
    label: `${asset.name} · revision ${asset.revision}`,
    detail
  };
}

function uniqueReferences(references: ResourceReference[]): ResourceReference[] {
  const seen = new Set<string>();
  return references.filter((reference) => {
    const key = `${reference.kind}:${reference.id}:${reference.detail}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class DrizzleLatheRepository implements LatheRepository {
  constructor(
    readonly dialect: "sqlite" | "postgres",
    private readonly db: any,
    private readonly schema: Schema,
    private readonly closeDatabase: () => Promise<void>
  ) {}

  async close(): Promise<void> {
    await this.closeDatabase();
  }

  private async all<T>(query: any): Promise<T[]> {
    return this.dialect === "sqlite" ? (query.all() as T[]) : ((await query) as T[]);
  }

  private async get<T>(query: any): Promise<T | null> {
    if (this.dialect === "sqlite") return (query.get() as T | undefined) ?? null;
    const rows = (await query.limit(1)) as T[];
    return rows[0] ?? null;
  }

  private async returning<T>(query: any): Promise<T> {
    if (this.dialect === "sqlite") return query.get() as T;
    const rows = (await query) as T[];
    const row = rows[0];
    if (!row) throw new Error("Database mutation returned no row");
    return row;
  }

  private async run(query: any): Promise<void> {
    if (this.dialect === "sqlite") query.run();
    else await query;
  }

  async listProjects(): Promise<Project[]> {
    return this.all(this.db.select().from(this.schema.projects).orderBy(desc(this.schema.projects.updatedAt)));
  }

  async getProject(id: string): Promise<Project | null> {
    return this.get(this.db.select().from(this.schema.projects).where(eq(this.schema.projects.id, id)));
  }

  async createProject(input: CreateProjectInput): Promise<Project> {
    const timestamp = nowIso();
    const project: Project = {
      id: uuidv7(),
      name: input.name,
      description: input.description ?? "",
      targetName: input.targetName ?? "",
      defaultHarnessRevisionId: input.defaultHarnessRevisionId ?? null,
      workspaceRoot: input.workspaceRoot ?? null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return this.returning(this.db.insert(this.schema.projects).values(project).returning());
  }

  async updateProject(id: string, input: Partial<CreateProjectInput>): Promise<Project | null> {
    const values = { ...input, updatedAt: nowIso() };
    return this.returningOrNull(this.db.update(this.schema.projects).set(values).where(eq(this.schema.projects.id, id)).returning());
  }

  async deleteProject(id: string): Promise<boolean> {
    return Boolean(await this.returningOrNull<Project>(
      this.db.delete(this.schema.projects).where(eq(this.schema.projects.id, id)).returning()
    ));
  }

  private async returningOrNull<T>(query: any): Promise<T | null> {
    if (this.dialect === "sqlite") return (query.get() as T | undefined) ?? null;
    const rows = (await query) as T[];
    return rows[0] ?? null;
  }

  async listSessions(projectId: string): Promise<Session[]> {
    return this.all(this.db.select().from(this.schema.sessions).where(eq(this.schema.sessions.projectId, projectId)).orderBy(desc(this.schema.sessions.updatedAt)));
  }

  async getSession(id: string): Promise<Session | null> {
    return this.get(this.db.select().from(this.schema.sessions).where(eq(this.schema.sessions.id, id)));
  }

  async createSession(input: CreateSessionInput): Promise<{ session: Session; branch: BranchRef }> {
    if (!await this.getProject(input.projectId)) throw new Error("Session project does not exist");
    const timestamp = nowIso();
    const branch: BranchRef = { id: uuidv7(), sessionId: "", name: "main", headNodeId: null, createdAt: timestamp, updatedAt: timestamp };
    const draftConfig = structuredClone(input.draftConfig ?? emptyResolvedConfig());
    draftConfig.provider = null;
    const session: Session = {
      id: uuidv7(), projectId: input.projectId, name: input.name, description: input.description ?? "", providerProfileId: input.providerProfileId ?? null,
      modelId: input.modelId ?? null, activeBranchId: branch.id, draftConfig,
      autoContinueTools: false, autoContinueLimit: 8, createdAt: timestamp, updatedAt: timestamp
    };
    branch.sessionId = session.id;

    if (this.dialect === "sqlite") {
      this.db.transaction((tx: any) => {
        tx.insert(this.schema.sessions).values(session).run();
        tx.insert(this.schema.branches).values(branch).run();
      });
    } else {
      await this.db.transaction(async (tx: any) => {
        await tx.insert(this.schema.sessions).values(session);
        await tx.insert(this.schema.branches).values(branch);
      });
    }
    return { session, branch };
  }

  async updateSessionMetadata(id: string, input: UpdateSessionMetadataInput): Promise<Session | null> {
    const parsed = updateSessionMetadataSchema.parse(input);
    return this.returningOrNull(
      this.db.update(this.schema.sessions).set({ ...parsed, updatedAt: nowIso() }).where(eq(this.schema.sessions.id, id)).returning()
    );
  }

  async updateSessionDraft(id: string, config: ResolvedConfig): Promise<Session | null> {
    const draftConfig = structuredClone(config);
    draftConfig.provider = null;
    return this.returningOrNull(this.db.update(this.schema.sessions).set({ draftConfig, updatedAt: nowIso() }).where(eq(this.schema.sessions.id, id)).returning());
  }

  async updateSessionModel(id: string, providerProfileId: string | null, modelId: string | null): Promise<Session | null> {
    return this.returningOrNull(
      this.db
        .update(this.schema.sessions)
        .set({ providerProfileId, modelId, updatedAt: nowIso() })
        .where(eq(this.schema.sessions.id, id))
        .returning()
    );
  }

  async updateSessionContinuation(id: string, enabled: boolean, limit: number): Promise<Session | null> {
    const boundedLimit = Math.min(32, Math.max(1, Math.trunc(limit)));
    return this.returningOrNull(
      this.db
        .update(this.schema.sessions)
        .set({ autoContinueTools: enabled, autoContinueLimit: boundedLimit, updatedAt: nowIso() })
        .where(eq(this.schema.sessions.id, id))
        .returning()
    );
  }

  async deleteSession(id: string): Promise<boolean> {
    return Boolean(await this.returningOrNull<Session>(
      this.db.delete(this.schema.sessions).where(eq(this.schema.sessions.id, id)).returning()
    ));
  }

  async listNodes(sessionId: string): Promise<MessageNode[]> {
    return this.all(this.db.select().from(this.schema.messageNodes).where(eq(this.schema.messageNodes.sessionId, sessionId)).orderBy(this.schema.messageNodes.createdAt));
  }

  async getNode(id: string): Promise<MessageNode | null> {
    return this.get(this.db.select().from(this.schema.messageNodes).where(eq(this.schema.messageNodes.id, id)));
  }

  async appendNode(input: AppendNodeInput): Promise<MessageNode> {
    if (input.configSnapshotId) {
      const snapshot = await this.getConfigSnapshot(input.configSnapshotId);
      if (!snapshot || snapshot.sessionId !== input.sessionId) throw new Error("Configuration snapshot does not belong to session");
    }
    if (input.parentId) {
      const parent = await this.getNode(input.parentId);
      if (!parent || parent.sessionId !== input.sessionId) throw new Error("Parent node does not belong to session");
    }
    if (input.sourcePayloadRevisionId) {
      const revision = await this.getPayloadRevision(input.sourcePayloadRevisionId);
      if (!revision || revision.sessionId !== input.sessionId) throw new Error("Source payload revision does not belong to session");
    }
    const node: MessageNode = {
      id: input.id ?? uuidv7(), sessionId: input.sessionId, parentId: input.parentId ?? null, role: input.role, parts: input.parts,
      sourceRunId: input.sourceRunId ?? null, configSnapshotId: input.configSnapshotId ?? null,
      sourcePayloadRevisionId: input.sourcePayloadRevisionId ?? null, createdAt: nowIso()
    };
    const apply = (tx: any, synchronous: boolean) => {
      const branchQuery = tx.select().from(this.schema.branches).where(eq(this.schema.branches.id, input.branchId));
      const branch = synchronous ? branchQuery.get() : branchQuery;
      return { branch, tx };
    };

    if (this.dialect === "sqlite") {
      this.db.transaction((tx: any) => {
        const { branch } = apply(tx, true) as { branch: BranchRef | undefined };
        if (!branch || branch.sessionId !== input.sessionId) throw new Error("Branch does not belong to session");
        if (branch.headNodeId !== node.parentId) throw new Error("Branch head changed; rewind or fork before appending");
        tx.insert(this.schema.messageNodes).values(node).run();
        tx.update(this.schema.branches).set({ headNodeId: node.id, updatedAt: node.createdAt }).where(eq(this.schema.branches.id, branch.id)).run();
      });
    } else {
      await this.db.transaction(async (tx: any) => {
        const rows = (await tx.select().from(this.schema.branches).where(eq(this.schema.branches.id, input.branchId)).for("update")) as BranchRef[];
        const branch = rows[0];
        if (!branch || branch.sessionId !== input.sessionId) throw new Error("Branch does not belong to session");
        if (branch.headNodeId !== node.parentId) throw new Error("Branch head changed; rewind or fork before appending");
        await tx.insert(this.schema.messageNodes).values(node);
        await tx.update(this.schema.branches).set({ headNodeId: node.id, updatedAt: node.createdAt }).where(eq(this.schema.branches.id, branch.id));
      });
    }
    return node;
  }

  async listBranches(sessionId: string): Promise<BranchRef[]> {
    return this.all(this.db.select().from(this.schema.branches).where(eq(this.schema.branches.sessionId, sessionId)).orderBy(this.schema.branches.createdAt));
  }

  async createBranch(sessionId: string, name: string, headNodeId: string | null): Promise<BranchRef> {
    if (headNodeId) {
      const node = await this.getNode(headNodeId);
      if (!node || node.sessionId !== sessionId) throw new Error("Branch head must belong to session");
    }
    const timestamp = nowIso();
    const branch: BranchRef = { id: uuidv7(), sessionId, name, headNodeId, createdAt: timestamp, updatedAt: timestamp };
    return this.returning(this.db.insert(this.schema.branches).values(branch).returning());
  }

  async moveBranch(id: string, headNodeId: string | null): Promise<BranchRef | null> {
    const branch = await this.get<BranchRef>(this.db.select().from(this.schema.branches).where(eq(this.schema.branches.id, id)));
    if (!branch) return null;
    if (headNodeId) {
      const node = await this.getNode(headNodeId);
      if (!node || node.sessionId !== branch.sessionId) throw new Error("Branch head must belong to session");
    }
    return this.returningOrNull(this.db.update(this.schema.branches).set({ headNodeId, updatedAt: nowIso() }).where(eq(this.schema.branches.id, id)).returning());
  }

  async createConfigSnapshot(sessionId: string, config: ResolvedConfig): Promise<ConfigSnapshot> {
    if (!await this.getSession(sessionId)) throw new Error("Configuration snapshot session does not exist");
    const snapshot: ConfigSnapshot = { id: uuidv7(), sessionId, config, contentHash: sha256Json(config as unknown as JsonValue), createdAt: nowIso() };
    return this.returning(this.db.insert(this.schema.configSnapshots).values(snapshot).returning());
  }

  async getConfigSnapshot(id: string): Promise<ConfigSnapshot | null> {
    return this.get(this.db.select().from(this.schema.configSnapshots).where(eq(this.schema.configSnapshots.id, id)));
  }

  async listCheckpoints(sessionId: string): Promise<Checkpoint[]> {
    return this.all(this.db.select().from(this.schema.checkpoints).where(eq(this.schema.checkpoints.sessionId, sessionId)).orderBy(desc(this.schema.checkpoints.createdAt)));
  }

  async createCheckpoint(input: CreateCheckpointInput): Promise<Checkpoint> {
    const session = await this.getSession(input.sessionId);
    if (!session) throw new Error("Checkpoint session does not exist");
    const snapshot = await this.getConfigSnapshot(input.configSnapshotId);
    if (!snapshot || snapshot.sessionId !== input.sessionId) throw new Error("Checkpoint configuration does not belong to session");
    if (input.nodeId) {
      const node = await this.getNode(input.nodeId);
      if (!node || node.sessionId !== input.sessionId) throw new Error("Checkpoint node does not belong to session");
    }
    const checkpoint: Checkpoint = {
      ...input,
      id: uuidv7(),
      providerProfileId: session.providerProfileId,
      modelId: session.modelId,
      autoContinueTools: session.autoContinueTools,
      autoContinueLimit: session.autoContinueLimit,
      sessionStateCaptured: true,
      createdAt: nowIso()
    };
    return this.returning(this.db.insert(this.schema.checkpoints).values(checkpoint).returning());
  }

  async restoreCheckpoint(input: RestoreCheckpointInput): Promise<RestoreCheckpointResult> {
    const timestamp = nowIso();
    const validate = (checkpoint: Checkpoint | undefined, branch: BranchRef | undefined, session: Session | undefined, snapshot: ConfigSnapshot | undefined, node: MessageNode | undefined) => {
      if (!checkpoint) throw new Error("Checkpoint not found");
      if (!session) throw new Error("Checkpoint session not found");
      if (checkpoint.sessionId !== input.sessionId) throw new Error("Checkpoint does not belong to session");
      if (!branch) throw new Error("Checkpoint restore branch not found");
      if (branch.sessionId !== input.sessionId) throw new Error("Checkpoint restore branch does not belong to session");
      if (!snapshot || snapshot.sessionId !== input.sessionId || snapshot.id !== checkpoint.configSnapshotId) throw new Error("Checkpoint configuration does not belong to session");
      if (checkpoint.nodeId && (!node || node.sessionId !== input.sessionId)) throw new Error("Checkpoint node does not belong to session");
      if ((checkpoint.providerProfileId === null) !== (checkpoint.modelId === null)) throw new Error("Checkpoint provider selection is malformed");
    };
    const sessionValues = (checkpoint: Checkpoint, snapshot: ConfigSnapshot, branch: BranchRef) => ({
      // Restore the immutable snapshot verbatim. Provider selection is also
      // restored from the checkpoint's dedicated session-state fields below;
      // the embedded provider snapshot remains part of the draft evidence.
      draftConfig: structuredClone(snapshot.config),
      activeBranchId: branch.id,
      ...(checkpoint.sessionStateCaptured ? {
        providerProfileId: checkpoint.providerProfileId,
        modelId: checkpoint.modelId,
        autoContinueTools: checkpoint.autoContinueTools,
        autoContinueLimit: Math.min(32, Math.max(1, checkpoint.autoContinueLimit))
      } : {}),
      updatedAt: timestamp
    });

    if (this.dialect === "sqlite") {
      return this.db.transaction((tx: any) => {
        const checkpoint = tx.select().from(this.schema.checkpoints).where(eq(this.schema.checkpoints.id, input.checkpointId)).get() as Checkpoint | undefined;
        const branch = tx.select().from(this.schema.branches).where(eq(this.schema.branches.id, input.branchId)).get() as BranchRef | undefined;
        const session = tx.select().from(this.schema.sessions).where(eq(this.schema.sessions.id, input.sessionId)).get() as Session | undefined;
        const snapshot = checkpoint ? tx.select().from(this.schema.configSnapshots).where(eq(this.schema.configSnapshots.id, checkpoint.configSnapshotId)).get() as ConfigSnapshot | undefined : undefined;
        const node = checkpoint?.nodeId ? tx.select().from(this.schema.messageNodes).where(eq(this.schema.messageNodes.id, checkpoint.nodeId)).get() as MessageNode | undefined : undefined;
        validate(checkpoint, branch, session, snapshot, node);
        const updatedBranch = tx.update(this.schema.branches).set({ headNodeId: checkpoint!.nodeId, updatedAt: timestamp }).where(eq(this.schema.branches.id, branch!.id)).returning().get() as BranchRef;
        const updatedSession = tx.update(this.schema.sessions).set(sessionValues(checkpoint!, snapshot!, branch!)).where(eq(this.schema.sessions.id, session!.id)).returning().get() as Session;
        return { checkpoint: checkpoint!, branch: updatedBranch, session: updatedSession };
      }) as RestoreCheckpointResult;
    }

    return this.db.transaction(async (tx: any) => {
      const [checkpoints, branches, sessions] = await Promise.all([
        tx.select().from(this.schema.checkpoints).where(eq(this.schema.checkpoints.id, input.checkpointId)).for("update"),
        tx.select().from(this.schema.branches).where(eq(this.schema.branches.id, input.branchId)).for("update"),
        tx.select().from(this.schema.sessions).where(eq(this.schema.sessions.id, input.sessionId)).for("update")
      ]) as [Checkpoint[], BranchRef[], Session[]];
      const checkpoint = checkpoints[0];
      const branch = branches[0];
      const session = sessions[0];
      const snapshotRows = checkpoint ? await tx.select().from(this.schema.configSnapshots).where(eq(this.schema.configSnapshots.id, checkpoint.configSnapshotId)) as ConfigSnapshot[] : [];
      const nodeRows = checkpoint?.nodeId ? await tx.select().from(this.schema.messageNodes).where(eq(this.schema.messageNodes.id, checkpoint.nodeId)) as MessageNode[] : [];
      validate(checkpoint, branch, session, snapshotRows[0], nodeRows[0]);
      const [updatedBranches, updatedSessions] = await Promise.all([
        tx.update(this.schema.branches).set({ headNodeId: checkpoint!.nodeId, updatedAt: timestamp }).where(eq(this.schema.branches.id, branch!.id)).returning(),
        tx.update(this.schema.sessions).set(sessionValues(checkpoint!, snapshotRows[0]!, branch!)).where(eq(this.schema.sessions.id, session!.id)).returning()
      ]) as [BranchRef[], Session[]];
      return { checkpoint: checkpoint!, branch: updatedBranches[0]!, session: updatedSessions[0]! };
    }) as RestoreCheckpointResult;
  }

  async createRun(input: CreateRunInput): Promise<ModelRun> {
    const [session, branches, snapshot] = await Promise.all([
      this.getSession(input.sessionId),
      this.listBranches(input.sessionId),
      this.getConfigSnapshot(input.configSnapshotId)
    ]);
    if (!session) throw new Error("Run session does not exist");
    if (!branches.some((branch) => branch.id === input.branchId)) throw new Error("Run branch does not belong to session");
    if (!snapshot || snapshot.sessionId !== input.sessionId) throw new Error("Run configuration does not belong to session");
    if (input.contextNodeId) {
      const node = await this.getNode(input.contextNodeId);
      if (!node || node.sessionId !== input.sessionId) throw new Error("Run context node does not belong to session");
    }
    const { id = uuidv7(), ...references } = input;
    const run: ModelRun = {
      id, ...references, resultNodeId: null, status: "queued", classification: null, operatorLabel: null, operatorNotes: null,
      normalizedOutput: null, usage: null, traceHash: null, startedAt: null, finishedAt: null, createdAt: nowIso()
    };
    return this.returning(this.db.insert(this.schema.modelRuns).values(run).returning());
  }

  async getRun(id: string): Promise<ModelRun | null> {
    return this.get(this.db.select().from(this.schema.modelRuns).where(eq(this.schema.modelRuns.id, id)));
  }

  async updateRun(id: string, patch: Partial<Pick<ModelRun, "resultNodeId" | "status" | "classification" | "operatorLabel" | "operatorNotes" | "normalizedOutput" | "usage" | "traceHash" | "startedAt" | "finishedAt">>): Promise<ModelRun | null> {
    return this.returningOrNull(this.db.update(this.schema.modelRuns).set(patch).where(eq(this.schema.modelRuns.id, id)).returning());
  }

  async listRuns(sessionId: string): Promise<ModelRun[]> {
    return this.all(this.db.select().from(this.schema.modelRuns).where(eq(this.schema.modelRuns.sessionId, sessionId)).orderBy(desc(this.schema.modelRuns.createdAt)));
  }

  async listProviderProfiles(includeArchived = false): Promise<ProviderProfile[]> {
    const base = this.db.select().from(this.schema.providerProfiles);
    if (includeArchived) return this.all(base.orderBy(this.schema.providerProfiles.label));
    return this.all(base.where(isNull(this.schema.providerProfiles.archivedAt)).orderBy(this.schema.providerProfiles.label));
  }

  async getProviderProfile(id: string): Promise<ProviderProfile | null> {
    return this.get(this.db.select().from(this.schema.providerProfiles).where(eq(this.schema.providerProfiles.id, id)));
  }

  async createProviderProfile(input: CreateProviderInput): Promise<ProviderProfile> {
    const timestamp = nowIso();
    const profile: ProviderProfile = {
      id: uuidv7(), label: input.label, protocol: input.protocol, baseUrl: input.baseUrl, endpointOverride: input.endpointOverride ?? null,
      credential: input.credential ?? "", headers: input.headers ?? {}, extraBody: input.extraBody ?? {}, models: input.models ?? [],
      revision: 1, archivedAt: null, createdAt: timestamp, updatedAt: timestamp
    };
    return this.returning(this.db.insert(this.schema.providerProfiles).values(profile).returning());
  }

  async createProviderRevision(id: string, input: Partial<CreateProviderInput>): Promise<ProviderProfile | null> {
    const prior = await this.getProviderProfile(id);
    if (!prior || prior.archivedAt) return null;
    const timestamp = nowIso();
    const profile: ProviderProfile = {
      id: uuidv7(),
      label: input.label ?? prior.label,
      protocol: input.protocol ?? prior.protocol,
      baseUrl: input.baseUrl ?? prior.baseUrl,
      endpointOverride: input.endpointOverride === undefined ? prior.endpointOverride : input.endpointOverride,
      credential: input.credential ?? prior.credential,
      headers: input.headers ?? prior.headers,
      extraBody: input.extraBody ?? prior.extraBody,
      models: input.models ?? prior.models,
      revision: prior.revision + 1,
      archivedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    if (this.dialect === "sqlite") {
      this.db.transaction((tx: any) => {
        const superseded = tx.update(this.schema.providerProfiles)
          .set({ archivedAt: timestamp, updatedAt: timestamp })
          .where(and(eq(this.schema.providerProfiles.id, id), isNull(this.schema.providerProfiles.archivedAt)))
          .returning().get();
        if (!superseded) throw new Error("Provider profile was already revised");
        tx.insert(this.schema.providerProfiles).values(profile).run();
      });
    } else {
      await this.db.transaction(async (tx: any) => {
        const superseded = await tx.update(this.schema.providerProfiles)
          .set({ archivedAt: timestamp, updatedAt: timestamp })
          .where(and(eq(this.schema.providerProfiles.id, id), isNull(this.schema.providerProfiles.archivedAt)))
          .returning();
        if (superseded.length === 0) throw new Error("Provider profile was already revised");
        await tx.insert(this.schema.providerProfiles).values(profile);
      });
    }
    return profile;
  }

  async deleteProviderProfile(id: string): Promise<ResourceDeletionResult> {
    const profile = await this.getProviderProfile(id);
    if (!profile || profile.archivedAt) return { deleted: false, references: [] };
    const references = await this.providerReferences(id);
    if (references.length > 0) return { deleted: false, references };
    const archived = await this.returningOrNull<ProviderProfile>(
      this.db.update(this.schema.providerProfiles)
        .set({ archivedAt: nowIso(), updatedAt: nowIso() })
        .where(and(eq(this.schema.providerProfiles.id, id), isNull(this.schema.providerProfiles.archivedAt)))
        .returning()
    );
    return { deleted: Boolean(archived), references: [] };
  }

  async listSecrets(): Promise<SecretMetadata[]> {
    const rows = await this.all<SecretMetadata & { value: string }>(
      this.db.select().from(this.schema.secrets).orderBy(this.schema.secrets.label)
    );
    return rows.map(({ value: _value, ...metadata }) => metadata);
  }

  async createSecret(label: string, value: string): Promise<SecretMetadata> {
    const timestamp = nowIso();
    const secret = { id: uuidv7(), label, value, createdAt: timestamp, updatedAt: timestamp };
    const inserted = await this.returning<typeof secret>(this.db.insert(this.schema.secrets).values(secret).returning());
    const { value: _value, ...metadata } = inserted;
    return metadata;
  }

  async resolveSecret(id: string): Promise<string | undefined> {
    const row = await this.get<{ value: string }>(this.db.select({ value: this.schema.secrets.value }).from(this.schema.secrets).where(eq(this.schema.secrets.id, id)));
    return row?.value;
  }

  async deleteSecret(id: string): Promise<ResourceDeletionResult> {
    const secret = await this.get<{ id: string }>(this.db.select({ id: this.schema.secrets.id }).from(this.schema.secrets).where(eq(this.schema.secrets.id, id)));
    if (!secret) return { deleted: false, references: [] };
    const references = await this.secretReferences(id);
    if (references.length > 0) return { deleted: false, references };
    const deleted = await this.returningOrNull<{ id: string }>(
      this.db.delete(this.schema.secrets).where(eq(this.schema.secrets.id, id)).returning({ id: this.schema.secrets.id })
    );
    return { deleted: Boolean(deleted), references: [] };
  }

  async saveAssetRevision(asset: AssetRevision): Promise<AssetRevision> {
    assetKindSchema.parse(asset.kind);
    const query = this.db.insert(this.schema.assetRevisions).values(asset).onConflictDoNothing().returning();
    const inserted = await this.returningOrNull<AssetRevision>(query);
    if (inserted) return inserted;
    const existing = await this.get<AssetRevision>(this.db.select().from(this.schema.assetRevisions).where(eq(this.schema.assetRevisions.id, asset.id)));
    if (!existing) throw new Error(`Asset revision ${asset.id} conflicted but was not found`);
    return existing;
  }

  async listAssetRevisions(kind?: AssetKind, includeArchived = false): Promise<AssetRevision[]> {
    const base = this.db.select().from(this.schema.assetRevisions);
    const conditions = [
      ...(kind ? [eq(this.schema.assetRevisions.kind, kind)] : []),
      ...(!includeArchived ? [isNull(this.schema.assetRevisions.archivedAt)] : [])
    ];
    const query = conditions.length > 0 ? base.where(and(...conditions)) : base;
    return this.all(query.orderBy(this.schema.assetRevisions.kind, this.schema.assetRevisions.name, desc(this.schema.assetRevisions.revision)));
  }

  async deleteAssetRevision(id: string): Promise<ResourceDeletionResult> {
    const asset = await this.get<AssetRevision>(this.db.select().from(this.schema.assetRevisions).where(eq(this.schema.assetRevisions.id, id)));
    if (!asset || asset.archivedAt) return { deleted: false, references: [] };
    const references = await this.assetReferences(id);
    if (references.length > 0) return { deleted: false, references };
    const archived = await this.returningOrNull<AssetRevision>(
      this.db.update(this.schema.assetRevisions)
        .set({ archivedAt: nowIso() })
        .where(and(eq(this.schema.assetRevisions.id, id), isNull(this.schema.assetRevisions.archivedAt)))
        .returning()
    );
    return { deleted: Boolean(archived), references: [] };
  }

  private async referenceRows(): Promise<{
    projects: Project[];
    sessions: Session[];
    checkpoints: Checkpoint[];
    snapshots: ConfigSnapshot[];
    assets: AssetRevision[];
    jobs: AutomationJob[];
    payloadSettings: PayloadWorkbenchSettings | null;
    sessionPayloadSettings: SessionPayloadWorkbenchSettings[];
    payloadGenerations: PayloadGeneration[];
    payloadAttempts: PayloadGenerationAttempt[];
    payloadRevisions: PayloadRevision[];
  }> {
    const [projects, sessions, checkpoints, snapshots, assets, jobs, payloadSettings, sessionPayloadSettings, payloadGenerations, payloadAttempts, payloadRevisions] = await Promise.all([
      this.all<Project>(this.db.select().from(this.schema.projects)),
      this.all<Session>(this.db.select().from(this.schema.sessions)),
      this.all<Checkpoint>(this.db.select().from(this.schema.checkpoints)),
      this.all<ConfigSnapshot>(this.db.select().from(this.schema.configSnapshots)),
      this.listAssetRevisions(),
      this.all<AutomationJob>(this.db.select().from(this.schema.automationJobs)),
      this.getPayloadWorkbenchSettings(),
      this.all<SessionPayloadWorkbenchSettings>(this.db.select().from(this.schema.sessionPayloadWorkbenchSettings)),
      this.all<PayloadGeneration>(this.db.select().from(this.schema.payloadGenerations)),
      this.all<PayloadGenerationAttempt>(this.db.select().from(this.schema.payloadGenerationAttempts)),
      this.all<PayloadRevision>(this.db.select().from(this.schema.payloadRevisions))
    ]);
    return { projects, sessions, checkpoints, snapshots, assets, jobs, payloadSettings, sessionPayloadSettings, payloadGenerations, payloadAttempts, payloadRevisions };
  }

  private async providerReferences(id: string): Promise<ResourceReference[]> {
    const { sessions, checkpoints, snapshots, assets, jobs, payloadAttempts } = await this.referenceRows();
    const references: ResourceReference[] = [];
    for (const session of sessions) {
      if (session.providerProfileId === id || session.draftConfig.provider?.profileId === id) {
        references.push({ kind: "session", id: session.id, label: session.name, detail: "selected provider or session draft" });
      }
    }
    for (const checkpoint of checkpoints) {
      if (checkpoint.providerProfileId === id) references.push({ kind: "checkpoint", id: checkpoint.id, label: checkpoint.name, detail: "captured provider" });
    }
    for (const snapshot of snapshots) {
      if (snapshot.config.provider?.profileId === id) references.push({ kind: "snapshot", id: snapshot.id, label: snapshot.id, detail: "saved provider configuration" });
    }
    for (const asset of assets) {
      if (jsonReferences(asset.value, id)) references.push(assetReference(asset, "saved revision value"));
    }
    for (const job of jobs) {
      if (jsonReferences(job.plan, id)) references.push({ kind: "automation", id: job.id, label: job.kind, detail: "saved automation plan" });
    }
    for (const attempt of payloadAttempts) {
      if (attempt.providerProfileId === id || jsonReferences(attempt.backendSnapshot, id)) {
        references.push({ kind: "payload-generation", id: attempt.generationId, label: attempt.generationId, detail: "payload generation backend evidence" });
      }
    }
    return uniqueReferences(references);
  }

  private async assetReferences(id: string): Promise<ResourceReference[]> {
    const { projects, sessions, snapshots, assets, jobs, payloadSettings, sessionPayloadSettings, payloadGenerations } = await this.referenceRows();
    const references: ResourceReference[] = [];
    for (const project of projects) {
      if (project.defaultHarnessRevisionId === id) references.push({ kind: "project", id: project.id, label: project.name, detail: "default harness" });
    }
    for (const session of sessions) {
      if (configReferencesAsset(session.draftConfig, id)) references.push({ kind: "session", id: session.id, label: session.name, detail: "session draft" });
    }
    for (const snapshot of snapshots) {
      if (configReferencesAsset(snapshot.config, id)) references.push({ kind: "snapshot", id: snapshot.id, label: snapshot.id, detail: "saved configuration" });
    }
    for (const asset of assets) {
      if (asset.id !== id && jsonReferences(asset.value, id)) references.push(assetReference(asset, "saved revision value"));
    }
    for (const job of jobs) {
      if (jsonReferences(job.plan, id)) references.push({ kind: "automation", id: job.id, label: job.kind, detail: "saved automation plan" });
    }
    if (payloadSettings?.defaultGeneratorProfileRevisionId === id || payloadSettings?.defaultInstructionRevisionId === id) {
      references.push({ kind: "payload-settings", id: payloadSettings.id, label: "Payload workbench defaults", detail: "selected default revision" });
    }
    for (const settings of sessionPayloadSettings) {
      if (
        settings.generatorProfileRevisionId === id
        || settings.instructionRevisionId === id
        || settings.pipelineRevisionId === id
        || settings.techniqueRevisionIds.includes(id)
      ) {
        const session = sessions.find((item) => item.id === settings.sessionId);
        references.push({
          kind: "payload-settings",
          id: settings.sessionId,
          label: session?.name ?? settings.sessionId,
          detail: "selected session Payload Workbench revision"
        });
      }
    }
    for (const generation of payloadGenerations) {
      if (
        generation.generatorProfileRevisionId === id
        || generation.instructionRevisionId === id
        || generation.pipelineRevisionId === id
        || generation.techniqueRevisionIds.includes(id)
      ) {
        references.push({ kind: "payload-generation", id: generation.id, label: generation.id, detail: "immutable payload generation configuration" });
      }
    }
    return uniqueReferences(references);
  }

  private async secretReferences(id: string): Promise<ResourceReference[]> {
    const { sessions, snapshots, assets, jobs, sessionPayloadSettings, payloadGenerations, payloadAttempts, payloadRevisions } = await this.referenceRows();
    const references: ResourceReference[] = [];
    for (const session of sessions) {
      if (jsonReferences(session.draftConfig as unknown as JsonValue, id)) references.push({ kind: "session", id: session.id, label: session.name, detail: "session draft" });
    }
    for (const snapshot of snapshots) {
      if (jsonReferences(snapshot.config as unknown as JsonValue, id)) references.push({ kind: "snapshot", id: snapshot.id, label: snapshot.id, detail: "saved configuration" });
    }
    for (const asset of assets) {
      if (jsonReferences(asset.value, id)) references.push(assetReference(asset, "credential reference"));
    }
    for (const job of jobs) {
      if (jsonReferences(job.plan, id)) references.push({ kind: "automation", id: job.id, label: job.kind, detail: "saved automation plan" });
    }
    for (const settings of sessionPayloadSettings) {
      if (jsonReferences(settings.variables, id)) {
        const session = sessions.find((item) => item.id === settings.sessionId);
        references.push({ kind: "payload-settings", id: settings.sessionId, label: session?.name ?? settings.sessionId, detail: "session Payload Workbench variables" });
      }
    }
    for (const generation of payloadGenerations) {
      if (
        jsonReferences(generation.variables, id)
        || jsonReferences(generation.contextSnapshot, id)
        || jsonReferences(generation.contextOptions as unknown as JsonValue, id)
      ) {
        references.push({ kind: "payload-generation", id: generation.id, label: generation.id, detail: "payload generation input or context" });
      }
    }
    for (const attempt of payloadAttempts) {
      if (jsonReferences(attempt.backendSnapshot, id) || (attempt.normalizedOutput !== null && jsonReferences(attempt.normalizedOutput, id))) {
        references.push({ kind: "payload-generation", id: attempt.generationId, label: attempt.generationId, detail: "payload generation backend evidence" });
      }
    }
    for (const revision of payloadRevisions) {
      if (jsonReferences(revision.provenance, id)) {
        references.push({ kind: "payload-revision", id: revision.id, label: `Payload revision ${revision.ordinal}`, detail: "payload provenance" });
      }
    }
    return uniqueReferences(references);
  }

  async saveAttachment(input: Omit<Attachment, "id" | "createdAt">): Promise<Attachment> {
    if (!await this.getProject(input.projectId)) throw new Error("Attachment project does not exist");
    const attachment: Attachment = { ...input, id: uuidv7(), createdAt: nowIso() };
    return this.returning(this.db.insert(this.schema.attachments).values(attachment).returning());
  }

  async getAttachment(id: string): Promise<Attachment | null> {
    return this.get(this.db.select().from(this.schema.attachments).where(eq(this.schema.attachments.id, id)));
  }

  async listAttachments(projectId: string): Promise<Attachment[]> {
    return this.all(this.db.select().from(this.schema.attachments).where(eq(this.schema.attachments.projectId, projectId)).orderBy(desc(this.schema.attachments.createdAt)));
  }

  async createFinding(input: CreateFindingInput): Promise<Finding> {
    const [project, session, branches] = await Promise.all([
      this.getProject(input.projectId),
      this.getSession(input.sessionId),
      this.listBranches(input.sessionId)
    ]);
    if (!project) throw new Error("Finding project does not exist");
    if (!session || session.projectId !== input.projectId) throw new Error("Finding session does not belong to project");
    if (!branches.some((branch) => branch.id === input.branchId)) throw new Error("Finding branch does not belong to session");
    if (input.nodeId) {
      const node = await this.getNode(input.nodeId);
      if (!node || node.sessionId !== input.sessionId) throw new Error("Finding node does not belong to session");
    }
    const timestamp = nowIso();
    const finding: Finding = { ...input, id: uuidv7(), createdAt: timestamp, updatedAt: timestamp };
    return this.returning(this.db.insert(this.schema.findings).values(finding).returning());
  }

  async listFindings(projectId: string): Promise<Finding[]> {
    return this.all(this.db.select().from(this.schema.findings).where(eq(this.schema.findings.projectId, projectId)).orderBy(desc(this.schema.findings.updatedAt)));
  }

  async createAutomationJob(input: CreateAutomationInput): Promise<AutomationJob> {
    const [project, session] = await Promise.all([this.getProject(input.projectId), this.getSession(input.sessionId)]);
    if (!project) throw new Error("Automation project does not exist");
    if (!session || session.projectId !== input.projectId) throw new Error("Automation session does not belong to project");
    const timestamp = nowIso();
    const job: AutomationJob = { ...input, id: uuidv7(), status: "queued", progress: {}, error: null, createdAt: timestamp, updatedAt: timestamp };
    return this.returning(this.db.insert(this.schema.automationJobs).values(job).returning());
  }

  async getAutomationJob(id: string): Promise<AutomationJob | null> {
    return this.get(this.db.select().from(this.schema.automationJobs).where(eq(this.schema.automationJobs.id, id)));
  }

  async updateAutomationJob(id: string, patch: Partial<Pick<AutomationJob, "status" | "progress" | "error">>): Promise<AutomationJob | null> {
    return this.returningOrNull(this.db.update(this.schema.automationJobs).set({ ...patch, updatedAt: nowIso() }).where(eq(this.schema.automationJobs.id, id)).returning());
  }

  async listAutomationJobs(sessionId: string): Promise<AutomationJob[]> {
    return this.all(this.db.select().from(this.schema.automationJobs).where(eq(this.schema.automationJobs.sessionId, sessionId)).orderBy(desc(this.schema.automationJobs.createdAt)));
  }

  async getApplicationSettings(): Promise<ApplicationSettings> {
    const existing = await this.get<ApplicationSettings>(
      this.db.select().from(this.schema.applicationSettings).where(eq(this.schema.applicationSettings.id, "global"))
    );
    if (existing) return existing;

    const timestamp = nowIso();
    const defaults: ApplicationSettings = {
      id: "global",
      redactionEnabled: true,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    await this.run(
      this.db.insert(this.schema.applicationSettings).values(defaults).onConflictDoNothing()
    );
    const stored = await this.get<ApplicationSettings>(
      this.db.select().from(this.schema.applicationSettings).where(eq(this.schema.applicationSettings.id, "global"))
    );
    if (!stored) throw new Error("Application settings could not be initialized");
    return stored;
  }

  async upsertApplicationSettings(input: ApplicationSettingsInput): Promise<ApplicationSettings> {
    const parsed = applicationSettingsInputSchema.parse(input);
    const timestamp = nowIso();
    const settings: ApplicationSettings = {
      id: "global",
      ...parsed,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return this.returning(
      this.db.insert(this.schema.applicationSettings).values(settings).onConflictDoUpdate({
        target: this.schema.applicationSettings.id,
        set: { ...parsed, updatedAt: timestamp }
      }).returning()
    );
  }

  private async requireAssetRevision(id: string, kind: AssetKind, label: string): Promise<AssetRevision> {
    const asset = await this.get<AssetRevision>(
      this.db.select().from(this.schema.assetRevisions).where(eq(this.schema.assetRevisions.id, id))
    );
    if (!asset || asset.archivedAt) throw new Error(`${label} revision does not exist`);
    if (asset.kind !== kind) throw new Error(`${label} revision must be a ${kind} asset`);
    return asset;
  }

  async getPayloadWorkbenchSettings(): Promise<PayloadWorkbenchSettings | null> {
    return this.get(
      this.db.select().from(this.schema.payloadWorkbenchSettings).where(eq(this.schema.payloadWorkbenchSettings.id, "global"))
    );
  }

  async upsertPayloadWorkbenchSettings(input: PayloadWorkbenchSettingsInput): Promise<PayloadWorkbenchSettings> {
    const parsed = payloadWorkbenchSettingsInputSchema.parse(input);
    if (parsed.defaultGeneratorProfileRevisionId) {
      await this.requireAssetRevision(parsed.defaultGeneratorProfileRevisionId, "payload-generator-profile", "Default generator profile");
    }
    if (parsed.defaultInstructionRevisionId) {
      await this.requireAssetRevision(parsed.defaultInstructionRevisionId, "payload-generator-instruction", "Default generator instruction");
    }
    const timestamp = nowIso();
    const settings: PayloadWorkbenchSettings = { id: "global", ...parsed, createdAt: timestamp, updatedAt: timestamp };
    return this.returning(
      this.db.insert(this.schema.payloadWorkbenchSettings).values(settings).onConflictDoUpdate({
        target: this.schema.payloadWorkbenchSettings.id,
        set: { ...parsed, updatedAt: timestamp }
      }).returning()
    );
  }

  async deletePayloadWorkbenchSettings(): Promise<boolean> {
    return Boolean(await this.returningOrNull<PayloadWorkbenchSettings>(
      this.db.delete(this.schema.payloadWorkbenchSettings)
        .where(eq(this.schema.payloadWorkbenchSettings.id, "global"))
        .returning()
    ));
  }

  async getSessionPayloadWorkbenchSettings(sessionId: string): Promise<SessionPayloadWorkbenchSettings | null> {
    return this.get(
      this.db.select().from(this.schema.sessionPayloadWorkbenchSettings)
        .where(eq(this.schema.sessionPayloadWorkbenchSettings.sessionId, sessionId))
    );
  }

  async upsertSessionPayloadWorkbenchSettings(
    sessionId: string,
    input: SessionPayloadWorkbenchSettingsInput
  ): Promise<SessionPayloadWorkbenchSettings> {
    const parsed = sessionPayloadWorkbenchSettingsInputSchema.parse(input);
    if (!await this.getSession(sessionId)) throw new Error("Payload Workbench session does not exist");
    if (parsed.generatorProfileRevisionId) {
      await this.requireAssetRevision(parsed.generatorProfileRevisionId, "payload-generator-profile", "Generator profile");
    }
    if (parsed.instructionRevisionId) {
      await this.requireAssetRevision(parsed.instructionRevisionId, "payload-generator-instruction", "Generator instruction");
    }
    for (const techniqueRevisionId of parsed.techniqueRevisionIds) {
      await this.requireAssetRevision(techniqueRevisionId, "payload-technique", "Technique");
    }
    if (parsed.pipelineRevisionId) {
      await this.requireAssetRevision(parsed.pipelineRevisionId, "payload-pipeline", "Pipeline");
    }

    const timestamp = nowIso();
    const settings: SessionPayloadWorkbenchSettings = {
      sessionId,
      ...parsed,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return this.returning(
      this.db.insert(this.schema.sessionPayloadWorkbenchSettings).values(settings).onConflictDoUpdate({
        target: this.schema.sessionPayloadWorkbenchSettings.sessionId,
        set: { ...parsed, updatedAt: timestamp }
      }).returning()
    );
  }

  private async validatePayloadGenerationReferences(input: {
    projectId: string;
    sessionId: string;
    branchId: string;
    contextNodeId: string | null;
    parentRevisionId: string | null;
    feedback: string | null;
    generatorProfileRevisionId: string;
    instructionRevisionId: string | null;
    techniqueRevisionIds: string[];
    pipelineRevisionId: string | null;
  }): Promise<void> {
    const [project, session, branches] = await Promise.all([
      this.getProject(input.projectId),
      this.getSession(input.sessionId),
      this.listBranches(input.sessionId)
    ]);
    if (!project) throw new Error("Payload generation project does not exist");
    if (!session || session.projectId !== input.projectId) throw new Error("Payload generation session does not belong to project");
    if (!branches.some((branch) => branch.id === input.branchId)) throw new Error("Payload generation branch does not belong to session");
    if (input.contextNodeId) {
      const node = await this.getNode(input.contextNodeId);
      if (!node || node.sessionId !== input.sessionId) throw new Error("Payload generation context node does not belong to session");
    }
    if (input.parentRevisionId) {
      const parent = await this.getPayloadRevision(input.parentRevisionId);
      if (!parent || parent.projectId !== input.projectId || parent.sessionId !== input.sessionId) {
        throw new Error("Parent payload revision does not belong to session");
      }
    } else if (input.feedback !== null) {
      throw new Error("Payload generation feedback requires a parent revision");
    }
    await this.requireAssetRevision(input.generatorProfileRevisionId, "payload-generator-profile", "Generator profile");
    if (input.instructionRevisionId) {
      await this.requireAssetRevision(input.instructionRevisionId, "payload-generator-instruction", "Generator instruction");
    }
    for (const techniqueRevisionId of input.techniqueRevisionIds) {
      await this.requireAssetRevision(techniqueRevisionId, "payload-technique", "Technique");
    }
    if (input.pipelineRevisionId) {
      await this.requireAssetRevision(input.pipelineRevisionId, "payload-pipeline", "Pipeline");
    }
  }

  async createPayloadGeneration(input: CreatePayloadGenerationInput): Promise<PayloadGeneration> {
    const parsed = createPayloadGenerationSchema.parse(input);
    await this.validatePayloadGenerationReferences(parsed);
    const timestamp = nowIso();
    const generation: PayloadGeneration = {
      ...parsed,
      id: uuidv7(),
      contextHash: sha256Json(parsed.contextSnapshot),
      status: "queued",
      createdAt: timestamp,
      updatedAt: timestamp,
      deletedAt: null
    };
    return this.returning(this.db.insert(this.schema.payloadGenerations).values(generation).returning());
  }

  async getPayloadGeneration(id: string, includeDeleted = false): Promise<PayloadGeneration | null> {
    const condition = includeDeleted
      ? eq(this.schema.payloadGenerations.id, id)
      : and(eq(this.schema.payloadGenerations.id, id), isNull(this.schema.payloadGenerations.deletedAt));
    return this.get(this.db.select().from(this.schema.payloadGenerations).where(condition));
  }

  async getActivePayloadGeneration(sessionId: string): Promise<PayloadGeneration | null> {
    return this.get(
      this.db.select().from(this.schema.payloadGenerations).where(and(
        eq(this.schema.payloadGenerations.sessionId, sessionId),
        isNull(this.schema.payloadGenerations.deletedAt),
        inArray(this.schema.payloadGenerations.status, ["queued", "streaming"])
      )).orderBy(desc(this.schema.payloadGenerations.createdAt))
    );
  }

  async listPayloadGenerations(sessionId: string, includeDeleted = false): Promise<PayloadGeneration[]> {
    const condition = includeDeleted
      ? eq(this.schema.payloadGenerations.sessionId, sessionId)
      : and(eq(this.schema.payloadGenerations.sessionId, sessionId), isNull(this.schema.payloadGenerations.deletedAt));
    return this.all(this.db.select().from(this.schema.payloadGenerations).where(condition).orderBy(desc(this.schema.payloadGenerations.createdAt)));
  }

  async updatePayloadGeneration(id: string, patch: { status: PayloadGeneration["status"] }): Promise<PayloadGeneration | null> {
    const parsed = updatePayloadGenerationSchema.parse(patch);
    return this.returningOrNull(
      this.db.update(this.schema.payloadGenerations)
        .set({ ...parsed, updatedAt: nowIso() })
        .where(and(eq(this.schema.payloadGenerations.id, id), isNull(this.schema.payloadGenerations.deletedAt)))
        .returning()
    );
  }

  async deletePayloadGeneration(id: string): Promise<ResourceDeletionResult> {
    const generation = await this.getPayloadGeneration(id);
    if (!generation) return { deleted: false, references: [] };
    const ownRevisions = await this.listPayloadRevisionsForGeneration(id, true);
    const ownRevisionIds = new Set(ownRevisions.map((revision) => revision.id));
    const [nodes, generations, revisions] = await Promise.all([
      this.all<MessageNode>(this.db.select().from(this.schema.messageNodes)),
      this.all<PayloadGeneration>(this.db.select().from(this.schema.payloadGenerations)),
      this.all<PayloadRevision>(this.db.select().from(this.schema.payloadRevisions))
    ]);
    const references: ResourceReference[] = [
      ...nodes.filter((node) => node.sourcePayloadRevisionId && ownRevisionIds.has(node.sourcePayloadRevisionId)).map((node) => ({
        kind: "message" as const, id: node.id, label: node.id, detail: "message source payload"
      })),
      ...generations.filter((child) => child.id !== id && child.deletedAt === null && child.parentRevisionId && ownRevisionIds.has(child.parentRevisionId)).map((child) => ({
        kind: "payload-generation" as const, id: child.id, label: child.id, detail: "refinement based on this generation"
      })),
      ...revisions.filter((child) => child.generationId !== id && child.deletedAt === null && child.parentRevisionId && ownRevisionIds.has(child.parentRevisionId)).map((child) => ({
        kind: "payload-revision" as const, id: child.id, label: `Payload revision ${child.ordinal}`, detail: "derived outside this generation"
      }))
    ];
    if (references.length > 0) return { deleted: false, references };
    let timestamp = nowIso();
    const existingTombstones = new Set(ownRevisions.map((revision) => revision.deletedAt).filter((value): value is string => value !== null));
    while (existingTombstones.has(timestamp)) timestamp = new Date(Date.parse(timestamp) + 1).toISOString();
    if (this.dialect === "sqlite") {
      const deleted = this.db.transaction((tx: any) => {
        const row = tx.update(this.schema.payloadGenerations).set({ deletedAt: timestamp, updatedAt: timestamp })
          .where(and(eq(this.schema.payloadGenerations.id, id), isNull(this.schema.payloadGenerations.deletedAt))).returning().get() as PayloadGeneration | undefined;
        if (!row) return false;
        tx.update(this.schema.payloadRevisions).set({ deletedAt: timestamp })
          .where(and(eq(this.schema.payloadRevisions.generationId, id), isNull(this.schema.payloadRevisions.deletedAt))).run();
        return true;
      }) as boolean;
      return { deleted, references: [] };
    }
    const deleted = await this.db.transaction(async (tx: any) => {
      const rows = await tx.update(this.schema.payloadGenerations).set({ deletedAt: timestamp, updatedAt: timestamp })
        .where(and(eq(this.schema.payloadGenerations.id, id), isNull(this.schema.payloadGenerations.deletedAt))).returning() as PayloadGeneration[];
      if (rows.length === 0) return false;
      await tx.update(this.schema.payloadRevisions).set({ deletedAt: timestamp })
        .where(and(eq(this.schema.payloadRevisions.generationId, id), isNull(this.schema.payloadRevisions.deletedAt)));
      return true;
    }) as boolean;
    return { deleted, references: [] };
  }

  async restorePayloadGeneration(id: string): Promise<PayloadGeneration | null> {
    const generation = await this.getPayloadGeneration(id, true);
    if (!generation || !generation.deletedAt) return null;
    await this.validatePayloadGenerationReferences(generation);
    const deletedAt = generation.deletedAt;
    const timestamp = nowIso();
    if (this.dialect === "sqlite") {
      return this.db.transaction((tx: any) => {
        const restored = tx.update(this.schema.payloadGenerations).set({ deletedAt: null, updatedAt: timestamp })
          .where(and(eq(this.schema.payloadGenerations.id, id), eq(this.schema.payloadGenerations.deletedAt, deletedAt))).returning().get() as PayloadGeneration | undefined;
        if (!restored) return null;
        tx.update(this.schema.payloadRevisions).set({ deletedAt: null })
          .where(and(eq(this.schema.payloadRevisions.generationId, id), eq(this.schema.payloadRevisions.deletedAt, deletedAt))).run();
        return restored;
      }) as PayloadGeneration | null;
    }
    return this.db.transaction(async (tx: any) => {
      const rows = await tx.update(this.schema.payloadGenerations).set({ deletedAt: null, updatedAt: timestamp })
        .where(and(eq(this.schema.payloadGenerations.id, id), eq(this.schema.payloadGenerations.deletedAt, deletedAt))).returning() as PayloadGeneration[];
      const restored = rows[0];
      if (!restored) return null;
      await tx.update(this.schema.payloadRevisions).set({ deletedAt: null })
        .where(and(eq(this.schema.payloadRevisions.generationId, id), eq(this.schema.payloadRevisions.deletedAt, deletedAt)));
      return restored;
    }) as PayloadGeneration | null;
  }

  async createPayloadGenerationAttempt(input: CreatePayloadGenerationAttemptInput): Promise<PayloadGenerationAttempt> {
    const parsed = createPayloadGenerationAttemptSchema.parse(input);
    const generation = await this.getPayloadGeneration(parsed.generationId);
    if (!generation) throw new Error("Payload generation attempt generation does not exist");
    if (parsed.providerProfileId && !await this.getProviderProfile(parsed.providerProfileId)) {
      throw new Error("Payload generation attempt provider profile does not exist");
    }
    if (parsed.configSnapshotId) {
      const snapshot = await this.getConfigSnapshot(parsed.configSnapshotId);
      if (!snapshot || snapshot.sessionId !== generation.sessionId) {
        throw new Error("Payload generation attempt configuration does not belong to session");
      }
    }
    const timestamp = nowIso();
    const attempt: PayloadGenerationAttempt = {
      ...parsed,
      id: uuidv7(),
      status: "queued",
      classification: null,
      normalizedOutput: null,
      usage: null,
      traceHash: null,
      startedAt: null,
      finishedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp
    };
    return this.returning(this.db.insert(this.schema.payloadGenerationAttempts).values(attempt).returning());
  }

  async getPayloadGenerationAttempt(id: string): Promise<PayloadGenerationAttempt | null> {
    return this.get(this.db.select().from(this.schema.payloadGenerationAttempts).where(eq(this.schema.payloadGenerationAttempts.id, id)));
  }

  async listPayloadGenerationAttempts(generationId: string): Promise<PayloadGenerationAttempt[]> {
    return this.all(this.db.select().from(this.schema.payloadGenerationAttempts)
      .where(eq(this.schema.payloadGenerationAttempts.generationId, generationId))
      .orderBy(this.schema.payloadGenerationAttempts.ordinal));
  }

  async updatePayloadGenerationAttempt(
    id: string,
    patch: Partial<Pick<PayloadGenerationAttempt, "status" | "classification" | "normalizedOutput" | "usage" | "traceHash" | "nativeThreadId" | "nativeTurnId" | "startedAt" | "finishedAt">>
  ): Promise<PayloadGenerationAttempt | null> {
    const parsed = updatePayloadGenerationAttemptSchema.parse(patch);
    return this.returningOrNull(
      this.db.update(this.schema.payloadGenerationAttempts).set({ ...parsed, updatedAt: nowIso() })
        .where(eq(this.schema.payloadGenerationAttempts.id, id)).returning()
    );
  }

  async createPayloadRevision(input: CreatePayloadRevisionInput): Promise<PayloadRevision> {
    const parsed = createPayloadRevisionSchema.parse(input);
    const [project, session] = await Promise.all([this.getProject(parsed.projectId), this.getSession(parsed.sessionId)]);
    if (!project) throw new Error("Payload revision project does not exist");
    if (!session || session.projectId !== parsed.projectId) throw new Error("Payload revision session does not belong to project");

    let generation: PayloadGeneration | null = null;
    if (parsed.generationId) {
      generation = await this.getPayloadGeneration(parsed.generationId);
      if (!generation || generation.projectId !== parsed.projectId || generation.sessionId !== parsed.sessionId) {
        throw new Error("Payload revision generation does not belong to session");
      }
    }
    if (parsed.attemptId) {
      const attempt = await this.getPayloadGenerationAttempt(parsed.attemptId);
      if (!attempt || !generation || attempt.generationId !== generation.id) {
        throw new Error("Payload revision attempt does not belong to generation");
      }
    }
    if (parsed.parentRevisionId) {
      const parent = await this.getPayloadRevision(parsed.parentRevisionId);
      if (!parent || parent.projectId !== parsed.projectId || parent.sessionId !== parsed.sessionId) {
        throw new Error("Parent payload revision does not belong to session");
      }
    }
    if (parsed.operation === "generated") {
      if (!generation || !parsed.attemptId || parsed.parentRevisionId) {
        throw new Error("Generated payload revisions require a generation and attempt, without a parent revision");
      }
    } else if (parsed.operation === "refined") {
      if (!generation || !parsed.attemptId || !parsed.parentRevisionId) {
        throw new Error("Refined payload revisions require a generation, attempt, and parent revision");
      }
    } else if (parsed.operation === "transformed") {
      if (!parsed.parentRevisionId || parsed.attemptId) {
        throw new Error("Transformed payload revisions require a parent revision and cannot claim a generation attempt");
      }
    } else if (parsed.operation === "edited") {
      if (parsed.attemptId) throw new Error("Edited payload revisions cannot claim a generation attempt");
      if (!parsed.parentRevisionId && generation) {
        throw new Error("A root edited payload revision cannot reference generation evidence");
      }
    }

    const revision: PayloadRevision = {
      ...parsed,
      id: uuidv7(),
      contentHash: sha256Json(parsed.text),
      createdAt: nowIso(),
      deletedAt: null
    };
    return this.returning(this.db.insert(this.schema.payloadRevisions).values(revision).returning());
  }

  async getPayloadRevision(id: string, includeDeleted = false): Promise<PayloadRevision | null> {
    const condition = includeDeleted
      ? eq(this.schema.payloadRevisions.id, id)
      : and(eq(this.schema.payloadRevisions.id, id), isNull(this.schema.payloadRevisions.deletedAt));
    return this.get(this.db.select().from(this.schema.payloadRevisions).where(condition));
  }

  async listPayloadRevisions(sessionId: string, includeDeleted = false): Promise<PayloadRevision[]> {
    const condition = includeDeleted
      ? eq(this.schema.payloadRevisions.sessionId, sessionId)
      : and(eq(this.schema.payloadRevisions.sessionId, sessionId), isNull(this.schema.payloadRevisions.deletedAt));
    return this.all(this.db.select().from(this.schema.payloadRevisions).where(condition).orderBy(desc(this.schema.payloadRevisions.createdAt)));
  }

  async listPayloadRevisionsForGeneration(generationId: string, includeDeleted = false): Promise<PayloadRevision[]> {
    const condition = includeDeleted
      ? eq(this.schema.payloadRevisions.generationId, generationId)
      : and(eq(this.schema.payloadRevisions.generationId, generationId), isNull(this.schema.payloadRevisions.deletedAt));
    return this.all(this.db.select().from(this.schema.payloadRevisions).where(condition).orderBy(this.schema.payloadRevisions.ordinal));
  }

  async deletePayloadRevision(id: string): Promise<ResourceDeletionResult> {
    const revision = await this.getPayloadRevision(id);
    if (!revision) return { deleted: false, references: [] };
    const [nodes, generations, revisions] = await Promise.all([
      this.all<MessageNode>(this.db.select().from(this.schema.messageNodes).where(eq(this.schema.messageNodes.sourcePayloadRevisionId, id))),
      this.all<PayloadGeneration>(this.db.select().from(this.schema.payloadGenerations)
        .where(and(eq(this.schema.payloadGenerations.parentRevisionId, id), isNull(this.schema.payloadGenerations.deletedAt)))),
      this.all<PayloadRevision>(this.db.select().from(this.schema.payloadRevisions)
        .where(and(eq(this.schema.payloadRevisions.parentRevisionId, id), isNull(this.schema.payloadRevisions.deletedAt))))
    ]);
    const references: ResourceReference[] = [
      ...nodes.map((node) => ({ kind: "message" as const, id: node.id, label: node.id, detail: "message source payload" })),
      ...generations.map((generation) => ({ kind: "payload-generation" as const, id: generation.id, label: generation.id, detail: "generation parent payload" })),
      ...revisions.map((child) => ({ kind: "payload-revision" as const, id: child.id, label: `Payload revision ${child.ordinal}`, detail: "derived payload" }))
    ];
    if (references.length > 0) return { deleted: false, references };
    const deleted = await this.returningOrNull<PayloadRevision>(
      this.db.update(this.schema.payloadRevisions).set({ deletedAt: nowIso() })
        .where(and(eq(this.schema.payloadRevisions.id, id), isNull(this.schema.payloadRevisions.deletedAt))).returning()
    );
    return { deleted: Boolean(deleted), references: [] };
  }

  async restorePayloadRevision(id: string): Promise<PayloadRevision | null> {
    const revision = await this.getPayloadRevision(id, true);
    if (!revision || !revision.deletedAt) return null;
    const session = await this.getSession(revision.sessionId);
    if (!session || session.projectId !== revision.projectId) throw new Error("Payload revision session no longer belongs to project");
    if (revision.generationId) {
      const generation = await this.getPayloadGeneration(revision.generationId);
      if (!generation || generation.sessionId !== revision.sessionId) throw new Error("Payload revision generation is unavailable");
    }
    if (revision.parentRevisionId) {
      const parent = await this.getPayloadRevision(revision.parentRevisionId);
      if (!parent || parent.sessionId !== revision.sessionId) throw new Error("Parent payload revision is unavailable");
    }
    return this.returningOrNull(
      this.db.update(this.schema.payloadRevisions).set({ deletedAt: null })
        .where(eq(this.schema.payloadRevisions.id, id)).returning()
    );
  }

  async markRunningJobsInterrupted(): Promise<void> {
    const timestamp = nowIso();
    await this.run(this.db.update(this.schema.automationJobs).set({ status: "interrupted", updatedAt: timestamp }).where(inArray(this.schema.automationJobs.status, ["queued", "running"])));
    await this.run(this.db.update(this.schema.modelRuns).set({ status: "interrupted", classification: "interrupted-stream", finishedAt: timestamp }).where(inArray(this.schema.modelRuns.status, ["queued", "streaming"])));
    await this.run(this.db.update(this.schema.payloadGenerations).set({ status: "interrupted", updatedAt: timestamp }).where(inArray(this.schema.payloadGenerations.status, ["queued", "streaming"])));
    await this.run(this.db.update(this.schema.payloadGenerationAttempts).set({ status: "interrupted", classification: "interrupted-stream", finishedAt: timestamp, updatedAt: timestamp }).where(inArray(this.schema.payloadGenerationAttempts.status, ["queued", "streaming"])));
  }
}
