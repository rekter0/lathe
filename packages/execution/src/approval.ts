import { createHash } from "node:crypto";

import type { JsonValue } from "@lathe/domain";

import type { ExecutionRequest, ExecutionTarget } from "./types.js";
import { normalizeExecutionRequest } from "./validation.js";

export interface ToolCallApproval {
  readonly sessionId: string;
  readonly callId: string;
  readonly toolName: string;
  /** SHA-256 (or a stronger content hash) of the immutable tool revision. */
  readonly toolRevisionHash: string;
  readonly targetId: string;
  /** Immutable asset revision identity (or a versioned built-in identity). */
  readonly targetRevisionId: string;
  /** Content hash for that exact immutable target revision. */
  readonly targetRevisionHash: string;
  readonly target: ExecutionTarget;
  readonly originalArguments: JsonValue;
  readonly originalRequest: ExecutionRequest;
  readonly overrideArguments?: JsonValue;
  readonly overrideRequest?: ExecutionRequest;
}

export interface ApprovalCommandView {
  readonly program: string;
  readonly args: readonly string[];
  readonly cwd: string | null;
  readonly environmentNames: readonly string[];
  readonly stdinBytes: number;
  readonly timeoutMs: number;
  readonly maxOutputBytes: number;
}

export interface ToolCallApprovalView {
  readonly sessionId: string;
  readonly callId: string;
  readonly toolName: string;
  readonly toolRevisionHash: string;
  readonly targetId: string;
  readonly targetRevisionId: string;
  readonly targetRevisionHash: string;
  readonly target: ApprovalExecutionTargetView;
  readonly originalArguments: JsonValue;
  readonly effectiveArguments: JsonValue;
  readonly edited: boolean;
  readonly originalCommand: ApprovalCommandView;
  readonly effectiveCommand: ApprovalCommandView;
}

export type ToolCallApprovalDecision =
  | { readonly kind: "reject"; readonly reason?: string }
  | { readonly kind: "approve-once" }
  | { readonly kind: "approve-session" };

export type ToolCallApprovalResolution =
  | {
      readonly approved: false;
      readonly reason: string | null;
      readonly originalArguments: JsonValue;
      readonly effectiveArguments: JsonValue;
      readonly originalRequest: ExecutionRequest;
      readonly effectiveRequest: ExecutionRequest;
    }
  | {
      readonly approved: true;
      readonly trustedForSession: boolean;
      readonly originalArguments: JsonValue;
      readonly effectiveArguments: JsonValue;
      readonly originalRequest: ExecutionRequest;
      readonly effectiveRequest: ExecutionRequest;
    };

export interface SessionTrustBinding {
  readonly sessionId: string;
  readonly toolRevisionHash: string;
  readonly targetRevisionId: string;
  readonly targetRevisionHash: string;
}

function trustKey(binding: SessionTrustBinding): string {
  // Length-prefixing avoids ambiguous concatenation without constraining IDs.
  return [
    binding.sessionId,
    binding.toolRevisionHash,
    binding.targetRevisionId,
    binding.targetRevisionHash,
  ]
    .map((part) => `${Buffer.byteLength(part)}:${part}`)
    .join("|");
}

/**
 * Session trust is intentionally in-memory. Restarting Lathe revokes every
 * grant, and changing either the revision hash or target creates a new key.
 */
export class SessionTrustStore {
  readonly #grants = new Set<string>();

  grant(binding: SessionTrustBinding): void {
    this.#grants.add(trustKey(binding));
  }

  isTrusted(binding: SessionTrustBinding): boolean {
    return this.#grants.has(trustKey(binding));
  }

  revoke(binding: SessionTrustBinding): boolean {
    return this.#grants.delete(trustKey(binding));
  }

  clearSession(sessionId: string): void {
    for (const key of this.#grants) {
      if (key.startsWith(`${Buffer.byteLength(sessionId)}:${sessionId}|`)) {
        this.#grants.delete(key);
      }
    }
  }

  clear(): void {
    this.#grants.clear();
  }
}

function commandView(request: ExecutionRequest): ApprovalCommandView {
  const normalized = normalizeExecutionRequest(request);
  return {
    program: normalized.program,
    args: normalized.args,
    cwd: normalized.cwd ?? null,
    environmentNames: Object.keys(normalized.environment).sort(),
    stdinBytes:
      normalized.stdin === undefined ? 0 : Buffer.byteLength(normalized.stdin),
    timeoutMs: normalized.timeoutMs,
    maxOutputBytes: normalized.maxOutputBytes,
  };
}

export function createApprovalView(
  approval: ToolCallApproval,
): ToolCallApprovalView {
  const effectiveArguments =
    approval.overrideArguments ?? approval.originalArguments;
  const effectiveRequest = approval.overrideRequest ?? approval.originalRequest;
  return {
    sessionId: approval.sessionId,
    callId: approval.callId,
    toolName: approval.toolName,
    toolRevisionHash: approval.toolRevisionHash,
    targetId: approval.targetId,
    targetRevisionId: approval.targetRevisionId,
    targetRevisionHash: approval.targetRevisionHash,
    target: executionTargetForApproval(approval.target),
    originalArguments: approval.originalArguments,
    effectiveArguments,
    edited:
      approval.overrideArguments !== undefined ||
      approval.overrideRequest !== undefined,
    originalCommand: commandView(approval.originalRequest),
    effectiveCommand: commandView(effectiveRequest),
  };
}

export function requiresApproval(
  approval: Pick<
    ToolCallApproval,
    | "sessionId"
    | "toolRevisionHash"
    | "targetRevisionId"
    | "targetRevisionHash"
  >,
  trust: SessionTrustStore,
): boolean {
  return !trust.isTrusted(approval);
}

export function resolveApproval(
  approval: ToolCallApproval,
  decision: ToolCallApprovalDecision,
  trust: SessionTrustStore,
): ToolCallApprovalResolution {
  // Validate both records before accepting. The original must remain auditable
  // even if the operator supplies a valid override.
  normalizeExecutionRequest(approval.originalRequest);
  const effectiveRequest = approval.overrideRequest ?? approval.originalRequest;
  normalizeExecutionRequest(effectiveRequest);
  const effectiveArguments =
    approval.overrideArguments ?? approval.originalArguments;

  if (decision.kind === "reject") {
    return {
      approved: false,
      reason: decision.reason ?? null,
      originalArguments: approval.originalArguments,
      effectiveArguments,
      originalRequest: approval.originalRequest,
      effectiveRequest,
    };
  }

  if (decision.kind === "approve-session") trust.grant(approval);
  return {
    approved: true,
    trustedForSession: decision.kind === "approve-session",
    originalArguments: approval.originalArguments,
    effectiveArguments,
    originalRequest: approval.originalRequest,
    effectiveRequest,
  };
}

/** Hash immutable handler/spec source without relying on JSON key ordering. */
export function hashRevisionParts(parts: readonly string[]): string {
  const hash = createHash("sha256");
  for (const part of parts) {
    hash.update(String(Buffer.byteLength(part)));
    hash.update(":");
    hash.update(part);
    hash.update(";");
  }
  return hash.digest("hex");
}

/** Values are omitted intentionally; this is safe to attach to approval logs. */
export type ApprovalTargetLauncher =
  | { readonly kind: "direct" }
  | {
      readonly kind: "container-exec";
      readonly program: string;
      readonly container: string;
      readonly user: string | null;
      readonly defaultCwd: string | null;
    }
  | {
      readonly kind: "ssh";
      readonly program: string;
      readonly destination: string;
      readonly port: number | null;
      readonly configFile: string | null;
      readonly identityFile: string | null;
      readonly strictHostKeyChecking: boolean;
    };

export interface ApprovalExecutionTargetView {
  readonly id: string;
  readonly label: string;
  readonly kind: ExecutionTarget["kind"];
  readonly environmentNames: readonly string[];
  readonly inheritsProcessEnvironment: boolean;
  readonly launcher: ApprovalTargetLauncher;
}

export function executionTargetForApproval(
  target: ExecutionTarget,
): ApprovalExecutionTargetView {
  const inheritsProcessEnvironment =
    target.kind === "host" && target.inheritEnvironment === true;
  const environmentNames = new Set(Object.keys(target.environment ?? {}));
  if (inheritsProcessEnvironment) {
    for (const [name, value] of Object.entries(process.env)) {
      if (value !== undefined) environmentNames.add(name);
    }
  }
  const launcher: ApprovalTargetLauncher =
    target.kind === "host"
      ? { kind: "direct" }
      : target.kind === "container"
        ? {
            kind: "container-exec",
            program: target.runtimePath ?? target.runtime,
            container: target.container,
            user: target.user ?? null,
            defaultCwd: target.defaultCwd ?? null,
          }
        : {
            kind: "ssh",
            program: target.sshPath ?? "ssh",
            destination: target.destination,
            port: target.port ?? null,
            configFile: target.configFile ?? null,
            identityFile: target.identityFile ?? null,
            strictHostKeyChecking: target.strictHostKeyChecking !== false,
          };
  return {
    id: target.id,
    label: target.label,
    kind: target.kind,
    environmentNames: [...environmentNames].sort(),
    inheritsProcessEnvironment,
    launcher,
  };
}
