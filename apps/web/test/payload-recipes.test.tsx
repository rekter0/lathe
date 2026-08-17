// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { PayloadArsenal } from "../src/components/payload-arsenal.js";
import { PayloadWorkbench } from "../src/components/payload-workbench.js";
import { OperatorDialogProvider } from "../src/components/operator-dialog.js";
import type { PayloadAssetRevision, PayloadRecipePreview, PayloadRevision } from "../src/payload-workbench-api.js";

function renderApp(element: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><OperatorDialogProvider>{element}</OperatorDialogProvider></QueryClientProvider>);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function recipeAsset(trusted = true): PayloadAssetRevision {
  return {
    id: "recipe-r2",
    assetId: "recipe-lineage",
    kind: "payload-recipe",
    revision: 2,
    name: "Header bypass lineage",
    description: "Captured seed followed by an exact deterministic transform.",
    tags: ["headers", "reusable"],
    provenance: { sourcePayloadRevisionId: "payload-final" },
    value: {
      version: 1,
      finalContentHash: "c".repeat(64),
      variables: [{ name: "objective", defaultValue: null }],
      steps: [
        { kind: "checkpoint", sourceOperation: "generated", text: "seed", contentHash: "a".repeat(64), generator: { profileRevisionId: "profile-r1", instructionRevisionId: null, techniqueRevisionIds: [], pipelineRevisionId: null, contextHash: "d".repeat(64) } },
        { kind: "transform", transformId: "uppercase", version: 1, parameters: {}, variableNames: [], inputContentHash: "a".repeat(64), outputContentHash: "c".repeat(64), capturedOutputText: "SEED", pipelineRevisionId: null }
      ]
    },
    contentHash: "f".repeat(64),
    trusted,
    archivedAt: null,
    createdAt: "2026-08-17T00:00:00.000Z"
  };
}

const profile: PayloadAssetRevision = {
  id: "profile-r1",
  assetId: "profile",
  kind: "payload-generator-profile",
  revision: 1,
  name: "Captured helper",
  description: "",
  tags: [],
  provenance: {},
  value: { backend: { kind: "http-provider", modelId: "fixture" } },
  contentHash: "e".repeat(64),
  trusted: true,
  archivedAt: null,
  createdAt: "2026-08-16T00:00:00.000Z"
};

const preview: PayloadRecipePreview = {
  recipeRevisionId: "recipe-r2",
  recipeContentHash: "f".repeat(64),
  sessionId: "session-1",
  compatible: true,
  completed: true,
  preflightHash: "p".repeat(64),
  variables: { required: ["objective"], missing: [], resolved: { objective: "" } },
  steps: [
    { index: 0, kind: "checkpoint", label: "generated", status: "captured", inputContentHash: null, outputContentHash: "a".repeat(64), capturedOutputContentHash: "a".repeat(64), matchesCaptured: true, text: "seed", textTruncated: false, codePoints: 4, error: null },
    { index: 1, kind: "transform", label: "uppercase", status: "evaluated", inputContentHash: "a".repeat(64), outputContentHash: "c".repeat(64), capturedOutputContentHash: "c".repeat(64), matchesCaptured: true, text: "SEED", textTruncated: false, codePoints: 4, error: null }
  ],
  finalText: "SEED",
  finalContentHash: "c".repeat(64),
  capturedFinalContentHash: "c".repeat(64),
  matchesCaptured: true,
  violations: []
};

describe("payload recipes", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("inspects exact recipe steps, preflights variables, and explicitly replays into Transform", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const replayed: PayloadRevision = { id: "replay-final", ordinal: 2, operation: "transformed", text: "SEED", parentRevisionId: "replay-seed", provenance: { kind: "recipe-replay", recipeRevisionId: "recipe-r2" } };
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://lathe.local");
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/preview")) return jsonResponse({ preview });
      if (url.pathname.endsWith("/replay")) return jsonResponse({ recipe: recipeAsset(), revision: replayed, revisions: [replayed], completed: true, error: null }, 201);
      return jsonResponse({});
    }));
    const onReplayRecipe = vi.fn();
    renderApp(<PayloadArsenal profiles={[profile]} instructions={[]} techniques={[]} pipelines={[]} recipes={[recipeAsset()]} sessionId="session-1" selectedTransformId="" selectedProfileRevisionId="" selectedInstructionRevisionId="" selectedTechniqueRevisionIds={[]} selectedPipelineRevisionId="" loading={false} error={undefined} onSelectTransform={() => undefined} onSelectProfile={() => undefined} onSelectInstruction={() => undefined} onSelectTechnique={() => undefined} onSelectPipeline={() => undefined} onReplayRecipe={onReplayRecipe} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "recipe" } });
    fireEvent.click(screen.getByRole("button", { name: /Header bypass lineage/ }));
    expect(screen.getByText("recipe-r2")).not.toBeNull();
    expect(screen.getByText("Captured checkpoint")).not.toBeNull();
    expect(screen.getAllByText("uppercase").length).toBeGreaterThan(0);
    expect(screen.getAllByText("profile-r1").length).toBeGreaterThan(0);
    expect((screen.getByRole("button", { name: "Replay into Transform" }) as HTMLButtonElement).disabled).toBe(true);

    fireEvent.change(screen.getByRole("textbox", { name: "objective" }), { target: { value: "Inspect headers" } });
    fireEvent.click(screen.getByRole("button", { name: "Preview recipe" }));
    await screen.findByRole("region", { name: "Recipe preview result" });
    expect(screen.getByText("Final hash matches captured")).not.toBeNull();
    expect(requests.find((request) => request.path.endsWith("/preview"))?.body).toEqual({ sessionId: "session-1", variables: { objective: "Inspect headers" } });

    const replayButton = screen.getByRole("button", { name: "Replay into Transform" }) as HTMLButtonElement;
    expect(replayButton.disabled).toBe(false);
    fireEvent.click(replayButton);
    await waitFor(() => expect(onReplayRecipe).toHaveBeenCalledWith(replayed, undefined));
    expect(requests.find((request) => request.path.endsWith("/replay"))?.body).toEqual({ sessionId: "session-1", variables: { objective: "Inspect headers" }, preflightHash: "p".repeat(64) });
  });

  it("previews untrusted recipes but requires explicit trust as a new exact revision before replay", async () => {
    const requests: Array<{ path: string; body: Record<string, unknown> }> = [];
    const trustedRevision = { ...recipeAsset(true), id: "recipe-r3", revision: 3, provenance: { ...recipeAsset().provenance, trustedFromRevisionId: "recipe-r2" } } satisfies PayloadAssetRevision;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://lathe.local");
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ path: url.pathname, body });
      if (url.pathname.endsWith("/preview")) return jsonResponse({ preview: { ...preview, compatible: false, preflightHash: null, violations: [{ code: "untrusted-recipe", severity: "error", stepIndex: null, message: "Payload recipe must be trusted before replay" }] } });
      if (url.pathname === "/api/library/assets") return jsonResponse({ asset: trustedRevision }, 201);
      return jsonResponse({});
    }));
    renderApp(<PayloadArsenal profiles={[profile]} instructions={[]} techniques={[]} pipelines={[]} recipes={[recipeAsset(false)]} sessionId="session-1" selectedTransformId="" selectedProfileRevisionId="" selectedInstructionRevisionId="" selectedTechniqueRevisionIds={[]} selectedPipelineRevisionId="" loading={false} error={undefined} onSelectTransform={() => undefined} onSelectProfile={() => undefined} onSelectInstruction={() => undefined} onSelectTechnique={() => undefined} onSelectPipeline={() => undefined} onReplayRecipe={() => undefined} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "recipe" } });
    fireEvent.click(screen.getByRole("button", { name: /Header bypass lineage/ }));
    expect((screen.getByRole("button", { name: "Preview recipe" }) as HTMLButtonElement).disabled).toBe(false);
    expect((screen.getByRole("button", { name: "Replay into Transform" }) as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Preview recipe" }));
    expect(await screen.findByText(/Payload recipe must be trusted before replay/)).not.toBeNull();
    expect(requests.find((request) => request.path.endsWith("/preview"))?.body).toEqual({ sessionId: "session-1", variables: {} });

    fireEvent.click(screen.getByRole("button", { name: "Trust as new revision" }));
    const confirmation = await screen.findByRole("dialog", { name: "Trust this recipe as a new revision?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Trust as new revision" }));
    await waitFor(() => expect(requests.find((request) => request.path === "/api/library/assets")?.body).toMatchObject({ assetId: "recipe-lineage", kind: "payload-recipe", trusted: true, provenance: { trustedFromRevisionId: "recipe-r2" } }));
    await waitFor(() => expect(screen.getAllByText("recipe-r3").length).toBeGreaterThan(0));
    expect(screen.getAllByText("r3").length).toBeGreaterThan(0);
  });

  it("confirms recipe archival, surfaces reference conflicts, and archives the exact revision", async () => {
    let deleteAttempts = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://lathe.local");
      if (url.pathname === "/api/library/assets/recipe-r2" && init?.method === "DELETE") {
        deleteAttempts += 1;
        if (deleteAttempts === 1) return jsonResponse({ error: { code: "resource-in-use", message: "Library revision is still in use.", references: [{ kind: "payload-generation", label: "Saved lineage", detail: "generator profile" }] } }, 409);
        return jsonResponse({ deleted: true, id: "recipe-r2" });
      }
      if (url.pathname === "/api/payload-recipes/recipe-r2/preview") return jsonResponse({ preview });
      return jsonResponse({});
    }));
    renderApp(<PayloadArsenal profiles={[profile]} instructions={[]} techniques={[]} pipelines={[]} recipes={[recipeAsset()]} sessionId="session-1" selectedTransformId="" selectedProfileRevisionId="" selectedInstructionRevisionId="" selectedTechniqueRevisionIds={[]} selectedPipelineRevisionId="" loading={false} error={undefined} onSelectTransform={() => undefined} onSelectProfile={() => undefined} onSelectInstruction={() => undefined} onSelectTechnique={() => undefined} onSelectPipeline={() => undefined} onReplayRecipe={() => undefined} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "recipe" } });
    fireEvent.click(screen.getByRole("button", { name: /Header bypass lineage/ }));
    fireEvent.click(screen.getByRole("button", { name: "Preview recipe" }));
    await screen.findByRole("region", { name: "Recipe preview result" });
    expect((screen.getByRole("button", { name: "Replay into Transform" }) as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(screen.getByRole("button", { name: "Archive recipe" }));
    let confirmation = await screen.findByRole("dialog", { name: "Archive recipe “Header bypass lineage”?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Archive recipe" }));
    const conflict = await screen.findByRole("alert");
    expect(conflict.textContent).toContain("Library revision is still in use.");
    expect(conflict.textContent).toContain("payload-generation · Saved lineage · generator profile");

    fireEvent.click(screen.getByRole("button", { name: "Archive recipe" }));
    confirmation = await screen.findByRole("dialog", { name: "Archive recipe “Header bypass lineage”?" });
    fireEvent.click(within(confirmation).getByRole("button", { name: "Archive recipe" }));
    await waitFor(() => expect(deleteAttempts).toBe(2));
    expect(await screen.findByText("Archived exact recipe revision recipe-r2.")).not.toBeNull();
    expect((screen.getByRole("button", { name: "Archive recipe" }) as HTMLButtonElement).disabled).toBe(true);
    expect((screen.getByRole("button", { name: "Replay into Transform" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Archived recipe revisions remain inspectable but cannot start a new replay.")).not.toBeNull();
  });

  it("saves an exact History revision through the reusable metadata dialog", async () => {
    const source: PayloadRevision = { id: "payload-final", ordinal: 3, operation: "transformed", text: "payload", contentHash: "b".repeat(64), parentRevisionId: "payload-parent", createdAt: "2026-08-17T00:00:00.000Z" };
    const requests: Array<{ path: string; method: string; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://lathe.local");
      const method = init?.method ?? "GET";
      const body = init?.body ? JSON.parse(String(init.body)) as Record<string, unknown> : {};
      requests.push({ path: url.pathname, method, body });
      if (url.pathname === "/api/payload-workbench/settings") return jsonResponse({ settings: {} });
      if (url.pathname === "/api/sessions/session-1/payload-workbench/settings") return jsonResponse({ settings: null });
      if (url.pathname === "/api/assets") return jsonResponse({ assets: [] });
      if (url.pathname === "/api/payload-generations") return jsonResponse({ generations: [], standaloneRevisions: [source], standaloneOutcomes: [], nextCursor: null });
      if (url.pathname === "/api/payload-revisions/payload-final/recipes") return jsonResponse({ recipe: recipeAsset() }, 201);
      return jsonResponse({});
    }));
    renderApp(<PayloadWorkbench value="draft" context={{ projectId: "project-1", sessionId: "session-1", sessionName: "Session", branchId: "branch-1", branchName: "main", contextNodeId: null, path: [] }} onUse={() => undefined} />);

    fireEvent.click(screen.getByRole("button", { name: "Open payload workbench" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "History" }), { button: 0, ctrlKey: false });
    const saveButton = await screen.findByRole("button", { name: "Save as recipe" });
    fireEvent.click(saveButton);
    const dialog = await screen.findByRole("dialog", { name: "Save payload lineage as recipe" });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Name" }), { target: { value: "Reusable header bypass" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: "Description" }), { target: { value: "Exact tested lineage" } });
    fireEvent.change(within(dialog).getByRole("textbox", { name: /^Tags/ }), { target: { value: "headers, reusable, headers" } });
    fireEvent.click(within(dialog).getByRole("button", { name: "Save recipe" }));

    await waitFor(() => expect(requests.find((request) => request.path === "/api/payload-revisions/payload-final/recipes")).toEqual({ path: "/api/payload-revisions/payload-final/recipes", method: "POST", body: { name: "Reusable header bypass", description: "Exact tested lineage", tags: ["headers", "reusable"] } }));
    expect(screen.queryByRole("dialog", { name: "Save payload lineage as recipe" })).toBeNull();
  });
});
