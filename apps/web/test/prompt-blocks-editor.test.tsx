// @vitest-environment jsdom

import { useState } from "react";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ResolvedConfig } from "@lathe/domain";
import { PromptBlocksEditor } from "../src/views/workbench.js";

type PromptBlock = ResolvedConfig["promptBlocks"][number];

const initialBlocks: PromptBlock[] = [
  { revisionId: "prompt-1", name: "first", content: "First prompt", enabled: true, order: 0 },
  { revisionId: "prompt-2", name: "middle", content: "Middle prompt", enabled: false, order: 1 },
  { revisionId: "prompt-3", name: "last", content: "Last prompt", enabled: true, order: 2 }
];

function StatefulEditor({ onChange }: { onChange(blocks: PromptBlock[]): void }) {
  const [blocks, setBlocks] = useState(() => structuredClone(initialBlocks));
  return <PromptBlocksEditor blocks={blocks} onChange={(next) => {
    onChange(next);
    setBlocks(next);
  }} />;
}

afterEach(cleanup);

describe("PromptBlocksEditor", () => {
  it("removes a disabled prompt from the session draft and normalizes the remaining order", () => {
    const onChange = vi.fn();
    render(<StatefulEditor onChange={onChange} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove middle from session draft" }));

    expect(screen.queryByLabelText("middle prompt content")).toBeNull();
    expect(screen.getByLabelText("first prompt content")).not.toBeNull();
    expect(screen.getByLabelText("last prompt content")).not.toBeNull();
    expect(onChange).toHaveBeenLastCalledWith([
      { ...initialBlocks[0], order: 0 },
      { ...initialBlocks[2], order: 1 }
    ]);
    expect(initialBlocks.map((block) => block.order)).toEqual([0, 1, 2]);
  });

  it("shows the empty state after every prompt binding is removed", () => {
    render(<StatefulEditor onChange={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Remove first from session draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove middle from session draft" }));
    fireEvent.click(screen.getByRole("button", { name: "Remove last from session draft" }));

    expect(screen.getByText("This session has no prompt blocks. Add one from a harness or library revision.")).not.toBeNull();
  });
});
