// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { streamOutputFromEvents, TranscriptMessage, type RunEventEnvelope } from "../src/views/workbench.js";
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
    createdAt
  };
}

function modelRun(id: string, reasoning: string): ModelRun {
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
    normalizedOutput: { text: "answer", reasoning },
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
      phase: "finalizing"
    });
  });
});
