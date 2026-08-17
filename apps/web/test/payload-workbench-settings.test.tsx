// @vitest-environment jsdom

import type { ReactElement } from "react";
import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { OperatorDialogProvider } from "../src/components/operator-dialog.js";
import { PayloadWorkbenchSettingsDialog } from "../src/components/payload-workbench-settings.js";

function wrapper(element: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><OperatorDialogProvider>{element}</OperatorDialogProvider></QueryClientProvider>);
}

function response(value: unknown): Response {
  return new Response(JSON.stringify(value), { status: 200, headers: { "Content-Type": "application/json" } });
}

describe("Payload Workbench settings", () => {
  const writes: unknown[] = [];

  beforeEach(() => {
    writes.length = 0;
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://lathe.local");
      if (url.pathname === "/api/payload-workbench/settings" && init?.method === "PUT") {
        const body = JSON.parse(String(init.body));
        writes.push(body);
        return response({ settings: body });
      }
      if (url.pathname === "/api/payload-workbench/settings") return response({ settings: { defaultGeneratorProfileRevisionId: null, defaultInstructionRevisionId: null, candidateCount: 1, diversity: "balanced", contextMode: "minimal", includeProjectBrief: true, includeSessionBrief: true, includeTargetConfig: false, budgetChars: 32_000 } });
      if (url.pathname === "/api/providers") return response({ providers: [] });
      if (url.pathname === "/api/assets") return response({ assets: [] });
      return response({});
    }));
  });

  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("keeps a distinct global control and exposes all reusable-library tabs plus exact defaults", async () => {
    wrapper(<PayloadWorkbenchSettingsDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Payload Workbench settings" }));

    expect(await screen.findByRole("dialog", { name: "Payload Workbench settings" })).not.toBeNull();
    for (const name of ["Profiles", "Instructions", "Techniques", "Pipelines", "Defaults"]) {
      expect(screen.getByRole("tab", { name: new RegExp(name) })).not.toBeNull();
    }

    fireEvent.mouseDown(screen.getByRole("tab", { name: /Defaults/ }), { button: 0, ctrlKey: false });
    const candidateSelect = await screen.findByRole("combobox", { name: "Candidates" });
    fireEvent.change(candidateSelect, { target: { value: "4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save defaults" }));

    await waitFor(() => expect(writes).toHaveLength(1));
    expect(writes[0]).toMatchObject({ candidateCount: 4, diversity: "balanced", contextMode: "minimal", includeTargetConfig: false, budgetChars: 32_000 });
  });

  it("loads and saves editable tags on a new technique revision", async () => {
    const technique = {
      id: "technique-r1", assetId: "technique", kind: "payload-technique", revision: 1,
      name: "Authority framing", description: "Varies authority claims", tags: ["authority", "social"],
      provenance: {}, value: { instructions: "Adopt an authority frame.", conflictsWith: [], before: [], after: [] },
      contentHash: "a".repeat(64), trusted: true, archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z"
    };
    const assetWrites: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://lathe.local");
      if (url.pathname === "/api/payload-workbench/settings") return response({ settings: {} });
      if (url.pathname === "/api/providers") return response({ providers: [] });
      if (url.pathname === "/api/assets") return response({ assets: url.searchParams.get("kind") === "payload-technique" ? [technique] : [] });
      if (url.pathname === "/api/library/assets" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        assetWrites.push(body);
        return response({ asset: { ...technique, ...body, id: "technique-r2", revision: 2 } });
      }
      return response({});
    }));

    wrapper(<PayloadWorkbenchSettingsDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Payload Workbench settings" }));
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /Techniques/ }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Authority framing" }));
    const tags = screen.getByRole("textbox", { name: /^Tags/ }) as HTMLInputElement;
    expect(tags.value).toBe("authority, social");
    fireEvent.change(tags, { target: { value: "authority, jailbreak, authority" } });
    fireEvent.click(screen.getByRole("button", { name: "Save new revision" }));

    await waitFor(() => expect(assetWrites).toHaveLength(1));
    expect(assetWrites[0]).toMatchObject({ kind: "payload-technique", tags: ["authority", "jailbreak"], assetId: "technique", baseRevisionId: "technique-r1" });
  });

  it("edits parameterized pipeline steps through the shared transform schema", async () => {
    const pipeline = {
      id: "pipeline-r1", assetId: "pipeline", kind: "payload-pipeline", revision: 1,
      name: "Rotate once", description: "Configurable Caesar rotation", tags: [], provenance: {},
      value: { steps: [{ transformId: "caesar-rotate", version: 1, enabled: true, parameters: { shift: "3" } }] },
      contentHash: "b".repeat(64), trusted: true, archivedAt: null, createdAt: "2026-08-15T00:00:00.000Z"
    };
    const assetWrites: Array<Record<string, unknown>> = [];
    vi.stubGlobal("fetch", vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "http://lathe.local");
      if (url.pathname === "/api/payload-workbench/settings") return response({ settings: {} });
      if (url.pathname === "/api/providers") return response({ providers: [] });
      if (url.pathname === "/api/assets") return response({ assets: url.searchParams.get("kind") === "payload-pipeline" ? [pipeline] : [] });
      if (url.pathname === "/api/library/assets" && init?.method === "POST") {
        const body = JSON.parse(String(init.body)) as Record<string, unknown>;
        assetWrites.push(body);
        return response({ asset: { ...pipeline, ...body, id: "pipeline-r2", revision: 2 } });
      }
      return response({});
    }));

    wrapper(<PayloadWorkbenchSettingsDialog />);
    fireEvent.click(screen.getByRole("button", { name: "Payload Workbench settings" }));
    fireEvent.mouseDown(await screen.findByRole("tab", { name: /Pipelines/ }), { button: 0, ctrlKey: false });
    fireEvent.click(await screen.findByRole("button", { name: "Edit Rotate once" }));
    const shift = screen.getByRole("spinbutton", { name: /Shift/ }) as HTMLInputElement;
    expect(shift.value).toBe("3");
    fireEvent.change(shift, { target: { value: "-4" } });
    fireEvent.click(screen.getByRole("button", { name: "Save new revision" }));

    await waitFor(() => expect(assetWrites).toHaveLength(1));
    expect(assetWrites[0]).toMatchObject({
      kind: "payload-pipeline",
      assetId: "pipeline",
      baseRevisionId: "pipeline-r1",
      value: { steps: [{ transformId: "caesar-rotate", version: 1, enabled: true, parameters: { shift: "-4" } }] }
    });
  });
});
