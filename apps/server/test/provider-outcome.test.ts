import { describe, expect, it } from "vitest";
import type { NormalizedProviderEvent } from "@lathe/providers";
import { ProviderOutcomeTracker } from "../src/provider-outcome.js";

function consume(events: readonly NormalizedProviderEvent[]): ProviderOutcomeTracker {
  const tracker = new ProviderOutcomeTracker();
  for (const event of events) tracker.consume(event);
  return tracker;
}

describe("provider outcome tracking", () => {
  it("classifies a policy stop after partial reasoning/output as a terminal block", () => {
    const tracker = consume([
      { type: "reasoning.delta", text: "analysis", index: 0 },
      { type: "content.delta", text: "partial", index: 0 },
      { type: "refusal.delta", text: "Blocked by classifier.", index: 0 },
      { type: "response.completed", finishReason: "content_filter", nativeFinishReason: "refusal" },
      { type: "response.completed" },
    ]);

    expect(tracker.classification()).toBe("content-policy");
    expect(tracker.toJson()).toMatchObject({
      status: "blocked",
      policyDetected: true,
      terminalPolicyBlock: true,
      partialOutput: true,
      refusalText: "Blocked by classifier.",
      finishReason: "content_filter",
      nativeFinishReason: "refusal",
    });
  });

  it("records a warning followed by later output as recovered instead of failed", () => {
    const tracker = consume([
      { type: "refusal.delta", text: "Primary attempt blocked.", index: 0 },
      { type: "response.completed", finishReason: "content_filter", nativeFinishReason: "refusal" },
      { type: "content.delta", text: "continued answer", index: 0 },
      { type: "response.completed", finishReason: "stop", nativeFinishReason: "end_turn" },
    ]);

    expect(tracker.classification()).toBeNull();
    expect(tracker.toJson()).toMatchObject({
      status: "recovered",
      recovered: true,
      continuedAfterBlock: true,
      terminalPolicyBlock: false,
    });
  });

  it("records native fallback boundaries and a later refusal independently", () => {
    const tracker = consume([
      { type: "response.fallback", index: 0, fromModel: "claude-fable-5", toModel: "claude-opus-4-8" },
      { type: "content.delta", text: "fallback partial", index: 1 },
      { type: "response.completed", finishReason: "refusal", stopDetails: { type: "refusal", category: "cyber", explanation: "Still blocked." } },
    ]);

    expect(tracker.classification()).toBe("content-policy");
    expect(tracker.toJson()).toMatchObject({
      status: "blocked",
      stopDetails: { type: "refusal", category: "cyber" },
      refusalText: "Still blocked.",
      fallbacks: [{ fromModel: "claude-fable-5", toModel: "claude-opus-4-8" }],
    });
  });
});
