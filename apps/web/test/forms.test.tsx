// @vitest-environment jsdom

import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { Button, EmptyState, Field, Input, Select, Textarea } from "../src/components/forms.js";

describe("shared form controls", () => {
  it("keeps accessible labels, hints, and operator input wired together", () => {
    render(
      <Field label="Provider label" hint="Shown in the global library">
        <Input defaultValue="Gateway" />
      </Field>,
    );

    const input = screen.getByRole("textbox", { name: /Provider label/ }) as HTMLInputElement;
    expect(input.value).toBe("Gateway");
    expect(screen.getByText("Shown in the global library")).toBeTruthy();
    fireEvent.change(input, { target: { value: "Lab gateway" } });
    expect(input.value).toBe("Lab gateway");
  });

  it("renders selectable, multiline, action, and empty-state primitives", () => {
    const clicked = vi.fn();
    render(
      <>
        <Select aria-label="Protocol" defaultValue="responses">
          <option value="responses">Responses</option>
        </Select>
        <Textarea aria-label="Prompt" defaultValue="Inspect evidence" />
        <Button variant="danger" onClick={clicked}>Cancel run</Button>
        <EmptyState title="No findings">Preserve a branch to begin.</EmptyState>
      </>,
    );

    fireEvent.click(screen.getByRole("button", { name: "Cancel run" }));
    expect(clicked).toHaveBeenCalledOnce();
    expect((screen.getByLabelText("Protocol") as HTMLSelectElement).value).toBe("responses");
    expect((screen.getByLabelText("Prompt") as HTMLTextAreaElement).value).toBe("Inspect evidence");
    expect(screen.getByRole("heading", { name: "No findings" })).toBeTruthy();
  });
});
