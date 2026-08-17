// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonValue } from "@lathe/domain";
import { PayloadArsenal } from "../src/components/payload-arsenal.js";
import { PayloadWorkbench } from "../src/components/payload-workbench.js";
import { OperatorDialogProvider } from "../src/components/operator-dialog.js";
import type { PayloadAssetRevision, PayloadAssetKind } from "../src/payload-workbench-api.js";

function renderApp(element: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><OperatorDialogProvider>{element}</OperatorDialogProvider></QueryClientProvider>);
}

function asset(input: {
  id: string;
  assetId: string;
  kind: PayloadAssetKind;
  revision: number;
  name: string;
  value: JsonValue;
  description?: string;
  tags?: string[];
  trusted?: boolean;
  archivedAt?: string | null;
}): PayloadAssetRevision {
  return {
    id: input.id,
    assetId: input.assetId,
    kind: input.kind,
    revision: input.revision,
    name: input.name,
    description: input.description ?? "Reusable arsenal item",
    tags: input.tags ?? [],
    provenance: { operatorAuthored: true },
    value: input.value,
    contentHash: `hash-${input.id}`,
    trusted: input.trusted ?? true,
    archivedAt: input.archivedAt ?? null,
    createdAt: `2026-08-${String(input.revision).padStart(2, "0")}T00:00:00.000Z`
  };
}

const profile = asset({ id: "profile-r1", assetId: "profile", kind: "payload-generator-profile", revision: 1, name: "Local helper", tags: ["local"], value: { backend: { kind: "codex-app-server", modelId: "gpt-5.6-codex", effort: "high", workspaceAccess: "isolated" } } });
const instructionR1 = asset({ id: "instruction-r1", assetId: "instruction", kind: "payload-generator-instruction", revision: 1, name: "Careful writer", tags: ["writing"], value: { template: "private-body-token first revision" } });
const instructionR2 = asset({ id: "instruction-r2", assetId: "instruction", kind: "payload-generator-instruction", revision: 2, name: "Careful writer", tags: ["writing"], value: { template: "second revision" } });
const instructionArchivedR3 = asset({ id: "instruction-r3", assetId: "instruction", kind: "payload-generator-instruction", revision: 3, name: "Careful writer", tags: ["writing"], value: { template: "archived revision" }, archivedAt: "2026-08-12T00:00:00.000Z" });
const technique = asset({ id: "technique-r1", assetId: "technique", kind: "payload-technique", revision: 1, name: "Delimiter variance", tags: ["injection"], value: { instructions: "Vary delimiters", conflictsWith: [], before: [], after: [] }, trusted: false });
const pipeline = asset({ id: "pipeline-r1", assetId: "pipeline", kind: "payload-pipeline", revision: 1, name: "Legacy pipeline", value: { steps: [{ transformId: "retired-transform", version: 7, enabled: true }] } });

function ArsenalHarness(props: Partial<React.ComponentProps<typeof PayloadArsenal>> = {}) {
  return <PayloadArsenal
    profiles={[profile]}
    instructions={[instructionR1, instructionR2, instructionArchivedR3]}
    techniques={[technique]}
    pipelines={[pipeline]}
    recipes={[]}
    sessionId={null}
    selectedTransformId=""
    selectedProfileRevisionId=""
    selectedInstructionRevisionId=""
    selectedTechniqueRevisionIds={[]}
    selectedPipelineRevisionId=""
    loading={false}
    error={undefined}
    onSelectTransform={() => undefined}
    onSelectProfile={() => undefined}
    onSelectInstruction={() => undefined}
    onSelectTechnique={() => undefined}
    onSelectPipeline={() => undefined}
    onReplayRecipe={() => undefined}
    {...props}
  />;
}

describe("PayloadArsenal", () => {
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("filters searchable metadata without indexing instruction bodies", () => {
    renderApp(<ArsenalHarness />);
    const search = screen.getByRole("searchbox", { name: "Search" });
    fireEvent.change(search, { target: { value: "private-body-token" } });
    expect(screen.getByText("No arsenal entries match these filters.")).not.toBeNull();

    fireEvent.change(search, { target: { value: "gpt-5.6-codex" } });
    expect(screen.getByRole("button", { name: /Local helper/ })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Careful writer/ })).toBeNull();

    fireEvent.change(search, { target: { value: "" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "transform" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Compatibility" }), { target: { value: "ascii-output" } });
    expect(screen.getByRole("button", { name: /Base64 encode/ })).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Fullwidth/ })).toBeNull();
  });

  it("keeps current revision separate from archived lifecycle and compares exact siblings", () => {
    renderApp(<ArsenalHarness />);
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "instruction" } });
    fireEvent.change(screen.getByRole("combobox", { name: "Revisions" }), { target: { value: "current" } });
    const current = screen.getByRole("button", { name: /Careful writer.*r2.*current/i });
    expect(current).not.toBeNull();
    expect(screen.queryByRole("button", { name: /Careful writer.*r1/i })).toBeNull();

    fireEvent.change(screen.getByRole("combobox", { name: "Revisions" }), { target: { value: "all" } });
    fireEvent.click(screen.getByRole("button", { name: /Careful writer.*r2.*current/i }));
    expect(screen.getByText("instruction-r2")).not.toBeNull();
    const compare = screen.getByRole("combobox", { name: "Compare with revision" }) as HTMLSelectElement;
    expect(compare.value).toBe("instruction-r3");
    expect(screen.getByLabelText("Same-lineage revision comparison").textContent).toContain("hash-instruction-r3");

    fireEvent.change(screen.getByRole("combobox", { name: "State" }), { target: { value: "all" } });
    fireEvent.click(screen.getByRole("button", { name: /Careful writer.*r3.*archived/i }));
    expect((screen.getByRole("button", { name: "Select exact instruction" }) as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText(/Archived revisions remain inspectable/)).not.toBeNull();
  });

  it("hands off exact active entries, blocks unsafe ones, and supports arrow navigation", () => {
    const onSelectProfile = vi.fn();
    const onSelectPipeline = vi.fn();
    renderApp(<ArsenalHarness onSelectProfile={onSelectProfile} onSelectPipeline={onSelectPipeline} />);

    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "profile" } });
    const profileResult = screen.getByRole("button", { name: /Local helper/ });
    fireEvent.click(profileResult);
    fireEvent.click(screen.getByRole("button", { name: "Select exact profile" }));
    expect(onSelectProfile).toHaveBeenCalledWith(profile);

    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "pipeline" } });
    const pipelineResult = screen.getByRole("button", { name: /Legacy pipeline/ });
    fireEvent.click(pipelineResult);
    expect(screen.getByText("Incompatible with this transform registry")).not.toBeNull();
    expect((screen.getByRole("button", { name: "Select exact pipeline" }) as HTMLButtonElement).disabled).toBe(true);
    expect(onSelectPipeline).not.toHaveBeenCalled();

    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "instruction" } });
    const results = screen.getAllByRole("button", { name: /Careful writer/ });
    results[0]!.focus();
    fireEvent.keyDown(results[0]!, { key: "ArrowDown" });
    expect(document.activeElement).toBe(results[1]);
  });

  it("clones as an independent item through the reusable prompt dialog", async () => {
    const fetchMock = vi.fn(async (_input: string | URL | Request, init?: RequestInit) => {
      const body = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({ asset: { ...instructionR2, id: "clone-r1", assetId: "clone", revision: 1, name: body.name } }), { status: 201, headers: { "Content-Type": "application/json" } });
    });
    vi.stubGlobal("fetch", fetchMock);
    renderApp(<ArsenalHarness instructions={[instructionR2]} />);
    fireEvent.change(screen.getByRole("combobox", { name: "Kind" }), { target: { value: "instruction" } });
    fireEvent.click(screen.getByRole("button", { name: /Careful writer/ }));
    fireEvent.click(screen.getByRole("button", { name: "Clone as new item" }));
    const name = await screen.findByRole("textbox", { name: "New item name" });
    fireEvent.change(name, { target: { value: "Independent writer" } });
    fireEvent.click(screen.getByRole("button", { name: "Clone as new item" }));

    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    const request = fetchMock.mock.calls[0];
    const body = JSON.parse(String(request?.[1]?.body)) as Record<string, unknown>;
    expect(body).toMatchObject({ name: "Independent writer", kind: "payload-generator-instruction", trusted: true, provenance: { operatorAuthored: true, clonedFromRevisionId: "instruction-r2" } });
    expect(body).not.toHaveProperty("assetId");
    expect(body).not.toHaveProperty("baseRevisionId");
    expect(await screen.findByText(/Created “Independent writer”/)).not.toBeNull();
  });
});

describe("PayloadWorkbench Arsenal integration", () => {
  beforeEach(() => {
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://lathe.test");
      if (url.pathname === "/api/payload-workbench/settings") return new Response(JSON.stringify({ settings: {} }), { status: 200, headers: { "Content-Type": "application/json" } });
      if (url.pathname === "/api/assets") {
        const assets = url.searchParams.get("kind") === "payload-generator-profile" ? [profile] : [];
        return new Response(JSON.stringify({ assets }), { status: 200, headers: { "Content-Type": "application/json" } });
      }
      if (url.pathname === "/api/payload-generations") return new Response(JSON.stringify({ generations: [], standaloneRevisions: [], standaloneOutcomes: [], nextCursor: null }), { status: 200, headers: { "Content-Type": "application/json" } });
      return new Response(JSON.stringify({}), { status: 200, headers: { "Content-Type": "application/json" } });
    }));
  });
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("loads complete Arsenal libraries separately and selects an exact profile into Generate", async () => {
    renderApp(<PayloadWorkbench value="seed" onUse={() => undefined} />);
    fireEvent.click(screen.getByRole("button", { name: "Open payload workbench" }));
    fireEvent.mouseDown(screen.getByRole("tab", { name: "Arsenal" }), { button: 0, ctrlKey: false });
    const profileResult = await screen.findByRole("button", { name: /Local helper/ });
    fireEvent.click(profileResult);
    fireEvent.click(screen.getByRole("button", { name: "Select exact profile" }));

    expect(screen.getByRole("tab", { name: "Generate" }).getAttribute("data-state")).toBe("active");
    expect((screen.getByRole("combobox", { name: "Generator profile" }) as HTMLSelectElement).value).toBe("profile-r1");
    const calls = vi.mocked(fetch).mock.calls.map(([input]) => String(input));
    expect(calls.some((call) => call.includes("kind=payload-generator-profile&includeArchived=true"))).toBe(true);
    expect(calls.some((call) => call.includes("kind=payload-generator-profile") && !call.includes("includeArchived"))).toBe(true);
  });
});
