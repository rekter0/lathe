// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { OperatorDialogProvider, useOperatorDialog } from "../src/components/operator-dialog.js";

function DialogHarness({ onPrompt, onConfirm }: { onPrompt(value: string | null): void; onConfirm(value: boolean): void }) {
  const dialogs = useOperatorDialog();
  return <>
    <button onClick={() => void dialogs.prompt({ title: "Name the branch", description: "Choose a reusable branch label.", label: "Branch name", defaultValue: "variation-2", confirmLabel: "Create branch" }).then(onPrompt)}>Prompt</button>
    <button onClick={() => void dialogs.confirm({ title: "Trust handler?", description: "This revision may prepare a command.", confirmLabel: "Trust revision", danger: true }).then(onConfirm)}>Confirm</button>
  </>;
}

describe("operator dialogs", () => {
  afterEach(cleanup);

  it("collects text through an accessible reusable prompt dialog", async () => {
    const onPrompt = vi.fn();
    render(<OperatorDialogProvider><DialogHarness onPrompt={onPrompt} onConfirm={() => undefined} /></OperatorDialogProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Prompt" }));
    const dialog = screen.getByRole("dialog", { name: "Name the branch" });
    const input = screen.getByRole("textbox", { name: "Branch name" }) as HTMLInputElement;
    expect(input.value).toBe("variation-2");
    fireEvent.change(input, { target: { value: "alternate-path" } });
    fireEvent.click(screen.getByRole("button", { name: "Create branch" }));

    await waitFor(() => expect(onPrompt).toHaveBeenCalledWith("alternate-path"));
    expect(dialog.isConnected).toBe(false);
  });

  it("resolves confirmation and cancellation without browser-native dialogs", async () => {
    const onConfirm = vi.fn();
    render(<OperatorDialogProvider><DialogHarness onPrompt={() => undefined} onConfirm={onConfirm} /></OperatorDialogProvider>);

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    expect(screen.getByRole("dialog", { name: "Trust handler?" })).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    await waitFor(() => expect(onConfirm).toHaveBeenLastCalledWith(false));

    fireEvent.click(screen.getByRole("button", { name: "Confirm" }));
    fireEvent.click(screen.getByRole("button", { name: "Trust revision" }));
    await waitFor(() => expect(onConfirm).toHaveBeenLastCalledWith(true));
  });
});
