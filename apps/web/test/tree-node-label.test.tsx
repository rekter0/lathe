// @vitest-environment jsdom

import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { TreeNodeLabel } from "../src/views/workbench.js";
import type { BranchRef } from "../src/types.js";

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
});
