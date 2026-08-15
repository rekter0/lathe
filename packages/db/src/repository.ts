import { and, desc, eq, inArray, isNull } from "drizzle-orm";
import {
  emptyResolvedConfig,
  nowIso,
  sha256Json,
  uuidv7,
  type AssetKind,
  type AssetRevision,
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
  type Project,
  type ProviderProfile,
  type ResolvedConfig,
  type RunClassification,
  type RunStatus,
  type SecretMetadata,
  type Session
} from "@lathe/domain";

export interface CreateProjectInput {
  name: string;
  description?: string;
  workspaceRoot?: string | null;
  defaultHarnessRevisionId?: string | null;
}

export interface CreateSessionInput {
  projectId: string;
  name: string;
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
  kind: "project" | "session" | "checkpoint" | "snapshot" | "asset" | "automation";
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
      id: uuidv7(), projectId: input.projectId, name: input.name, providerProfileId: input.providerProfileId ?? null,
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
    const node: MessageNode = {
      id: input.id ?? uuidv7(), sessionId: input.sessionId, parentId: input.parentId ?? null, role: input.role, parts: input.parts,
      sourceRunId: input.sourceRunId ?? null, configSnapshotId: input.configSnapshotId ?? null, createdAt: nowIso()
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
  }> {
    const [projects, sessions, checkpoints, snapshots, assets, jobs] = await Promise.all([
      this.all<Project>(this.db.select().from(this.schema.projects)),
      this.all<Session>(this.db.select().from(this.schema.sessions)),
      this.all<Checkpoint>(this.db.select().from(this.schema.checkpoints)),
      this.all<ConfigSnapshot>(this.db.select().from(this.schema.configSnapshots)),
      this.listAssetRevisions(),
      this.all<AutomationJob>(this.db.select().from(this.schema.automationJobs))
    ]);
    return { projects, sessions, checkpoints, snapshots, assets, jobs };
  }

  private async providerReferences(id: string): Promise<ResourceReference[]> {
    const { sessions, checkpoints, snapshots, assets, jobs } = await this.referenceRows();
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
    return uniqueReferences(references);
  }

  private async assetReferences(id: string): Promise<ResourceReference[]> {
    const { projects, sessions, snapshots, assets, jobs } = await this.referenceRows();
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
    return uniqueReferences(references);
  }

  private async secretReferences(id: string): Promise<ResourceReference[]> {
    const { sessions, snapshots, assets, jobs } = await this.referenceRows();
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

  async markRunningJobsInterrupted(): Promise<void> {
    const timestamp = nowIso();
    await this.run(this.db.update(this.schema.automationJobs).set({ status: "interrupted", updatedAt: timestamp }).where(inArray(this.schema.automationJobs.status, ["queued", "running"])));
    await this.run(this.db.update(this.schema.modelRuns).set({ status: "interrupted", classification: "interrupted-stream", finishedAt: timestamp }).where(inArray(this.schema.modelRuns.status, ["queued", "streaming"])));
  }
}
