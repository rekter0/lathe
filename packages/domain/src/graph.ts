import type { Id, MessageNode } from "./types.js";

export class GraphInvariantError extends Error {
  override readonly name = "GraphInvariantError";
}

export function pathToRoot(nodes: Iterable<MessageNode>, leafId: Id | null): MessageNode[] {
  if (leafId === null) return [];
  const byId = new Map(Array.from(nodes, (node) => [node.id, node]));
  const seen = new Set<Id>();
  const reversePath: MessageNode[] = [];
  let cursor: Id | null = leafId;

  while (cursor !== null) {
    if (seen.has(cursor)) throw new GraphInvariantError(`Cycle detected at node ${cursor}`);
    seen.add(cursor);
    const node = byId.get(cursor);
    if (!node) throw new GraphInvariantError(`Missing node ${cursor}`);
    reversePath.push(node);
    cursor = node.parentId;
  }

  return reversePath.reverse();
}

export function commonAncestor(
  nodes: Iterable<MessageNode>,
  leftLeafId: Id | null,
  rightLeafId: Id | null
): MessageNode | null {
  const left = pathToRoot(nodes, leftLeafId);
  const right = pathToRoot(nodes, rightLeafId);
  let ancestor: MessageNode | null = null;
  const sharedLength = Math.min(left.length, right.length);
  for (let index = 0; index < sharedLength; index += 1) {
    if (left[index]?.id !== right[index]?.id) break;
    ancestor = left[index] ?? null;
  }
  return ancestor;
}

export function assertAppendableNode(
  existingNodes: Iterable<MessageNode>,
  candidate: MessageNode
): void {
  const nodes = Array.from(existingNodes);
  if (nodes.some((node) => node.id === candidate.id)) {
    throw new GraphInvariantError(`Node ${candidate.id} already exists`);
  }
  if (candidate.parentId === null) return;
  const parent = nodes.find((node) => node.id === candidate.parentId);
  if (!parent) throw new GraphInvariantError(`Parent ${candidate.parentId} does not exist`);
  if (parent.sessionId !== candidate.sessionId) {
    throw new GraphInvariantError("A node cannot point to a parent from another session");
  }
}

export interface BranchComparison {
  ancestor: MessageNode | null;
  shared: MessageNode[];
  left: MessageNode[];
  right: MessageNode[];
}

export function compareBranches(
  nodes: Iterable<MessageNode>,
  leftLeafId: Id | null,
  rightLeafId: Id | null
): BranchComparison {
  const all = Array.from(nodes);
  const leftPath = pathToRoot(all, leftLeafId);
  const rightPath = pathToRoot(all, rightLeafId);
  let split = 0;
  while (leftPath[split]?.id === rightPath[split]?.id && split < leftPath.length && split < rightPath.length) {
    split += 1;
  }
  return {
    ancestor: split === 0 ? null : leftPath[split - 1] ?? null,
    shared: leftPath.slice(0, split),
    left: leftPath.slice(split),
    right: rightPath.slice(split)
  };
}
