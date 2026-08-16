// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { RevisionAssetOptions } from "../src/views/workbench.js";
import type { AssetRevision } from "../src/types.js";

const createdAt = "2026-08-16T00:00:00.000Z";

function targetRevision(id: string, revision: number): AssetRevision {
  return {
    id,
    assetId: "target-logical-id",
    kind: "target",
    revision,
    name: "test-container",
    description: "Container execution target",
    tags: [],
    provenance: {},
    value: { kind: "container" },
    contentHash: `hash-${revision}`,
    trusted: true,
    archivedAt: null,
    createdAt
  };
}

describe("revision-backed workbench selectors", () => {
  it("distinguishes same-name asset revisions while preserving their exact IDs", () => {
    render(
      <select aria-label="Bash target" defaultValue="target-r2">
        <option value="">Local host</option>
        <RevisionAssetOptions assets={[targetRevision("target-r1", 1), targetRevision("target-r2", 2)]} />
      </select>
    );

    expect((screen.getByRole("option", { name: "test-container · r1" }) as HTMLOptionElement).value).toBe("target-r1");
    expect((screen.getByRole("option", { name: "test-container · r2" }) as HTMLOptionElement).value).toBe("target-r2");
    expect((screen.getByRole("combobox", { name: "Bash target" }) as HTMLSelectElement).value).toBe("target-r2");
  });
});
