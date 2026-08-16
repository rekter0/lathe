// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { inspectableRunsForNode, streamOutputFromEvents, TranscriptMessage, type RunEventEnvelope } from "../src/views/workbench.js";
import type { JsonObject } from "@lathe/domain";
import type { MessageNode, ModelRun } from "../src/types.js";

const createdAt = "2026-08-15T12:00:00.000Z";

function assistantNode(id: string, text: string, runId: string): MessageNode {
  return {
    id,
    sessionId: "session-1",
    parentId: null,
    role: "assistant",
    parts: [{ type: "text", text }],
    sourceRunId: runId,
    configSnapshotId: "config-1",
    sourcePayloadRevisionId: null,
    createdAt
  };
}

function operatorNode(id: string, text = "inspect this request"): MessageNode {
  return {
    id,
    sessionId: "session-1",
    parentId: null,
    role: "user",
    parts: [{ type: "text", text }],
    sourceRunId: null,
    configSnapshotId: null,
    sourcePayloadRevisionId: null,
    createdAt
  };
}

function modelRun(id: string, reasoning: string, providerOutcome?: JsonObject): ModelRun {
  return {
    id,
    sessionId: "session-1",
    branchId: "branch-1",
    contextNodeId: null,
    resultNodeId: null,
    configSnapshotId: "config-1",
    status: "completed",
    classification: null,
    operatorLabel: null,
    operatorNotes: null,
    normalizedOutput: { text: "answer", reasoning, ...(providerOutcome ? { providerOutcome } : {}) },
    usage: null,
    traceHash: null,
    startedAt: createdAt,
    finishedAt: createdAt,
    createdAt
  };
}

describe("transcript message views", () => {
  afterEach(cleanup);

  it("shows model reasoning and switches the exact message and reasoning text between rendered and raw views", () => {
    const { container } = render(
      <TranscriptMessage
        node={assistantNode("node-1", "A **bold answer**.\n\nSecond line.", "run-1")}
        run={modelRun("run-1", "Consider **branch A**.\n\n- first check")}
        onSelectRun={() => undefined}
      />
    );

    expect(screen.getByText("Reasoning", { exact: true })).not.toBeNull();
    expect(screen.getByText("bold answer").tagName).toBe("STRONG");
    expect(screen.getByText("branch A").tagName).toBe("STRONG");

    fireEvent.click(screen.getByRole("button", { name: "Show raw message text" }));

    expect(screen.getByRole("button", { name: "Show rendered message" }).getAttribute("aria-pressed")).toBe("true");
    const rawBlocks = [...container.querySelectorAll("pre.message-raw")].map((element) => element.textContent);
    expect(rawBlocks).toEqual([
      "Consider **branch A**.\n\n- first check",
      "A **bold answer**.\n\nSecond line."
    ]);
  });

  it("keeps the raw/rendered choice independent for every message box", () => {
    render(<>
      <TranscriptMessage node={assistantNode("node-1", "**first**", "run-1")} run={modelRun("run-1", "reason one")} onSelectRun={() => undefined} />
      <TranscriptMessage node={assistantNode("node-2", "**second**", "run-2")} run={modelRun("run-2", "reason two")} onSelectRun={() => undefined} />
    </>);

    const messages = screen.getAllByRole("article");
    fireEvent.click(within(messages[0]!).getByRole("button", { name: "Show raw message text" }));

    expect(within(messages[0]!).getByRole("button", { name: "Show rendered message" })).not.toBeNull();
    expect(within(messages[1]!).getByRole("button", { name: "Show raw message text" })).not.toBeNull();
    expect(within(messages[1]!).getByText("second").tagName).toBe("STRONG");
  });

  it("opens the request run from an operator message without rendering response evidence in that message", () => {
    const onSelectRun = vi.fn();
    const run = { ...modelRun("run-request", "private response reasoning"), contextNodeId: "operator-1" };
    render(<TranscriptMessage node={operatorNode("operator-1")} inspectRuns={[run]} onSelectRun={onSelectRun} />);

    fireEvent.click(screen.getByRole("button", { name: "Inspect request run" }));

    expect(onSelectRun).toHaveBeenCalledWith("run-request");
    expect(screen.queryByText("private response reasoning")).toBeNull();
  });

  it("keeps every direct attempt inspectable when an operator message has multiple runs", () => {
    const onSelectRun = vi.fn();
    const older = { ...modelRun("run-older", ""), contextNodeId: "operator-1", createdAt: "2026-08-15T12:00:00.000Z" };
    const newer = { ...modelRun("run-newer", ""), contextNodeId: "operator-1", status: "failed" as const, createdAt: "2026-08-15T12:01:00.000Z" };
    render(<TranscriptMessage node={operatorNode("operator-1")} inspectRuns={[newer, older]} onSelectRun={onSelectRun} />);

    const picker = screen.getByRole("combobox", { name: "Inspect a run for this operator message" });
    expect(within(picker).getAllByRole("option").map((option) => option.textContent)).toEqual([
      "inspect 2 runs…",
      expect.stringContaining("latest · branch · failed · run-newe"),
      expect.stringContaining("branch · completed · run-olde")
    ]);
    fireEvent.change(picker, { target: { value: "run-older" } });
    expect(onSelectRun).toHaveBeenCalledWith("run-older");
  });

  it("maps operator nodes through run context while excluding nested MCP sampling runs", () => {
    const operator = operatorNode("operator-1");
    const older = { ...modelRun("run-a", ""), contextNodeId: operator.id, createdAt: "2026-08-15T12:00:00.000Z" };
    const newer = { ...modelRun("run-b", ""), contextNodeId: operator.id, createdAt: "2026-08-15T12:01:00.000Z" };
    const nested = { ...modelRun("run-sampling", ""), contextNodeId: operator.id, createdAt: "2026-08-15T12:02:00.000Z", normalizedOutput: { kind: "mcp-sampling" } };

    expect(inspectableRunsForNode(operator, [older, nested, newer]).map((run) => run.id)).toEqual(["run-b", "run-a"]);
    expect(inspectableRunsForNode(assistantNode("assistant-1", "answer", "run-a"), [newer, older]).map((run) => run.id)).toEqual(["run-a"]);
  });

  it("displays structured provider blockage beside preserved partial output", () => {
    render(<TranscriptMessage
      node={assistantNode("node-1", "Partial model output.", "run-1")}
      run={modelRun("run-1", "Partial reasoning.", {
        status: "blocked",
        policyDetected: true,
        terminalPolicyBlock: true,
        recovered: false,
        partialOutput: true,
        continuedAfterBlock: false,
        refusalText: "This request triggered restrictions on violative cyber content.",
        finishReason: "content_filter",
        nativeFinishReason: "refusal",
        stopDetails: { category: "cyber" }
      })}
      onSelectRun={() => undefined}
    />);

    expect(screen.getByRole("alert").textContent).toContain("Provider blocked this generation");
    expect(screen.getByRole("alert").textContent).toContain("category · cyber");
    expect(screen.getByRole("alert").textContent).toContain("content_filter");
    expect(screen.getByRole("alert").textContent).toContain("partial and must not be treated as a complete answer");
    expect(screen.getByText("Partial model output.")).not.toBeNull();
    expect(screen.getByText("Partial reasoning.")).not.toBeNull();
  });

  it("reconstructs fragmented reasoning and answer text from run SSE envelopes", () => {
    const event = (id: number, type: string, data: RunEventEnvelope["data"]): RunEventEnvelope => ({
      id,
      channel: "run:run-1",
      type,
      timestamp: createdAt,
      data
    });

    expect(streamOutputFromEvents([
      event(1, "run.started", { runId: "run-1" }),
      event(2, "reasoning.delta", { type: "reasoning.delta", text: "check ", index: 0 }),
      event(3, "provider.trace", { ignored: true }),
      event(4, "reasoning.delta", { type: "reasoning.delta", text: "constraints", index: 0 }),
      event(5, "content.delta", { type: "content.delta", text: "final ", index: 0 }),
      event(6, "content.delta", { type: "content.delta", text: "answer", index: 0 }),
      event(7, "response.completed", { type: "response.completed" })
    ])).toEqual({
      text: "final answer",
      reasoning: "check constraints",
      providerOutcome: null,
      phase: "finalizing"
    });
  });

  it("shows a live refusal, then marks it recovered when output continues", () => {
    const event = (id: number, type: string, data: RunEventEnvelope["data"]): RunEventEnvelope => ({
      id,
      channel: "run:run-1",
      type,
      timestamp: createdAt,
      data
    });
    const output = streamOutputFromEvents([
      event(1, "run.started", { runId: "run-1" }),
      event(2, "refusal.delta", { type: "refusal.delta", text: "Primary blocked.", index: 0 }),
      event(3, "response.completed", { type: "response.completed", finishReason: "content_filter", nativeFinishReason: "refusal" }),
      event(4, "content.delta", { type: "content.delta", text: "Fallback answer.", index: 0 }),
      event(5, "response.completed", { type: "response.completed", finishReason: "stop", nativeFinishReason: "end_turn" })
    ]);

    expect(output).toMatchObject({
      text: "Fallback answer.",
      phase: "finalizing",
      providerOutcome: {
        status: "recovered",
        recovered: true,
        continuedAfterBlock: true,
        refusalText: "Primary blocked.",
        finishReason: "stop",
        nativeFinishReason: "end_turn",
        stopReasons: ["content_filter", "refusal", "stop", "end_turn"]
      }
    });
  });
});
