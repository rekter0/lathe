// @vitest-environment jsdom

import { act, cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { clipboardImageFiles, Composer } from "../src/views/workbench.js";
import { OperatorDialogProvider } from "../src/components/operator-dialog.js";
import type { Attachment, BranchRef, WorkbenchData } from "../src/types.js";

const timestamp = "2026-08-16T12:00:00.000Z";
const branch: BranchRef = { id: "branch-1", sessionId: "session-1", name: "main", headNodeId: null, createdAt: timestamp, updatedAt: timestamp };

function workbenchData(attachments: Attachment[] = []): WorkbenchData {
  return {
    session: {
      id: "session-1",
      projectId: "project-1",
      name: "Attachment test",
      description: "",
      providerProfileId: "provider-1",
      modelId: "fixture-model",
      activeBranchId: branch.id,
      draftConfig: { promptBlocks: [], tools: [], toolApprovalMode: "manual", provider: null, temperature: null, maxOutputTokens: null, protocolOverrides: {}, compileWarnings: [] },
      autoContinueTools: false,
      autoContinueLimit: 8,
      createdAt: timestamp,
      updatedAt: timestamp
    },
    nodes: [],
    branches: [branch],
    checkpoints: [],
    runs: [],
    attachments
  };
}

function renderComposer(element: ReactElement) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  return render(<QueryClientProvider client={queryClient}><OperatorDialogProvider>{element}</OperatorDialogProvider></QueryClientProvider>);
}

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });
}

function attachment(fileName = "shot.png"): Attachment {
  return { id: `attachment-${fileName}`, projectId: "project-1", fileName, mediaType: "image/png", size: 3, sha256: "a".repeat(64), createdAt: timestamp };
}

describe("clipboard image attachments", () => {
  it("extracts image files, ignores text, and gives generic clipboard images deterministic names", () => {
    const image = new File(["png"], "clipboard.png", { type: "image/png", lastModified: 42 });
    const named = new File(["jpg"], "evidence.jpg", { type: "image/jpeg" });
    const files = clipboardImageFiles({
      items: [
        { kind: "string", getAsFile: () => null },
        { kind: "file", getAsFile: () => image },
        { kind: "file", getAsFile: () => named }
      ]
    }, new Date("2026-08-16T12:12:15.902Z"));

    expect(files.map((file) => file.name)).toEqual(["pasted-image-20260816T121215902Z.png", "evidence.jpg"]);
    expect(files.map((file) => file.type)).toEqual(["image/png", "image/jpeg"]);
    expect(clipboardImageFiles({ items: [{ kind: "string", getAsFile: () => null }] })).toEqual([]);
  });

  it("falls back to clipboard files when item access is unavailable and ignores non-images", () => {
    const image = new File(["png"], "capture.png", { type: "image/png" });
    const text = new File(["notes"], "notes.txt", { type: "text/plain" });

    expect(clipboardImageFiles({ items: [], files: [image, text] })).toEqual([image]);
  });
});

describe("Composer attachments", () => {
  beforeEach(() => vi.stubGlobal("fetch", vi.fn()));
  afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

  it("keeps an upload pending, then sends an attachment-only prompt without waiting for a refetch", async () => {
    let finishUpload!: (response: Response) => void;
    const uploadResponse = new Promise<Response>((resolve) => { finishUpload = resolve; });
    const fetchMock = vi.mocked(fetch);
    fetchMock.mockImplementation(async (input, init) => {
      const path = String(input);
      if (path.endsWith("/attachments")) return uploadResponse;
      if (path.endsWith("/messages")) return jsonResponse({ node: { id: "attachment-node" } }, 201);
      if (path === "/api/runs") return jsonResponse({ run: { id: "run-1" } }, 202);
      throw new Error(`Unexpected request: ${path} ${init?.method ?? "GET"}`);
    });
    const onRunStarted = vi.fn();
    renderComposer(<Composer data={workbenchData()} branch={branch} onRunStarted={onRunStarted} onChanged={() => undefined} />);

    const input = screen.getByLabelText("Attach files") as HTMLInputElement;
    const file = new File(["png"], "shot.png", { type: "image/png" });
    fireEvent.change(input, { target: { files: [file] } });

    expect(input.value).toBe("");
    expect(screen.getByText("Uploading attachment… Run will be available when it finishes.")).not.toBeNull();
    expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(true);

    await act(async () => finishUpload(jsonResponse({ attachment: attachment() }, 201)));
    await waitFor(() => expect(screen.getByRole("button", { name: "Remove shot.png from prompt" })).not.toBeNull());
    expect(screen.getByRole("button", { name: "Run" }).hasAttribute("disabled")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Run" }));
    await waitFor(() => expect(onRunStarted).toHaveBeenCalledWith("run-1"));
    const messageCall = fetchMock.mock.calls.find(([path]) => String(path).endsWith("/messages"));
    const body = JSON.parse(String(messageCall?.[1]?.body)) as { parts: Array<{ type: string; attachmentId?: string }> };
    expect(body.parts).toEqual([{ type: "attachment", attachmentId: "attachment-shot.png", name: "shot.png", mediaType: "image/png" }]);
    expect(screen.queryByRole("button", { name: "Remove shot.png from prompt" })).toBeNull();
  });

  it("uploads a pasted screenshot through the same queue while leaving ordinary text paste alone", async () => {
    const uploadedNames: string[] = [];
    vi.mocked(fetch).mockImplementation(async (input, init) => {
      const path = String(input);
      if (!path.endsWith("/attachments")) throw new Error(`Unexpected request: ${path}`);
      const file = (init?.body as FormData).get("file") as File;
      uploadedNames.push(file.name);
      return jsonResponse({ attachment: attachment(file.name) }, 201);
    });
    renderComposer(<Composer data={workbenchData()} branch={branch} onRunStarted={() => undefined} onChanged={() => undefined} />);
    const textarea = screen.getByRole("textbox", { name: "Next operator payload" });
    const screenshot = new File(["png"], "image.png", { type: "image/png" });

    fireEvent.paste(textarea, { clipboardData: { items: [{ kind: "file", getAsFile: () => screenshot }], files: [screenshot] } });
    await waitFor(() => expect(uploadedNames).toHaveLength(1));
    expect(uploadedNames[0]).toMatch(/^pasted-image-\d{8}T\d{9}Z\.png$/);
    await waitFor(() => expect(screen.getByRole("button", { name: new RegExp(`Remove ${uploadedNames[0]} from prompt`) })).not.toBeNull());

    fireEvent.paste(textarea, { clipboardData: { items: [{ kind: "string", getAsFile: () => null }], files: [] } });
    expect(uploadedNames).toHaveLength(1);
  });

  it("shows failed uploads with retry and removal instead of leaving an unexplained chip", async () => {
    const fetchMock = vi.mocked(fetch);
    fetchMock
      .mockResolvedValueOnce(jsonResponse({ error: { message: "Attachment exceeds the limit" } }, 413))
      .mockResolvedValueOnce(jsonResponse({ attachment: attachment("large.png") }, 201));
    renderComposer(<Composer data={workbenchData()} branch={branch} onRunStarted={() => undefined} onChanged={() => undefined} />);
    const file = new File(["png"], "large.png", { type: "image/png" });

    fireEvent.change(screen.getByLabelText("Attach files"), { target: { files: [file] } });
    await waitFor(() => expect(screen.getByRole("button", { name: "Retry" })).not.toBeNull());
    expect(screen.getByRole("alert").textContent).toContain("large.png: Attachment exceeds the limit");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("button", { name: "Retry" })).toBeNull());
    expect(screen.getByRole("button", { name: "Remove large.png from prompt" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove large.png from prompt" }));
    expect(screen.queryByText("large.png")).toBeNull();
  });

  it("keeps stored project files in a reuse selector instead of presenting them as attached forever", () => {
    const stored = attachment("stored.png");
    renderComposer(<Composer data={workbenchData([stored])} branch={branch} onRunStarted={() => undefined} onChanged={() => undefined} />);

    expect(screen.queryByRole("button", { name: "Remove stored.png from prompt" })).toBeNull();
    fireEvent.change(screen.getByRole("combobox", { name: "Reuse stored attachment" }), { target: { value: stored.id } });
    expect(screen.getByRole("button", { name: "Remove stored.png from prompt" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Remove stored.png from prompt" }));
    expect(screen.queryByRole("button", { name: "Remove stored.png from prompt" })).toBeNull();
  });
});
