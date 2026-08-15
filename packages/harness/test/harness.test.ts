import { describe, expect, it } from "vitest";
import { builtInAssets, resolveHarness, type HarnessRevisionValue } from "../src/index.js";
import type { AssetRevision } from "@lathe/domain";

describe("built-in harnesses", () => {
  it("ships clearly attributed presets", () => {
    const harnesses = builtInAssets.filter((asset) => asset.kind === "harness");
    expect(harnesses.map((asset) => asset.name)).toEqual(["Blank", "Claude Code-inspired", "Codex-inspired"]);
    expect(harnesses.every((asset) => asset.provenance.maintainer === "Lathe")).toBe(true);
  });

  it("resolves prompt and tool snapshots without mutating assets", () => {
    const harness = builtInAssets.find((asset) => asset.name === "Claude Code-inspired") as AssetRevision<HarnessRevisionValue>;
    const config = resolveHarness(harness, builtInAssets);
    expect(config.promptBlocks).toHaveLength(1);
    expect(config.tools.map((tool) => tool.name)).toEqual(["read_file", "shell"]);
    expect(config.compileWarnings).toEqual([]);
  });
});
