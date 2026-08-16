// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { UiSettingsDialog } from "../src/components/ui-settings-dialog.js";
import { OperatorDialogProvider } from "../src/components/operator-dialog.js";
import { UI_PREFERENCES_STORAGE_KEY } from "../src/ui-preferences.js";

function memoryStorage(): Storage {
  const values = new Map<string, string>();
  return {
    get length() { return values.size; },
    clear: () => values.clear(),
    getItem: (key) => values.get(key) ?? null,
    key: (index) => [...values.keys()][index] ?? null,
    removeItem: (key) => values.delete(key),
    setItem: (key, value) => values.set(key, value)
  };
}

function renderSettings() {
  const queryClient = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } }
  });
  return render(<QueryClientProvider client={queryClient}><OperatorDialogProvider><UiSettingsDialog /></OperatorDialogProvider></QueryClientProvider>);
}

function settingsResponse(redactionEnabled: boolean): Response {
  return new Response(JSON.stringify({ settings: { redactionEnabled, updatedAt: "2026-08-16T00:00:00.000Z" } }), {
    status: 200,
    headers: { "content-type": "application/json" }
  });
}

describe("interface settings dialog", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage() });
    vi.stubGlobal("fetch", vi.fn(async () => settingsResponse(true)));
  });

  afterEach(() => {
    cleanup();
    vi.unstubAllGlobals();
    document.documentElement.style.removeProperty("--ui-root-font-size");
    delete document.documentElement.dataset.uiFontScale;
  });

  it("opens from its own cog and applies presets immediately", async () => {
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Interface settings" }));
    expect(screen.getByRole("dialog", { name: "Interface settings" })).not.toBeNull();

    const slider = screen.getByRole("slider", { name: "Interface text size" }) as HTMLInputElement;
    expect(slider.value).toBe("100");
    fireEvent.click(screen.getByRole("button", { name: /Extra large/ }));

    expect(slider.value).toBe("130");
    expect(document.documentElement.style.getPropertyValue("--ui-root-font-size")).toBe("20.8px");
    expect(JSON.parse(window.localStorage.getItem(UI_PREFERENCES_STORAGE_KEY) ?? "{}")).toEqual({ fontScalePercent: 130 });

    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    await waitFor(() => expect(screen.queryByRole("dialog", { name: "Interface settings" })).toBeNull());
  });

  it("restores a saved size and offers an explicit reset", () => {
    window.localStorage.setItem(UI_PREFERENCES_STORAGE_KEY, JSON.stringify({ fontScalePercent: 115 }));
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Interface settings" }));
    const slider = screen.getByRole("slider", { name: "Interface text size" }) as HTMLInputElement;
    expect(slider.value).toBe("115");

    fireEvent.click(screen.getByRole("button", { name: "Reset text size" }));
    expect(slider.value).toBe("100");
    expect(document.documentElement.style.getPropertyValue("--ui-root-font-size")).toBe("16px");
  });

  it("requires danger confirmation before disabling, shows RAW state, and re-enables directly", async () => {
    let enabled = true;
    const fetchMock = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PATCH") {
        enabled = (JSON.parse(String(init?.body)) as { redactionEnabled: boolean }).redactionEnabled;
      }
      return settingsResponse(enabled);
    });
    vi.stubGlobal("fetch", fetchMock);
    renderSettings();

    const settingsButton = screen.getByRole("button", { name: "Interface settings" });
    fireEvent.click(settingsButton);
    const redactionSwitch = await screen.findByRole("switch", { name: "Evidence redaction" }) as HTMLInputElement;
    expect(redactionSwitch.checked).toBe(true);

    fireEvent.click(redactionSwitch);
    expect(screen.getByRole("dialog", { name: "Disable evidence redaction?" })).not.toBeNull();
    expect(screen.getByText(/Exact credentials managed by Lathe and ordinary credential APIs remain protected/)).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(redactionSwitch.checked).toBe(true);
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(0);

    fireEvent.click(redactionSwitch);
    fireEvent.click(screen.getByRole("button", { name: "Disable redaction" }));
    await waitFor(() => expect(redactionSwitch.checked).toBe(false));
    expect(screen.getByText("RAW")).not.toBeNull();
    expect(screen.getByText("Raw evidence capture is active.")).not.toBeNull();
    expect(settingsButton.getAttribute("aria-label")).toBe("Interface settings — evidence redaction off");

    fireEvent.click(redactionSwitch);
    await waitFor(() => expect(redactionSwitch.checked).toBe(true));
    expect(screen.queryByRole("dialog", { name: "Disable evidence redaction?" })).toBeNull();
    expect(screen.queryByText("RAW")).toBeNull();
    expect(fetchMock.mock.calls.filter(([, init]) => init?.method === "PATCH")).toHaveLength(2);
  });

  it("keeps the prior state and surfaces update failures", async () => {
    vi.stubGlobal("fetch", vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      if ((init?.method ?? "GET") === "PATCH") {
        return new Response(JSON.stringify({ error: { message: "Could not persist setting" } }), {
          status: 500,
          headers: { "content-type": "application/json" }
        });
      }
      return settingsResponse(true);
    }));
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Interface settings" }));
    const redactionSwitch = await screen.findByRole("switch", { name: "Evidence redaction" }) as HTMLInputElement;
    fireEvent.click(redactionSwitch);
    fireEvent.click(screen.getByRole("button", { name: "Disable redaction" }));

    expect((await screen.findByRole("alert")).textContent).toContain("Evidence redaction could not be updated: Could not persist setting");
    expect(redactionSwitch.checked).toBe(true);
    expect(screen.queryByText("RAW")).toBeNull();
  });

  it("offers retry when installation settings fail to load", async () => {
    let attempts = 0;
    vi.stubGlobal("fetch", vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        return new Response(JSON.stringify({ error: { message: "Settings unavailable" } }), {
          status: 503,
          headers: { "content-type": "application/json" }
        });
      }
      return settingsResponse(true);
    }));
    renderSettings();

    fireEvent.click(screen.getByRole("button", { name: "Interface settings" }));
    expect((await screen.findByRole("alert")).textContent).toContain("Evidence-redaction settings could not be loaded: Settings unavailable");
    fireEvent.click(screen.getByRole("button", { name: "Retry" }));
    expect((await screen.findByRole("switch", { name: "Evidence redaction" }) as HTMLInputElement).checked).toBe(true);
  });
});
