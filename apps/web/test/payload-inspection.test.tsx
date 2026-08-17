// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { getPayloadTransform, normalizePayloadTransformParameters } from "@lathe/payloads";
import { PayloadInspectionPanel } from "../src/components/payload-inspection.js";

describe("PayloadInspectionPanel", () => {
  afterEach(cleanup);

  it("bounds large derived previews without truncating the authoritative value", () => {
    const value = "a".repeat(20_001);
    render(<PayloadInspectionPanel value={value} selectedTransform={getPayloadTransform("base64-encode")} application={null} />);

    expect(screen.getByText(/Showing the first 20,000 of 20,001 code points/)).not.toBeNull();
    expect(screen.getAllByText(/20,001 code points/)).toHaveLength(2);
  });

  it("reports a directional inverse mismatch when decoding canonicalizes source text", () => {
    const definition = getPayloadTransform("base64-decode");
    render(<PayloadInspectionPanel
      value="a"
      selectedTransform={definition}
      application={{
        definition,
        parameters: normalizePayloadTransformParameters(definition.id),
        parentText: "YQ",
        outputText: "a"
      }}
    />);

    fireEvent.click(screen.getByRole("tab", { name: "Round-trip" }));
    expect(screen.getByText("mismatch")).not.toBeNull();
    expect(screen.getByText(/did not reproduce the parent text exactly/i)).not.toBeNull();
    expect(screen.getByText("YQ==")).not.toBeNull();
  });

  it("warns when UTF-8 encoding replaces an unpaired surrogate", () => {
    render(<PayloadInspectionPanel value={"\ud800"} selectedTransform={getPayloadTransform("base64-encode")} application={null} />);
    fireEvent.click(screen.getByRole("tab", { name: "UTF-8 bytes" }));
    expect(screen.getByText(/unpaired UTF-16 surrogate/i)).not.toBeNull();
    expect(screen.getByText(/ef bf bd/)).not.toBeNull();
  });

  it("renders sanitized GFM Markdown and supports keyboard tab navigation", () => {
    const value = "| Input | Result |\n| --- | --- |\n| `raw` | **visible** |";
    render(<PayloadInspectionPanel value={value} selectedTransform={getPayloadTransform("base64-encode")} application={null} />);

    const rawTab = screen.getByRole("tab", { name: "Raw" });
    rawTab.focus();
    fireEvent.keyDown(rawTab, { key: "ArrowRight" });

    expect(screen.getByRole("tab", { name: "Rendered Markdown" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("table")).not.toBeNull();
    expect(screen.getByRole("cell", { name: "visible" }).querySelector("strong")).not.toBeNull();
  });
});
