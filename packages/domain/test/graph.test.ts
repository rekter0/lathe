import { describe, expect, it } from "vitest";
import { commonAncestor, compareBranches, pathToRoot, redactJson, replaceKnownSecrets, sha256, uuidv7 } from "../src/index.js";
import type { MessageNode } from "../src/index.js";

const node = (id: string, parentId: string | null): MessageNode => ({
  id,
  sessionId: "session",
  parentId,
  role: "user",
  parts: [{ type: "text", text: id }],
  sourceRunId: null,
  configSnapshotId: null,
  sourcePayloadRevisionId: null,
  createdAt: "2026-01-01T00:00:00.000Z"
});

describe("conversation graph", () => {
  const nodes = [node("root", null), node("a", "root"), node("b", "root"), node("a2", "a")];

  it("builds a root-to-leaf path", () => {
    expect(pathToRoot(nodes, "a2").map((item) => item.id)).toEqual(["root", "a", "a2"]);
  });

  it("finds and compares a common ancestor", () => {
    expect(commonAncestor(nodes, "a2", "b")?.id).toBe("root");
    const comparison = compareBranches(nodes, "a2", "b");
    expect(comparison.left.map((item) => item.id)).toEqual(["a", "a2"]);
    expect(comparison.right.map((item) => item.id)).toEqual(["b"]);
  });
});

describe("domain utilities", () => {
  it("creates lexicographically time-ordered UUIDv7 values", () => {
    const entropy = Buffer.alloc(10, 1);
    expect(uuidv7(1_000, entropy) < uuidv7(2_000, entropy)).toBe(true);
  });

  it("redacts nested secrets without discarding evidence structure", () => {
    expect(redactJson({ authorization: "Bearer x", nested: { apiKey: "x", ok: true } })).toEqual({
      authorization: "<redacted>",
      nested: { apiKey: "<redacted>", ok: true }
    });
  });

  it("redacts short exact secrets only as complete credential-like tokens", () => {
    expect(replaceKnownSecrets(
      "example text; Bearer x; auth=x; x-ray; exact long-secret-value",
      ["x", "long-secret-value"],
      "[REDACTED]",
    )).toEqual({
      value: "example text; Bearer [REDACTED]; auth=[REDACTED]; x-ray; exact [REDACTED]",
      count: 3,
    });
  });

  it("computes standard SHA-256 digests in browser-safe code", () => {
    expect(sha256("abc")).toBe("ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad");
  });
});
