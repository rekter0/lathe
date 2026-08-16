// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
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
      if (url.pathname === "/api/sessions/session-1/payload-workbench/settings") return jsonResponse({ settings: { generatorProfileRevisionId: null, instructionRevisionId: null, techniqueRevisionIds: [], pipelineRevisionId: null, operatorInstruction: "Saved session preference", variables: {}, candidateCount: 2, diversity: "high", contextMode: "full", includeProjectBrief: false, includeSessionBrief: true, includeTargetConfig: true, budgetChars: 24_000 } });
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
    expect((screen.getByRole("textbox", { name: "Operator instruction" }) as HTMLTextAreaElement).value).toBe("Saved session preference");
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

  it("restores the last complete workbench configuration for the session after reopening", async () => {
    const asset = (id: string, assetId: string, kind: string, name: string, value: unknown) => ({
      id, assetId, kind, revision: 1, name, description: "", tags: [], provenance: {}, value,
      contentHash: id.padEnd(64, "a").slice(0, 64), trusted: true, archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z"
    });
    const profiles = [
      asset("profile-r1", "profile-1", "payload-generator-profile", "Generator one", { backend: { kind: "http-provider", providerProfileRevisionId: "provider-r1", modelId: "model-a" } }),
      asset("profile-r2", "profile-2", "payload-generator-profile", "Generator two", { backend: { kind: "http-provider", providerProfileRevisionId: "provider-r1", modelId: "model-b" } })
    ];
    const instruction = asset("instruction-r1", "instruction-1", "payload-generator-instruction", "Concise payload", { template: "Keep it concise" });
    const technique = asset("technique-r1", "technique-1", "payload-technique", "Authority framing", { instructions: "Use authority framing", conflictsWith: [], before: [], after: [] });
    const pipeline = asset("pipeline-r1", "pipeline-1", "payload-pipeline", "Encode once", { steps: [{ transformId: "base64-encode", version: 1, enabled: true }] });
    let persisted: Record<string, unknown> | null = null;
    const writes: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://lathe.local");
      if (url.pathname === "/api/payload-workbench/settings") return jsonResponse({ settings: { defaultGeneratorProfileRevisionId: "profile-r1", defaultInstructionRevisionId: null, candidateCount: 1, diversity: "balanced", contextMode: "minimal", includeProjectBrief: true, includeSessionBrief: true, includeTargetConfig: false, budgetChars: 32_000 } });
      if (url.pathname === "/api/sessions/session-1/payload-workbench/settings") {
        if (init?.method === "PUT") {
          persisted = JSON.parse(String(init.body)) as Record<string, unknown>;
          writes.push(persisted);
        }
        return jsonResponse({ settings: persisted });
      }
      if (url.pathname === "/api/assets") {
        const byKind: Record<string, unknown[]> = {
          "payload-generator-profile": profiles,
          "payload-generator-instruction": [instruction],
          "payload-technique": [technique],
          "payload-pipeline": [pipeline]
        };
        return jsonResponse({ assets: byKind[url.searchParams.get("kind") ?? ""] ?? [] });
      }
      if (url.pathname === "/api/payload-generations") return jsonResponse({ generations: [], standaloneRevisions: [], standaloneOutcomes: [], nextCursor: null });
      return jsonResponse({});
    }));
    const context = { projectId: "project-1", sessionId: "session-1", sessionName: "Session", branchId: "branch-1", branchName: "main", contextNodeId: null, path: [] };
    renderWorkbench(<PayloadWorkbench value="source" context={context} onUse={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Open payload workbench" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Generate/ }), { button: 0, ctrlKey: false });
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Generator profile" }) as HTMLSelectElement).value).toBe("profile-r1"));
    fireEvent.change(screen.getByRole("combobox", { name: "Generator profile" }), { target: { value: "profile-r2" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Reusable instruction" }), { target: { value: "instruction-r1" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Operator instruction" }), { target: { value: "Keep varying this session objective" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Add technique" }), { target: { value: "technique-r1" } });
    fireEvent.click(screen.getByRole("button", { name: "Add variable" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Variable 1 name" }), { target: { value: "target_name" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Variable target_name value" }), { target: { value: "Acme model" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Candidates" }), { target: { value: "3" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Diversity" }), { target: { value: "high" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Conversation" }), { target: { value: "full" } });
    fireEvent.click(screen.getByLabelText("Project brief"));
    fireEvent.change(screen.getByRole("spinbutton", { name: "Exact context budget" }), { target: { value: "48000" } });
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Transform/ }), { button: 0, ctrlKey: false });
    fireEvent.change(screen.getByRole("combobox", { name: "Transform pipeline" }), { target: { value: "pipeline-r1" } });
    fireEvent.click(screen.getByRole("button", { name: "Close payload workbench" }));

    await waitFor(() => expect(writes.at(-1)).toMatchObject({
      generatorProfileRevisionId: "profile-r2", instructionRevisionId: "instruction-r1", techniqueRevisionIds: ["technique-r1"], pipelineRevisionId: "pipeline-r1",
      variables: { target_name: "Acme model" }, operatorInstruction: "Keep varying this session objective", candidateCount: 3, diversity: "high",
      contextMode: "full", includeProjectBrief: false, includeSessionBrief: true, includeTargetConfig: true, budgetChars: 48_000
    }));

    fireEvent.click(screen.getByRole("button", { name: "Open payload workbench" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Generate/ }), { button: 0, ctrlKey: false });
    await waitFor(() => expect((screen.getByRole("combobox", { name: "Generator profile" }) as HTMLSelectElement).value).toBe("profile-r2"));
    expect((screen.getByRole("combobox", { name: "Reusable instruction" }) as HTMLSelectElement).value).toBe("instruction-r1");
    expect((screen.getByRole("textbox", { name: "Operator instruction" }) as HTMLTextAreaElement).value).toBe("Keep varying this session objective");
    expect((screen.getByRole("textbox", { name: "Variable target_name value" }) as HTMLInputElement).value).toBe("Acme model");
    expect((screen.getByRole("combobox", { name: "Candidates" }) as HTMLSelectElement).value).toBe("3");
    expect((screen.getByRole("combobox", { name: "Conversation" }) as HTMLSelectElement).value).toBe("full");
    expect((screen.getByRole("spinbutton", { name: "Exact context budget" }) as HTMLInputElement).value).toBe("48000");
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Transform/ }), { button: 0, ctrlKey: false });
    expect((screen.getByRole("combobox", { name: "Transform pipeline" }) as HTMLSelectElement).value).toBe("pipeline-r1");
  });

  it("disables controls and never writes when closed before slow session hydration completes", async () => {
    let resolveSessionSettings!: (response: Response) => void;
    const delayedSessionSettings = new Promise<Response>((resolve) => { resolveSessionSettings = resolve; });
    const writes: unknown[] = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://lathe.local");
      if (url.pathname === "/api/payload-workbench/settings") return jsonResponse({ settings: {} });
      if (url.pathname === "/api/sessions/session-slow/payload-workbench/settings") {
        if (init?.method === "PUT") { writes.push(JSON.parse(String(init.body))); return jsonResponse({ settings: writes.at(-1) }); }
        return delayedSessionSettings;
      }
      if (url.pathname === "/api/assets") return jsonResponse({ assets: [] });
      if (url.pathname === "/api/payload-generations") return jsonResponse({ generations: [], standaloneRevisions: [], standaloneOutcomes: [], nextCursor: null });
      return jsonResponse({});
    }));
    renderWorkbench(<PayloadWorkbench value="source" context={{ projectId: "project-1", sessionId: "session-slow", sessionName: "Slow", branchId: "branch-1", branchName: "main", contextNodeId: null, path: [] }} onUse={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Open payload workbench" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Generate/ }), { button: 0, ctrlKey: false });
    expect(await screen.findByText(/Loading this session's workbench settings/)).not.toBeNull();
    expect((screen.getByRole("combobox", { name: "Generator profile" }).closest("fieldset") as HTMLFieldSetElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Close payload workbench" }));
    await act(async () => {
      resolveSessionSettings(jsonResponse({ settings: null }));
      await Promise.resolve();
    });
    expect(writes).toEqual([]);
  });

  it("keeps the newest local choices when reopened before the close flush finishes", async () => {
    let resolveSave!: (response: Response) => void;
    const delayedSave = new Promise<Response>((resolve) => { resolveSave = resolve; });
    const writes: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://lathe.local");
      if (url.pathname === "/api/payload-workbench/settings") return jsonResponse({ settings: {} });
      if (url.pathname === "/api/sessions/session-race/payload-workbench/settings") {
        if (init?.method === "PUT") {
          writes.push(JSON.parse(String(init.body)) as Record<string, unknown>);
          return delayedSave;
        }
        return jsonResponse({ settings: null });
      }
      if (url.pathname === "/api/assets") return jsonResponse({ assets: [] });
      if (url.pathname === "/api/payload-generations") return jsonResponse({ generations: [], standaloneRevisions: [], standaloneOutcomes: [], nextCursor: null });
      return jsonResponse({});
    }));
    renderWorkbench(<PayloadWorkbench value="source" context={{ projectId: "project-1", sessionId: "session-race", sessionName: "Race", branchId: "branch-1", branchName: "main", contextNodeId: null, path: [] }} onUse={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Open payload workbench" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Generate/ }), { button: 0, ctrlKey: false });
    await waitFor(() => expect(screen.queryByText(/Loading this session's workbench settings/)).toBeNull());
    fireEvent.change(screen.getByRole("textbox", { name: "Operator instruction" }), { target: { value: "Newest unsaved objective" } });
    fireEvent.click(screen.getByRole("button", { name: "Close payload workbench" }));
    await waitFor(() => expect(writes).toHaveLength(1));

    fireEvent.click(screen.getByRole("button", { name: "Open payload workbench" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: /Generate/ }), { button: 0, ctrlKey: false });
    await waitFor(() => expect((screen.getByRole("textbox", { name: "Operator instruction" }) as HTMLTextAreaElement).value).toBe("Newest unsaved objective"));
    await act(async () => {
      resolveSave(jsonResponse({ settings: writes[0] }));
      await delayedSave;
    });
  });
});
