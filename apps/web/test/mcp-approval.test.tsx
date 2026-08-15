// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { JsonObject } from "@lathe/domain";
import { api } from "../src/api.js";
import { McpApprovalResolver } from "../src/components/mcp-approval.js";

vi.mock("@uiw/react-codemirror", () => ({
  default: ({ value, onChange }: { value: string; onChange(value: string): void }) => <textarea value={value} onChange={(event) => onChange(event.target.value)} />
}));

vi.mock("../src/api.js", () => ({
  api: vi.fn(),
  jsonBody: (value: unknown) => ({ body: JSON.stringify(value) })
}));

const mockedApi = vi.mocked(api);

function renderResolver(record: JsonObject, onChanged = vi.fn()) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><McpApprovalResolver runId="run-1" record={record} onChanged={onChanged} /></QueryClientProvider>);
  return onChanged;
}

describe("MCP approval resolver", () => {
  beforeEach(() => mockedApi.mockResolvedValue({}));
  afterEach(() => {
    cleanup();
    vi.clearAllMocks();
  });

  it("approves sampling without an operator-authored response", async () => {
    const onChanged = renderResolver({ id: "sample/1", kind: "sampling", status: "pending", request: { payload: { messages: [] } } });

    expect(screen.queryByRole("textbox", { name: /elicitation response/i })).toBeNull();
    expect(screen.getByText(/starts a nested model run/i)).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /run sampling/i }));

    await waitFor(() => expect(mockedApi).toHaveBeenCalledOnce());
    const [path, options] = mockedApi.mock.calls[0]!;
    expect(path).toBe("/api/runs/run-1/mcp-approvals/sample%2F1/resolve");
    expect(JSON.parse(String(options?.body))).toEqual({ resolution: { outcome: "approved" } });
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });

  it("requires and submits explicit JSON for elicitation", async () => {
    const onChanged = renderResolver({ id: "elicit-1", kind: "elicitation", status: "pending", request: { payload: { message: "Choose a color" } } });
    const editor = screen.getByRole("textbox", { name: /explicit elicitation response/i });
    const approve = screen.getByRole("button", { name: /^approve$/i }) as HTMLButtonElement;
    expect(approve.disabled).toBe(true);
    fireEvent.change(editor, { target: { value: "{\"action\":\"accept\",\"content\":{\"answer\":\"blue\"}}" } });
    expect(approve.disabled).toBe(false);
    fireEvent.click(approve);

    await waitFor(() => expect(mockedApi).toHaveBeenCalledWith(
      "/api/runs/run-1/mcp-approvals/elicit-1/resolve",
      {
        method: "POST",
        body: JSON.stringify({ resolution: { outcome: "approved", response: { action: "accept", content: { answer: "blue" } } } })
      }
    ));
    await waitFor(() => expect(onChanged).toHaveBeenCalledOnce());
  });
});
