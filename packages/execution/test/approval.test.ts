import { describe, expect, it } from "vitest";

import {
  createApprovalView,
  executionTargetForApproval,
  hashRevisionParts,
  requiresApproval,
  resolveApproval,
  SessionTrustStore,
  type ToolCallApproval,
} from "../src/approval.js";

const approval: ToolCallApproval = {
  sessionId: "session-1",
  callId: "call-1",
  toolName: "run_command",
  toolRevisionHash: "abc123",
  targetId: "host-1",
  targetRevisionId: "target-revision-1",
  targetRevisionHash: "target-hash-1",
  target: {
    id: "host-1",
    label: "Host with explicit environment",
    kind: "host",
    inheritEnvironment: true,
    environment: { PATH: "/usr/bin", TOKEN: "target-secret" },
  },
  originalArguments: { command: "original" },
  overrideArguments: { command: "edited" },
  originalRequest: {
    program: "original",
    args: ["one"],
    environment: { API_TOKEN: "secret" },
  },
  overrideRequest: {
    program: "edited",
    args: ["two"],
    environment: { API_TOKEN: "replacement" },
  },
};

describe("approval and session trust", () => {
  it("shows edits while withholding environment values", () => {
    const view = createApprovalView(approval);
    expect(view.edited).toBe(true);
    expect(view.originalArguments).toEqual({ command: "original" });
    expect(view.effectiveArguments).toEqual({ command: "edited" });
    expect(view.originalCommand.environmentNames).toEqual(["API_TOKEN"]);
    expect(view.target.environmentNames).toEqual(
      expect.arrayContaining(["PATH", "TOKEN"]),
    );
    expect(view.target.inheritsProcessEnvironment).toBe(true);
    expect(view.target.launcher).toEqual({ kind: "direct" });
    expect(JSON.stringify(view)).not.toContain("secret");
    expect(JSON.stringify(view)).not.toContain("replacement");
  });

  it("binds remembered trust to session, revision hash, and target", () => {
    const trust = new SessionTrustStore();
    expect(requiresApproval(approval, trust)).toBe(true);
    expect(resolveApproval(approval, { kind: "approve-session" }, trust)).toMatchObject({
      approved: true,
      trustedForSession: true,
    });
    expect(requiresApproval(approval, trust)).toBe(false);
    expect(
      requiresApproval({ ...approval, toolRevisionHash: "changed" }, trust),
    ).toBe(true);
    // Display/logical target IDs do not grant trust; immutable revision
    // identity and content are the binding.
    expect(requiresApproval({ ...approval, targetId: "renamed-host" }, trust)).toBe(false);
    expect(
      requiresApproval({ ...approval, targetRevisionId: "target-revision-2" }, trust),
    ).toBe(true);
    expect(
      requiresApproval({ ...approval, targetRevisionHash: "target-hash-2" }, trust),
    ).toBe(true);

    trust.clearSession("session-1");
    expect(requiresApproval(approval, trust)).toBe(true);
  });

  it("hashes revision parts with unambiguous boundaries", () => {
    expect(hashRevisionParts(["ab", "c"])).not.toBe(
      hashRevisionParts(["a", "bc"]),
    );
    expect(hashRevisionParts(["ab", "c"])).toHaveLength(64);
  });

  it("discloses container and SSH wrapper executables without environment values", () => {
    expect(executionTargetForApproval({
      id: "container-1",
      label: "Existing container",
      kind: "container",
      runtime: "docker",
      runtimePath: "/opt/bin/docker",
      container: "target-app",
      user: "1000:1000",
      environment: { TOKEN: "container-secret" },
    })).toMatchObject({
      environmentNames: ["TOKEN"],
      launcher: {
        kind: "container-exec",
        program: "/opt/bin/docker",
        container: "target-app",
        user: "1000:1000",
      },
    });
    const ssh = executionTargetForApproval({
      id: "ssh-1",
      label: "Lab",
      kind: "ssh",
      destination: "operator@lab.example",
      sshPath: "/usr/bin/ssh",
      identityFile: "/keys/lab",
    });
    expect(ssh.launcher).toMatchObject({
      kind: "ssh",
      program: "/usr/bin/ssh",
      destination: "operator@lab.example",
      identityFile: "/keys/lab",
      strictHostKeyChecking: true,
    });
    expect(JSON.stringify(ssh)).not.toContain("container-secret");
  });
});
