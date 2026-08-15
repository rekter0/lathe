import type { JsonValue, ResolvedConfig } from "@lathe/domain";

export interface StartRunInput {
  sessionId: string;
  branchId: string;
  contextNodeId: string | null;
  userMessage?: string;
  configOverride?: ResolvedConfig;
}

export interface StartedRun {
  id: string;
  status: string;
}

export interface RunCoordinator {
  start(input: StartRunInput): Promise<StartedRun>;
  cancel(runId: string): Promise<boolean>;
  resolveToolCall(runId: string, callId: string, resolution: JsonValue): Promise<void>;
  resolveMcpApproval(runId: string, approvalId: string, resolution: JsonValue): Promise<void>;
}

export class UnavailableRunCoordinator implements RunCoordinator {
  async start(): Promise<StartedRun> {
    throw new Error("Provider run coordinator is unavailable");
  }
  async cancel(): Promise<boolean> {
    return false;
  }
  async resolveToolCall(): Promise<void> {
    throw new Error("Provider run coordinator is unavailable");
  }
  async resolveMcpApproval(): Promise<void> {
    throw new Error("Provider run coordinator is unavailable");
  }
}
