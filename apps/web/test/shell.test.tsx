// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ProjectRailLayout } from "../src/shell.js";
import type { Project } from "../src/types.js";

const project: Project = {
  id: "project-1",
  name: "Adversarial research",
  description: "",
  defaultHarnessRevisionId: null,
  workspaceRoot: null,
  createdAt: "2026-08-15T00:00:00.000Z",
  updatedAt: "2026-08-15T00:00:00.000Z"
};

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

describe("project sidebar", () => {
  beforeEach(() => {
    Object.defineProperty(window, "localStorage", { configurable: true, value: memoryStorage() });
  });
  afterEach(cleanup);

  it("collapses into a compact project rail and gives the main stage more space", () => {
    const { container } = render(
      <ProjectRailLayout projects={[project]} version="0.1.0">
        <div>Workbench</div>
      </ProjectRailLayout>
    );

    const layout = container.querySelector(".body-shell");
    expect(layout?.classList.contains("project-rail-collapsed")).toBe(false);

    fireEvent.click(screen.getByRole("button", { name: "Collapse projects sidebar" }));

    expect(layout?.classList.contains("project-rail-collapsed")).toBe(true);
    expect(screen.getByRole("button", { name: "Expand projects sidebar" }).getAttribute("aria-expanded")).toBe("false");
    expect(screen.getByRole("link", { name: project.name }).getAttribute("title")).toBe(project.name);
    expect(window.localStorage.getItem("lathe.project-rail-collapsed")).toBe("true");
  });

  it("restores the operator's saved preference and can expand again", () => {
    window.localStorage.setItem("lathe.project-rail-collapsed", "true");
    const { container } = render(
      <ProjectRailLayout projects={[project]}>
        <div>Workbench</div>
      </ProjectRailLayout>
    );

    expect(container.querySelector(".body-shell")?.classList.contains("project-rail-collapsed")).toBe(true);

    fireEvent.click(screen.getByRole("button", { name: "Expand projects sidebar" }));

    expect(container.querySelector(".body-shell")?.classList.contains("project-rail-collapsed")).toBe(false);
    expect(screen.getByRole("button", { name: "Collapse projects sidebar" }).getAttribute("aria-expanded")).toBe("true");
    expect(window.localStorage.getItem("lathe.project-rail-collapsed")).toBe("false");
  });
});
