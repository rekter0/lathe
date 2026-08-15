import { describe, expect, it } from "vitest";
import { commonAncestor, compareBranches, pathToRoot, type MessageNode } from "../src/index.js";

function generatedTree(seed: number, size: number): MessageNode[] {
  let state = seed >>> 0;
  const random = () => {
    state = (Math.imul(state, 1_664_525) + 1_013_904_223) >>> 0;
    return state;
  };
  const nodes: MessageNode[] = [];
  for (let index = 0; index < size; index += 1) {
    const parentIndex = index === 0 ? -1 : random() % index;
    nodes.push({
      id: `node-${index}`,
      sessionId: "session",
      parentId: parentIndex < 0 ? null : `node-${parentIndex}`,
      role: index % 2 === 0 ? "user" : "assistant",
      parts: [{ type: "text", text: String(index) }],
      sourceRunId: null,
      configSnapshotId: null,
      sourcePayloadRevisionId: null,
      createdAt: new Date(index).toISOString(),
    });
  }
  return nodes;
}

describe("conversation graph generated invariants", () => {
  it("keeps paths connected and comparisons lossless across generated trees", () => {
    for (let seed = 1; seed <= 100; seed += 1) {
      const nodes = generatedTree(seed, 40);
      const leftId = `node-${(seed * 13) % nodes.length}`;
      const rightId = `node-${(seed * 29 + 7) % nodes.length}`;
      const left = pathToRoot(nodes, leftId);
      const right = pathToRoot(nodes, rightId);
      for (const path of [left, right]) {
        expect(path[0]?.parentId).toBeNull();
        for (let index = 1; index < path.length; index += 1) {
          expect(path[index]?.parentId).toBe(path[index - 1]?.id);
        }
      }

      const comparison = compareBranches(nodes, leftId, rightId);
      expect([...comparison.shared, ...comparison.left]).toEqual(left);
      expect([...comparison.shared, ...comparison.right]).toEqual(right);
      expect(comparison.ancestor).toEqual(commonAncestor(nodes, leftId, rightId));
      expect(new Set(left.map((node) => node.id)).size).toBe(left.length);
      expect(new Set(right.map((node) => node.id)).size).toBe(right.length);
    }
  });

  it("rejects cycles and missing parents", () => {
    const cyclic = generatedTree(1, 3);
    cyclic[0] = { ...cyclic[0]!, parentId: cyclic[2]!.id };
    expect(() => pathToRoot(cyclic, cyclic[2]!.id)).toThrow("Cycle detected");
    expect(() => pathToRoot(generatedTree(1, 3), "missing")).toThrow("Missing node");
  });
});
