// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, describe, expect, it, vi } from "vitest";
import { downloadApiFile } from "../src/api.js";
import { BranchExportAction, branchExportFileName } from "../src/components/branch-export-action.js";

vi.mock("../src/api.js", () => ({
  downloadApiFile: vi.fn()
}));

const mockedDownload = vi.mocked(downloadApiFile);

function renderAction(branch = { id: "branch/id", sessionId: "session/id", name: "red path" }) {
  const queryClient = new QueryClient({ defaultOptions: { mutations: { retry: false } } });
  render(<QueryClientProvider client={queryClient}><BranchExportAction branch={branch} /></QueryClientProvider>);
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});

describe("branch export action", () => {
  it("downloads the active branch from the authenticated API route", async () => {
    mockedDownload.mockResolvedValue();
    renderAction();

    fireEvent.click(screen.getByRole("button", { name: "Export red path branch as LLM API JSON" }));

    await waitFor(() => expect(mockedDownload).toHaveBeenCalledWith(
      "/api/sessions/session%2Fid/branches/branch%2Fid/export",
      "red-path.json"
    ));
  });

  it("announces download failures to the operator", async () => {
    mockedDownload.mockRejectedValue(new Error("Branch export is unavailable"));
    renderAction();

    fireEvent.click(screen.getByRole("button", { name: "Export red path branch as LLM API JSON" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Branch export is unavailable");
  });
});

describe("branch export fallback filename", () => {
  it("keeps Unicode names while removing path and filesystem separators", () => {
    expect(branchExportFileName("  ../目标 / red:path  ")).toBe("目标-red-path.json");
    expect(branchExportFileName("...///")).toBe("branch.json");
  });
});
