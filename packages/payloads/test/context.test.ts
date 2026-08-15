import { describe, expect, it } from "vitest";
import { emptyResolvedConfig } from "@lathe/domain";
import { compilePayloadContext } from "../src/index.js";

const base = {
  project: { name: "Target", description: "Project briefing", targetName: "Acme" },
  session: { name: "Escape test", description: "Session briefing", config: emptyResolvedConfig() },
  branch: {
    name: "main",
    nodes: [
      { id: "u1", role: "user" as const, parts: [{ type: "text" as const, text: "first" }] },
      { id: "a1", role: "assistant" as const, reasoning: "reasoning stays", parts: [{ type: "tool-call" as const, callId: "c1", name: "bash", arguments: { command: "id" } }] },
      { id: "t1", role: "tool" as const, parts: [{ type: "tool-result" as const, callId: "c1", name: "bash", result: "x".repeat(200), isError: false }] },
      { id: "u2", role: "user" as const, parts: [{ type: "text" as const, text: "latest" }] }
    ]
  }
};

describe("payload context compiler", () => {
  it("keeps reasoning and truncates only minimal tool results", () => {
    const result = compilePayloadContext({ ...base, options: { mode: "minimal", includeProjectBrief: false, includeSessionBrief: false, includeTargetConfig: false, budgetChars: 10_000 } });
    expect(result.text).toContain("reasoning stays");
    expect(result.text).toContain("truncated from 202 chars");
    expect(result.manifest.includedNodeIds).toEqual(["u1", "a1", "t1", "u2"]);
  });

  it("selects newest complete turns and reports omissions", () => {
    const result = compilePayloadContext({ ...base, options: { mode: "minimal", includeProjectBrief: false, includeSessionBrief: false, includeTargetConfig: false, budgetChars: 100 } });
    expect(result.manifest.fits).toBe(true);
    expect(result.manifest.includedNodeIds).toEqual(["u2"]);
    expect(result.manifest.omittedTurnCount).toBe(1);
  });

  it("fails preview when the newest turn cannot fit", () => {
    const result = compilePayloadContext({ ...base, options: { mode: "full", includeProjectBrief: false, includeSessionBrief: false, includeTargetConfig: false, budgetChars: 2 } });
    expect(result.manifest.fits).toBe(false);
    expect(result.manifest.requiredMinimumChars).toBeGreaterThan(2);
  });
});
