// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { applyPayloadTransform, PayloadWorkbench } from "../src/components/payload-workbench.js";
import { OperatorDialogProvider } from "../src/components/operator-dialog.js";
import { candidatesFromDetail, reducePayloadGenerationEvent } from "../src/payload-workbench-api.js";

function renderWorkbench(element: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><OperatorDialogProvider>{element}</OperatorDialogProvider></QueryClientProvider>);
}

function jsonResponse(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("payload transformations", () => {
  it("round-trips Unicode through Base64, URL, and UTF-8 hex encodings", () => {
    const payload = "Ignore prior text — مرحبا 🧪";

    const base64 = applyPayloadTransform("base64-encode", payload);
    expect(applyPayloadTransform("base64-decode", base64)).toBe(payload);

    const urlEncoded = applyPayloadTransform("url-encode", payload);
    expect(applyPayloadTransform("url-decode", urlEncoded)).toBe(payload);

    const hex = applyPayloadTransform("hex-encode", payload);
    expect(applyPayloadTransform("hex-decode", hex)).toBe(payload);
  });

  it("applies reversible text transforms and useful payload frames", () => {
    expect(applyPayloadTransform("rot13", applyPayloadTransform("rot13", "Attack at dawn"))).toBe("Attack at dawn");
    expect(applyPayloadTransform("markdown-frame", "payload")).toBe("```text\npayload\n```");
    expect(applyPayloadTransform("xml-frame", "payload")).toBe("<payload>\npayload\n</payload>");
    expect(JSON.parse(applyPayloadTransform("json-frame", "payload"))).toEqual({ payload: "payload" });
    expect(() => applyPayloadTransform("hex-decode", "not hex")).toThrow(/hexadecimal digits/i);
  });
});

describe("PayloadWorkbench", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const path = typeof input === "string" ? input : input instanceof URL ? input.pathname : new URL(input.url).pathname;
      if (path === "/api/payload-workbench/settings") return jsonResponse({ settings: {} });
      if (path.startsWith("/api/assets")) return jsonResponse({ assets: [] });
      if (path === "/api/payload-generations") return jsonResponse({ generations: [], standaloneRevisions: [], standaloneOutcomes: [], nextCursor: null });
      return jsonResponse({});
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("keeps edits local, supports undo, and explicitly returns the next prompt", async () => {
    const onUse = vi.fn();
    renderWorkbench(<PayloadWorkbench value="hello / world" onUse={onUse} />);

    fireEvent.click(screen.getByRole("button", { name: "Open payload workbench" }));
    const dialog = screen.getByRole("dialog", { name: "Payload workbench" });
    const editor = screen.getByRole("textbox", { name: "Next prompt" }) as HTMLTextAreaElement;
    expect(editor.value).toBe("hello / world");
    expect(onUse).not.toHaveBeenCalled();

    fireEvent.click(screen.getByRole("button", { name: "Base64 encode" }));
    expect(editor.value).toBe("aGVsbG8gLyB3b3JsZA==");
    fireEvent.click(screen.getByRole("button", { name: "Undo" }));
    expect(editor.value).toBe("hello / world");

    fireEvent.change(editor, { target: { value: "probe" } });
    fireEvent.click(screen.getByRole("button", { name: "XML payload" }));
    expect(editor.value).toBe("<payload>\nprobe\n</payload>");
    fireEvent.click(screen.getByRole("button", { name: "Use as next prompt" }));

    expect(onUse).toHaveBeenCalledWith({ text: "<payload>\nprobe\n</payload>", sourcePayloadRevisionId: null });
    await waitFor(() => expect(dialog.isConnected).toBe(false));
  });

  it("shows decoding failures without replacing the current draft", () => {
    renderWorkbench(<PayloadWorkbench value="not hex" onUse={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Open payload workbench" }));
    const editor = screen.getByRole("textbox", { name: "Next prompt" }) as HTMLTextAreaElement;
    fireEvent.click(screen.getByRole("button", { name: "UTF-8 hex decode" }));

    expect(editor.value).toBe("not hex");
    expect(screen.getByRole("alert").textContent).toMatch(/hexadecimal digits/i);
  });

  it("renders variable overrides as a direct deterministic transform", () => {
    renderWorkbench(<PayloadWorkbench value="Hello {{target}}" onUse={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Open payload workbench" }));
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Variable 1 name" }), { target: { value: "target" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Variable target value" }), { target: { value: "model" } });
    fireEvent.click(screen.getByRole("button", { name: "Render variables" }));
    expect((screen.getByRole("textbox", { name: "Next prompt" }) as HTMLTextAreaElement).value).toBe("Hello model");
  });

  it("reduces fragmented reasoning/text events and restores persisted normalized output", () => {
    const streamed = reducePayloadGenerationEvent([], { type: "candidate.reasoning.delta", data: { attemptId: "attempt-1", ordinal: 1, text: "why " } });
    const completed = reducePayloadGenerationEvent(streamed, { type: "candidate.text.delta", data: { attemptId: "attempt-1", ordinal: 1, text: "payload" } });
    expect(completed[0]).toMatchObject({ ordinal: 1, reasoning: "why ", text: "payload", status: "streaming" });

    const persisted = candidatesFromDetail({
      generation: { id: "generation-1", sessionId: "session-1", branchId: "branch-1", contextNodeId: null, status: "completed" },
      attempts: [
        { id: "attempt-1", ordinal: 1, status: "completed", normalizedOutput: { text: "payload", reasoning: "why" } },
        { id: "attempt-2", ordinal: 2, status: "failed", normalizedOutput: { text: "", reasoning: "", error: "generator unavailable" }, traceHash: "b".repeat(64), backendSnapshot: { kind: "codex-app-server" } }
      ],
      revisions: [
        { id: "revision-1", generationId: "generation-1", attemptId: "attempt-1", ordinal: 1, operation: "generated", text: "payload" },
        { id: "revision-2", generationId: "generation-1", attemptId: null, parentRevisionId: "revision-1", ordinal: 1, operation: "transformed", text: "transformed payload" }
      ]
    });
    expect(persisted).toHaveLength(2);
    expect(persisted[0]).toMatchObject({ ordinal: 1, text: "payload", reasoning: "why", revisionId: "revision-1" });
    expect(persisted[1]).toMatchObject({ ordinal: 2, status: "failed", error: "generator unavailable", evidence: { traceHash: "b".repeat(64), backendSnapshot: { kind: "codex-app-server" } } });
  });

  it("posts the frozen context contract and only uses an explicitly selected persisted candidate", async () => {
    const requests: Array<{ path: string; body: unknown }> = [];
    const profile = {
      id: "profile-r1", assetId: "profile", kind: "payload-generator-profile", revision: 1,
      name: "Local generator", description: "", tags: [], provenance: {},
      value: { backend: { kind: "http-provider", providerProfileRevisionId: "provider-r1", modelId: "model-a" } },
      contentHash: "a".repeat(64), trusted: true, archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z"
    };
    const detail = {
      generation: { id: "generation-1", sessionId: "session-1", branchId: "branch-1", contextNodeId: "node-1", status: "completed", candidateCount: 1 },
      attempts: [{ id: "attempt-1", ordinal: 1, status: "completed", normalizedOutput: { text: "generated payload", reasoning: "candidate rationale" } }],
      revisions: [{ id: "revision-1", generationId: "generation-1", attemptId: "attempt-1", ordinal: 1, operation: "generated", text: "generated payload" }],
      outcomes: []
    };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://lathe.local");
      if (url.pathname === "/api/payload-workbench/settings") return jsonResponse({ settings: { defaultGeneratorProfileRevisionId: profile.id, candidateCount: 1, diversity: "balanced", contextMode: "minimal", includeProjectBrief: true, includeSessionBrief: true, includeTargetConfig: false, budgetChars: 32_000 } });
      if (url.pathname === "/api/assets") return jsonResponse({ assets: url.searchParams.get("kind") === "payload-generator-profile" ? [profile] : [] });
      if (url.pathname === "/api/payload-generations" && init?.method !== "POST") return jsonResponse({ generations: [], standaloneRevisions: [], standaloneOutcomes: [], nextCursor: null });
      if (url.pathname === "/api/payload-generations" && init?.method === "POST") {
        requests.push({ path: url.pathname, body: JSON.parse(String(init.body)) });
        return jsonResponse(detail);
      }
      if (url.pathname === "/api/payload-generations/generation-1") return jsonResponse(detail);
      if (url.pathname.startsWith("/api/events/")) return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
      return jsonResponse({});
    }));
    const onUse = vi.fn();
    renderWorkbench(<PayloadWorkbench value="source" context={{
      projectId: "project-1", sessionId: "session-1", sessionName: "Session", branchId: "branch-1", branchName: "main", contextNodeId: "node-1",
      path: [{ id: "node-1", sessionId: "session-1", parentId: null, role: "user", parts: [{ type: "text", text: "prior" }], sourceRunId: null, configSnapshotId: null, sourcePayloadRevisionId: null, createdAt: "2026-08-15T00:00:00.000Z" }]
    }} onUse={onUse} />);

    fireEvent.click(screen.getByRole("button", { name: "Open payload workbench" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Generate/ }), { button: 0, ctrlKey: false });
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Generator profile" }) as HTMLSelectElement).value).toBe("profile-r1"));
    fireEvent.change(screen.getByRole("textbox", { name: "Operator instruction" }), { target: { value: "Vary the authority framing" } });
    fireEvent.click(screen.getByRole("button", { name: "Generate candidates" }));

    await screen.findByText("generated payload");
    expect(onUse).not.toHaveBeenCalled();
    expect(requests[0]?.body).toMatchObject({ profileRevisionId: "profile-r1", branchId: "branch-1", contextNodeId: "node-1", context: { mode: "minimal", budgetChars: 32_000 }, candidateCount: 1, confirmProjectReadOnly: false });
    fireEvent.click(screen.getByRole("button", { name: "Use" }));
    expect(onUse).toHaveBeenCalledWith({ text: "generated payload", sourcePayloadRevisionId: "revision-1" });
  });

  it("reattaches the newest active generation after reopening and exposes its trace and cancellation", async () => {
    const cancelled: string[] = [];
    const activeDetail = {
      generation: { id: "generation-active-new", sessionId: "session-1", branchId: "branch-1", contextNodeId: "node-1", status: "streaming", operatorInstruction: "Continue the live helper run", createdAt: "2026-08-15T12:00:00.000Z", candidateCount: 1 },
      attempts: [{ id: "attempt-live", ordinal: 1, status: "streaming", normalizedOutput: { text: "live payload", reasoning: "live rationale" }, traceHash: "c".repeat(64), backendSnapshot: { kind: "http-provider" } }],
      revisions: [], outcomes: []
    };
    const olderDetail = { generation: { ...activeDetail.generation, id: "generation-active-old", createdAt: "2026-08-15T11:00:00.000Z" }, attempts: [], revisions: [], outcomes: [] };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://lathe.local");
      if (url.pathname === "/api/payload-workbench/settings") return jsonResponse({ settings: {} });
      if (url.pathname === "/api/assets") return jsonResponse({ assets: [] });
      if (url.pathname === "/api/payload-generations") return jsonResponse({ generations: [olderDetail, activeDetail], standaloneRevisions: [], standaloneOutcomes: [], nextCursor: null });
      if (url.pathname === "/api/payload-generations/generation-active-new/cancel") { cancelled.push(url.pathname); return jsonResponse({ cancelled: true }); }
      if (url.pathname === "/api/payload-generations/generation-active-new") return jsonResponse(activeDetail);
      if (url.pathname.startsWith("/api/events/")) return new Response("", { status: 200, headers: { "Content-Type": "text/event-stream" } });
      return jsonResponse({});
    }));
    const context = {
      projectId: "project-1", sessionId: "session-1", sessionName: "Session", branchId: "branch-1", branchName: "main", contextNodeId: "node-1",
      path: [{ id: "node-1", sessionId: "session-1", parentId: null, role: "user" as const, parts: [{ type: "text" as const, text: "prior" }], sourceRunId: null, configSnapshotId: null, sourcePayloadRevisionId: null, createdAt: "2026-08-15T00:00:00.000Z" }]
    };
    renderWorkbench(<PayloadWorkbench value="source" context={context} onUse={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Open payload workbench" }));
    expect(await screen.findByText("live payload")).not.toBeNull();
    expect(screen.getByRole("button", { name: `Download generator trace ${"c".repeat(64)}` })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Close payload workbench" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Payload workbench" })).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Open payload workbench" }));
    expect(await screen.findByText("live payload")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel payload generation" }));
    await waitFor(() => expect(cancelled).toEqual(["/api/payload-generations/generation-active-new/cancel"]));
  });

  it("attaches outcomes to their exact revision and confirms individual revision deletion", async () => {
    const deleted: string[] = [];
    const seeded: string[] = [];
    const revisions = [
      { id: "revision-manual-1", generationId: null, attemptId: null, parentRevisionId: null, ordinal: 1, operation: "edited", text: "first payload", createdAt: "2026-08-15T10:00:00.000Z" },
      { id: "revision-manual-2", generationId: null, attemptId: null, parentRevisionId: null, ordinal: 1, operation: "edited", text: "second payload", createdAt: "2026-08-15T11:00:00.000Z" }
    ];
    const outcomes = [{ revisionId: "revision-manual-2", nodeId: "node-2", runId: "run-2", branchId: "branch-1", status: "completed", classification: "content-policy", operatorLabel: "policy hit", operatorNotes: "Observed only on the second revision", createdAt: "2026-08-15T12:00:00.000Z" }];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://lathe.local");
      if (url.pathname === "/api/payload-workbench/settings") return jsonResponse({ settings: {} });
      if (url.pathname === "/api/assets") return jsonResponse({ assets: [] });
      if (url.pathname === "/api/payload-generations") return jsonResponse({ generations: [], standaloneRevisions: revisions, standaloneOutcomes: outcomes, nextCursor: null });
      if (url.pathname === "/api/payload-revisions/revision-manual-2" && init?.method === "DELETE") { deleted.push(url.pathname); return jsonResponse({ deleted: true }); }
      if (url.pathname === "/api/payload-revisions" && init?.method === "POST") { seeded.push(url.pathname); return jsonResponse({ revision: { ...revisions[1], id: "revision-reseeded", text: "second payload" } }); }
      return jsonResponse({});
    }));
    const onUse = vi.fn();
    renderWorkbench(<PayloadWorkbench value="source" context={{ projectId: "project-1", sessionId: "session-1", sessionName: "Session", branchId: "branch-1", branchName: "main", contextNodeId: null, path: [] }} onUse={onUse} />);
    fireEvent.click(screen.getByRole("button", { name: "Open payload workbench" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }), { button: 0, ctrlKey: false });
    const outcome = await screen.findByText("policy hit");
    expect(outcome.closest("article")?.textContent).toContain("second payload");
    expect(outcome.closest("article")?.textContent).not.toContain("first payload");
    fireEvent.click(screen.getAllByRole("button", { name: "Restore to Transform" })[1]!);
    fireEvent.mouseDown(screen.getByRole("tab", { name: /History/ }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("button", { name: "Delete payload revision revision-manual-2" }));
    fireEvent.click(await screen.findByRole("button", { name: "Delete revision" }));
    await waitFor(() => expect(deleted).toEqual(["/api/payload-revisions/revision-manual-2"]));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Transform/ }), { button: 0, ctrlKey: false });
    fireEvent.click(screen.getByRole("button", { name: "Use as next prompt" }));
    await waitFor(() => expect(seeded).toEqual(["/api/payload-revisions"]));
    expect(onUse).toHaveBeenCalledWith({ text: "second payload", sourcePayloadRevisionId: "revision-reseeded" });
  });
});
