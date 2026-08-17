// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState, type ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { PayloadVariantMatrixDraft } from "@lathe/domain";
import { PayloadVariantMatrix, defaultPayloadVariantMatrixDraft } from "../src/components/payload-variant-matrix.js";
import { PayloadWorkbench } from "../src/components/payload-workbench.js";
import { OperatorDialogProvider } from "../src/components/operator-dialog.js";
import type { PayloadRevision } from "../src/payload-workbench-api.js";

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function renderWithQuery(element: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}>{element}</QueryClientProvider>);
}

function renderWorkbench(element: ReactElement) {
  return renderWithQuery(<OperatorDialogProvider>{element}</OperatorDialogProvider>);
}

function Harness({
  sourceText = "Attack at dawn",
  sourceRevision = null,
  historyRevisions = [],
  initialDraft = defaultPayloadVariantMatrixDraft,
  configIssue = null,
  onSourceRecorded = vi.fn(),
  onRestore = vi.fn(),
  onSendToTransform = vi.fn(),
  onUse = vi.fn()
}: {
  sourceText?: string;
  sourceRevision?: { id: string; text: string | null } | null;
  historyRevisions?: PayloadRevision[];
  initialDraft?: PayloadVariantMatrixDraft;
  configIssue?: string | null;
  onSourceRecorded?: (revisionId: string, text: string) => void;
  onRestore?: (revision: PayloadRevision) => void;
  onSendToTransform?: (revision: PayloadRevision) => void;
  onUse?: (revision: PayloadRevision) => void;
}) {
  const [draft, setDraft] = useState<PayloadVariantMatrixDraft>(() => ({
    ...initialDraft,
    parameterSets: initialDraft.parameterSets.map((parameters) => ({ ...parameters }))
  }));
  return <PayloadVariantMatrix
    sessionId="session-1"
    sourceText={sourceText}
    sourceRevision={sourceRevision}
    draft={draft}
    historyRevisions={historyRevisions}
    configIssue={configIssue}
    onDraftChange={setDraft}
    onSourceRecorded={onSourceRecorded}
    onRestore={onRestore}
    onSendToTransform={onSendToTransform}
    onUse={onUse}
  />;
}

const readyPreflight = {
  preflightHash: "f".repeat(64),
  source: { revisionId: null, contentHash: "a".repeat(64), codePoints: 14, utf8Bytes: 14 },
  transform: { id: "caesar-rotate", version: 1 },
  rows: [
    { ordinal: 1, parameters: { shift: "1" }, contentHash: "b".repeat(64), codePoints: 14, utf8Bytes: 14, codePointDelta: 0, utf8ByteDelta: 0, duplicateOutputOrdinals: [], matchesControl: false },
    { ordinal: 2, parameters: { shift: "13" }, contentHash: "c".repeat(64), codePoints: 14, utf8Bytes: 14, codePointDelta: 0, utf8ByteDelta: 0, duplicateOutputOrdinals: [], matchesControl: false }
  ],
  totals: { rowCount: 2, codePoints: 42, utf8Bytes: 42 },
  limits: { maxRows: 32, maxTotalCodePoints: 4_000_000, maxTotalUtf8Bytes: 16_777_216 },
  violations: [],
  creatable: true
};

describe("PayloadVariantMatrix", () => {
  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
  });

  it("preflights authoritatively, creates atomically, and exposes exact immutable handoffs", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const sourceRevision = { id: "control-1", ordinal: 1, operation: "edited", text: "Attack at dawn", contentHash: "a".repeat(64), parentRevisionId: null } satisfies PayloadRevision;
    const variant = {
      id: "variant-1",
      ordinal: 1,
      operation: "transformed",
      text: "Buubdl bu ebxo",
      contentHash: "b".repeat(64),
      parentRevisionId: sourceRevision.id,
      provenance: {
        kind: "variant-matrix",
        matrixId: "matrix-1",
        preflightHash: readyPreflight.preflightHash,
        sourceHash: sourceRevision.contentHash,
        transformId: "caesar-rotate",
        version: 1,
        parameters: { shift: "1" },
        ordinal: 1,
        variantCount: 1,
        outputCodePoints: 14,
        outputUtf8Bytes: 14,
        duplicateOutputOf: null
      }
    } satisfies PayloadRevision;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://lathe.local");
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/preflight")) return jsonResponse({ preflight: readyPreflight });
      return jsonResponse({
        matrix: {
          id: "matrix-1",
          sourceRevisionId: sourceRevision.id,
          sourceContentHash: sourceRevision.contentHash,
          transformId: "caesar-rotate",
          version: 1,
          count: 1,
          preflightHash: readyPreflight.preflightHash,
          createdAt: "2026-08-17T00:00:00.000Z"
        },
        variants: [variant]
      });
    }));
    const onSourceRecorded = vi.fn();
    const onRestore = vi.fn();
    const onSendToTransform = vi.fn();
    const onUse = vi.fn();
    renderWithQuery(<Harness onSourceRecorded={onSourceRecorded} onRestore={onRestore} onSendToTransform={onSendToTransform} onUse={onUse} />);

    const create = screen.getByRole("button", { name: "Create variants" }) as HTMLButtonElement;
    expect(create.disabled).toBe(true);
    expect(requests).toHaveLength(0);
    fireEvent.click(screen.getByRole("button", { name: "Run authoritative preflight" }));

    await screen.findByText("Ready to create");
    expect(requests[0]).toEqual({
      path: "/api/sessions/session-1/payload-variant-matrices/preflight",
      body: {
        source: { text: "Attack at dawn", revisionId: null },
        transformId: "caesar-rotate",
        version: 1,
        parameterSets: [{ shift: "1" }, { shift: "13" }]
      }
    });
    expect(screen.getByText(/Aggregate/)).not.toBeNull();
    expect(create.disabled).toBe(false);
    fireEvent.click(create);

    const card = await screen.findByRole("article", { name: "Variant factor 1" });
    expect(requests[1]).toEqual({
      path: "/api/sessions/session-1/payload-variant-matrices",
      body: {
        source: { text: "Attack at dawn", revisionId: null },
        transformId: "caesar-rotate",
        version: 1,
        parameterSets: [{ shift: "1" }, { shift: "13" }],
        preflightHash: readyPreflight.preflightHash
      }
    });
    expect(onSourceRecorded).toHaveBeenCalledWith(sourceRevision.id, sourceRevision.text);
    expect(requests.every((request) => !request.path.includes("payload-generations") && !request.path.includes("/runs"))).toBe(true);
    fireEvent.click(within(card).getByText("Compare raw control and variant"));
    expect(within(card).getByText("Exact control")).not.toBeNull();
    fireEvent.click(within(card).getByRole("button", { name: "Restore" }));
    fireEvent.click(within(card).getByRole("button", { name: "Send to Transform" }));
    fireEvent.click(within(card).getByRole("button", { name: "Use as next prompt" }));
    expect(onRestore).toHaveBeenCalledWith(variant);
    expect(onSendToTransform).toHaveBeenCalledWith(variant);
    expect(onUse).toHaveBeenCalledWith(variant);
  });

  it("invalidates a successful preflight after a factor changes", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({ preflight: readyPreflight })));
    renderWithQuery(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Run authoritative preflight" }));
    await screen.findByText("Ready to create");
    const create = screen.getByRole("button", { name: "Create variants" }) as HTMLButtonElement;
    expect(create.disabled).toBe(false);
    const shift = screen.getAllByRole("spinbutton", { name: /Shift/ })[0]!;
    fireEvent.change(shift, { target: { value: "2" } });

    expect(await screen.findByText(/Run preflight again before creating/i)).not.toBeNull();
    expect(create.disabled).toBe(true);
  });

  it("renders blocked rows with unavailable metrics and never enables Create", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => jsonResponse({
      preflight: {
        ...readyPreflight,
        preflightHash: null,
        source: { ...readyPreflight.source, utf8Bytes: null },
        rows: [{ ordinal: 1, parameters: null, contentHash: null, codePoints: null, utf8Bytes: null, codePointDelta: null, utf8ByteDelta: null, duplicateOutputOrdinals: [], matchesControl: null }],
        totals: { rowCount: 1, codePoints: 4_000_001, utf8Bytes: 0 },
        violations: [{ code: "invalid-source", message: "Payload variant matrix source contains an unpaired UTF-16 surrogate.", ordinal: null }],
        creatable: false
      }
    })));
    renderWithQuery(<Harness />);

    fireEvent.click(screen.getByRole("button", { name: "Run authoritative preflight" }));
    await screen.findByText("Creation blocked");
    expect(screen.getAllByText("Unavailable").length).toBeGreaterThan(0);
    expect(screen.getByRole("alert").textContent).toMatch(/unpaired UTF-16 surrogate/i);
    expect((screen.getByRole("button", { name: "Create variants" }) as HTMLButtonElement).disabled).toBe(true);
  });

  it("reconstructs a matrix from persisted parent-linked revisions", () => {
    const source = { id: "source-history", generationId: "generation-1", ordinal: 1, operation: "generated", text: "control", contentHash: "a".repeat(64), parentRevisionId: null, createdAt: "2026-08-17T00:00:00.000Z" } satisfies PayloadRevision;
    const variant = {
      id: "variant-history", generationId: "generation-1", ordinal: 1, operation: "transformed", text: "CONTROL", contentHash: "b".repeat(64), parentRevisionId: source.id, createdAt: "2026-08-17T00:00:01.000Z",
      provenance: { kind: "variant-matrix", matrixId: "matrix-history", preflightHash: "f".repeat(64), sourceHash: source.contentHash, transformId: "uppercase", version: 1, parameters: {}, ordinal: 1, variantCount: 1, outputCodePoints: 7, outputUtf8Bytes: 7, duplicateOutputOf: null }
    } satisfies PayloadRevision;
    renderWithQuery(<Harness historyRevisions={[source, variant]} />);

    expect(screen.getByRole("region", { name: "Variant matrix matrix-history" })).not.toBeNull();
    expect(screen.getByRole("article", { name: "Variant factor 1" }).textContent).toContain("CONTROL");
  });

  it("guards an unavailable saved transform until the operator selects a supported version", () => {
    const onDraftChange = vi.fn();
    renderWithQuery(<PayloadVariantMatrix
      sessionId="session-1"
      sourceText="control"
      sourceRevision={null}
      draft={{ transformId: "removed-transform", version: 1, parameterSets: [{}] }}
      historyRevisions={[]}
      onDraftChange={onDraftChange}
      onSourceRecorded={() => undefined}
      onRestore={() => undefined}
      onSendToTransform={() => undefined}
      onUse={() => undefined}
    />);

    expect(screen.getByRole("alert").textContent).toMatch(/removed-transform@1 is unavailable/i);
    expect((screen.getByRole("button", { name: "Run authoritative preflight" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(screen.getByRole("combobox", { name: /Registry transform/ }), { target: { value: "uppercase" } });
    expect(onDraftChange).toHaveBeenCalledWith({ transformId: "uppercase", version: 1, parameterSets: [{}] });
  });

  it("hydrates and saves the exact session-scoped matrix draft without creating variants", async () => {
    const requests: Array<{ method: string; path: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://lathe.local");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ method, path: url.pathname, body });
      if (url.pathname === "/api/payload-workbench/settings") return jsonResponse({ settings: {} });
      if (url.pathname === "/api/sessions/session-1/payload-workbench/settings" && method === "GET") return jsonResponse({
        settings: {
          variantMatrix: { transformId: "caesar-rotate", version: 1, parameterSets: [{ shift: "2" }, { shift: "7" }] }
        }
      });
      if (url.pathname === "/api/sessions/session-1/payload-workbench/settings" && method === "PUT") return jsonResponse({ settings: body });
      if (url.pathname === "/api/assets") return jsonResponse({ assets: [] });
      if (url.pathname === "/api/payload-generations") return jsonResponse({ generations: [], standaloneRevisions: [], standaloneOutcomes: [], nextCursor: null });
      return jsonResponse({});
    }));
    renderWorkbench(<PayloadWorkbench
      value="control"
      context={{ projectId: "project-1", sessionId: "session-1", sessionName: "Session", branchId: "branch-1", branchName: "main", contextNodeId: null, path: [] }}
      onUse={() => undefined}
    />);

    fireEvent.click(screen.getByRole("button", { name: "Open payload workbench" }));
    fireEvent.mouseDown(await screen.findByRole("tab", { name: "Variants" }));
    await waitFor(() => expect(screen.getAllByRole("spinbutton", { name: /Shift/ })).toHaveLength(2));
    const shifts = screen.getAllByRole("spinbutton", { name: /Shift/ }) as HTMLInputElement[];
    expect(shifts.map((input) => input.value)).toEqual(["2", "7"]);
    fireEvent.change(shifts[0]!, { target: { value: "3" } });

    await waitFor(() => expect(requests.some((request) => request.method === "PUT" && request.body.variantMatrix !== undefined)).toBe(true), { timeout: 1_500 });
    const saved = requests.findLast((request) => request.method === "PUT")!;
    expect(saved.body.variantMatrix).toEqual({ transformId: "caesar-rotate", version: 1, parameterSets: [{ shift: "3" }, { shift: "7" }] });
    expect(requests.some((request) => request.path.includes("payload-variant-matrices"))).toBe(false);
  });
});
