import {
  pathToRoot,
  type JsonObject,
  type JsonValue,
  type ModelRun
} from "@lathe/domain";
import type { LatheRepository } from "@lathe/db";
import {
  compilePayloadContext,
  type CompiledPayloadContext,
  type PayloadContextOptions
} from "@lathe/payloads";

function object(value: JsonValue | null): JsonObject {
  return value && typeof value === "object" && !Array.isArray(value) ? value : {};
}

function reasoningForRun(run: ModelRun | undefined): string | null {
  if (!run) return null;
  const reasoning = object(run.normalizedOutput).reasoning;
  return typeof reasoning === "string" && reasoning.length > 0 ? reasoning : null;
}

export interface ResolvedPayloadContext {
  readonly projectId: string;
  readonly sessionId: string;
  readonly branchId: string;
  readonly contextNodeId: string | null;
  readonly compiled: CompiledPayloadContext;
  readonly variables: Readonly<Record<string, string>>;
}

export async function resolvePayloadContext(
  repository: LatheRepository,
  input: {
    readonly sessionId: string;
    readonly branchId: string;
    readonly contextNodeId: string | null;
    readonly options: PayloadContextOptions;
    readonly variableOverrides?: Readonly<Record<string, string>>;
  }
): Promise<ResolvedPayloadContext> {
  const session = await repository.getSession(input.sessionId);
  if (!session) throw new Error("Session not found");
  const project = await repository.getProject(session.projectId);
  if (!project) throw new Error("Project not found");
  const branch = (await repository.listBranches(session.id)).find((item) => item.id === input.branchId);
  if (!branch) throw new Error("Branch not found");
  if (branch.headNodeId !== input.contextNodeId) throw new Error("Payload context is stale; refresh the active branch before generating");
  const nodes = await repository.listNodes(session.id);
  const path = pathToRoot(nodes, input.contextNodeId);
  const runs = await repository.listRuns(session.id);
  const runsById = new Map(runs.map((run) => [run.id, run]));
  const compiled = compilePayloadContext({
    project: { name: project.name, description: project.description, targetName: project.targetName },
    session: { name: session.name, description: session.description, config: session.draftConfig },
    branch: {
      name: branch.name,
      nodes: path.map((node) => ({
        id: node.id,
        role: node.role,
        parts: node.parts,
        reasoning: node.sourceRunId ? reasoningForRun(runsById.get(node.sourceRunId)) : null
      }))
    },
    options: input.options
  });
  const objective = session.description.trim() || project.description.trim();
  const targetName = project.targetName.trim();
  const defaults: Record<string, string> = {
    project_name: project.name,
    session_name: session.name,
    branch_name: branch.name,
    ...(objective ? { objective } : {}),
    ...(targetName ? { target_name: targetName } : {})
  };
  return {
    projectId: project.id,
    sessionId: session.id,
    branchId: branch.id,
    contextNodeId: input.contextNodeId,
    compiled,
    variables: { ...defaults, ...input.variableOverrides }
  };
}
