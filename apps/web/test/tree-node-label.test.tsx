// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { branchContainingNode, suggestedForkBranchName, treeNodeAlerts, TreeNodeLabel } from "../src/views/workbench.js";
import type { BranchRef, MessageNode, ModelRun } from "../src/types.js";

const timestamp = "2026-08-15T00:00:00.000Z";
const branches: BranchRef[] = [
  { id: "branch-main", sessionId: "session-1", name: "main", headNodeId: "node-1", createdAt: timestamp, updatedAt: timestamp },
  { id: "branch-red", sessionId: "session-1", name: "red-path", headNodeId: "node-1", createdAt: timestamp, updatedAt: timestamp }
];

describe("conversation tree branch labels", () => {
  it("shows every branch name at its head and marks the active branch", () => {
    const { container } = render(<TreeNodeLabel role="assistant" branches={branches} activeBranchId="branch-red" />);

    expect(screen.getByText("AI")).not.toBeNull();
    expect(screen.getByText("main")).not.toBeNull();
    expect(screen.getByText("red-path").classList.contains("active")).toBe(true);
    expect(container.querySelector(".tree-branch-names")?.getAttribute("title")).toBe("main, red-path");
  });

  it("exposes an accessible alert marker on blocked nodes", () => {
    render(<TreeNodeLabel role="assistant" branches={[]} activeBranchId="branch-main" alert={{ kind: "blocked", label: "Provider blocked this turn · content-policy" }} />);

    expect(screen.getByLabelText("Provider blocked this turn · content-policy").textContent).toBe("!");
  });
});

function node(input: Pick<MessageNode, "id" | "role"> & Partial<MessageNode>): MessageNode {
  const { id, role, ...overrides } = input;
  return {
    id,
    sessionId: "session-1",
    parentId: null,
    role,
    parts: [],
    sourceRunId: null,
    configSnapshotId: null,
    sourcePayloadRevisionId: null,
    createdAt: timestamp,
    ...overrides
  };
}

function run(input: Pick<ModelRun, "id" | "status"> & Partial<ModelRun>): ModelRun {
  const { id, status, ...overrides } = input;
  return {
    id,
    sessionId: "session-1",
    branchId: "branch-main",
    contextNodeId: null,
    resultNodeId: null,
    configSnapshotId: "config-1",
    status,
    classification: null,
    operatorLabel: null,
    operatorNotes: null,
    normalizedOutput: null,
    usage: null,
    traceHash: null,
    startedAt: timestamp,
    finishedAt: timestamp,
    createdAt: timestamp,
    ...overrides
  };
}

describe("conversation tree run alerts", () => {
  it("marks terminal provider blocks and incomplete output but not recovered policy signals", () => {
    const blocked = node({ id: "blocked-result", role: "assistant", sourceRunId: "run-blocked" });
    const recovered = node({ id: "recovered-result", role: "assistant", sourceRunId: "run-recovered" });
    const incomplete = node({ id: "incomplete-result", role: "assistant", sourceRunId: "run-incomplete" });
    const alerts = treeNodeAlerts([blocked, recovered, incomplete], [
      run({ id: "run-blocked", status: "completed", resultNodeId: blocked.id, classification: "content-policy" }),
      run({
        id: "run-recovered",
        status: "completed",
        resultNodeId: recovered.id,
        normalizedOutput: { providerOutcome: { status: "recovered", policyDetected: true, recovered: true, terminalPolicyBlock: false } }
      }),
      run({
        id: "run-incomplete",
        status: "completed",
        resultNodeId: incomplete.id,
        normalizedOutput: { providerOutcome: { status: "incomplete", incompleteReason: "max_tokens" } }
      })
    ]);

    expect(alerts.get(blocked.id)).toEqual({ kind: "blocked", label: "Provider blocked this turn · content-policy" });
    expect(alerts.has(recovered.id)).toBe(false);
    expect(alerts.get(incomplete.id)).toEqual({ kind: "error", label: "Run incomplete · max_tokens" });
  });

  it("falls back to the context node when a failed run has no result", () => {
    const prompt = node({ id: "failed-prompt", role: "user" });
    const alerts = treeNodeAlerts([prompt], [run({ id: "run-failed", status: "failed", contextNodeId: prompt.id, classification: "transport" })]);

    expect(alerts.get(prompt.id)).toEqual({ kind: "error", label: "Run error · transport" });
  });

  it("places tool failures on the tool result and ignores operator cancellation", () => {
    const assistant = node({ id: "tool-call", role: "assistant", sourceRunId: "run-tool" });
    const tool = node({ id: "tool-result", role: "tool", parentId: assistant.id, sourceRunId: "run-tool" });
    const cancelledPrompt = node({ id: "cancelled-prompt", role: "user" });
    const alerts = treeNodeAlerts([assistant, tool, cancelledPrompt], [
      run({ id: "run-tool", status: "completed", resultNodeId: assistant.id, classification: "tool-failure" }),
      run({ id: "run-cancelled", status: "cancelled", contextNodeId: cancelledPrompt.id, classification: "cancelled" })
    ]);

    expect(alerts.has(assistant.id)).toBe(false);
    expect(alerts.get(tool.id)).toEqual({ kind: "error", label: "Run error · tool-failure" });
    expect(alerts.has(cancelledPrompt.id)).toBe(false);
  });
});

describe("conversation tree jump branch selection", () => {
  const graph = [
    node({ id: "root", role: "user" }),
    node({ id: "shared", role: "assistant", parentId: "root" }),
    node({ id: "main-head", role: "user", parentId: "shared" }),
    node({ id: "alternate-head", role: "user", parentId: "shared" }),
    node({ id: "orphan", role: "assistant", parentId: "root" })
  ];
  const graphBranches: BranchRef[] = [
    { id: "main", sessionId: "session-1", name: "main", headNodeId: "main-head", createdAt: timestamp, updatedAt: timestamp },
    { id: "alternate", sessionId: "session-1", name: "alternate", headNodeId: "alternate-head", createdAt: timestamp, updatedAt: timestamp }
  ];

  it("keeps the active branch when it already contains the node", () => {
    expect(branchContainingNode(graph, graphBranches, "main", "shared")?.id).toBe("main");
  });

  it("selects the branch whose head is the requested node", () => {
    expect(branchContainingNode(graph, graphBranches, "main", "alternate-head")?.id).toBe("alternate");
  });

  it("does not mutate a branch to reach an unreferenced historical node", () => {
    expect(branchContainingNode(graph, graphBranches, "main", "orphan")).toBeNull();
  });
});

describe("fork branch suggestions", () => {
  it("uses a compact randomized suffix", () => {
    expect(suggestedForkBranchName([], () => "A1B2-C3D4-extra")).toBe("variation-a1b2c3d4");
  });

  it("retries when a generated name already exists", () => {
    const existing: BranchRef[] = [
      { id: "existing", sessionId: "session-1", name: "variation-deadbeef", headNodeId: null, createdAt: timestamp, updatedAt: timestamp }
    ];
    const suffixes = ["deadbeef", "cafe1234"];

    expect(suggestedForkBranchName(existing, () => suffixes.shift() ?? "unused00")).toBe("variation-cafe1234");
  });
});
