import type {
  AssetRevision,
  Attachment,
  AutomationJob,
  BranchRef,
  Checkpoint,
  Finding,
  MessageNode,
  ModelRun,
  Project,
  ProviderProfile,
  Session
} from "@lathe/domain";

export interface SafeProvider extends Omit<ProviderProfile, "credential"> {
  hasCredential: boolean;
}

export interface WorkbenchData {
  session: Session;
  nodes: MessageNode[];
  branches: BranchRef[];
  checkpoints: Checkpoint[];
  runs: ModelRun[];
  attachments: Attachment[];
}

export type { AssetRevision, Attachment, AutomationJob, BranchRef, Checkpoint, Finding, MessageNode, ModelRun, Project, Session };
