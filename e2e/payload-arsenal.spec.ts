import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { E2E_PORT, E2E_TOKEN } from "../playwright.config.js";

const appOrigin = `http://127.0.0.1:${E2E_PORT}`;
const apiHeaders = {
  Authorization: `Bearer ${E2E_TOKEN}`,
  Origin: appOrigin
};

type ArsenalAssetKind =
  | "payload-generator-profile"
  | "payload-generator-instruction"
  | "payload-technique"
  | "payload-pipeline";

interface AssetRevision {
  id: string;
  assetId: string;
  revision: number;
  name: string;
}

interface WorkbenchResponse {
  nodes: Array<{ id: string }>;
  branches: Array<{ id: string; headNodeId: string | null }>;
  runs: Array<{ id: string }>;
}

async function body<T>(response: APIResponse, expectedStatus: number): Promise<T> {
  expect(response.status(), await response.text()).toBe(expectedStatus);
  return response.json() as Promise<T>;
}

async function createAsset(
  request: APIRequestContext,
  input: {
    kind: ArsenalAssetKind;
    name: string;
    description: string;
    value: Record<string, unknown>;
    trusted: boolean;
    assetId?: string;
    baseRevisionId?: string;
  }
): Promise<AssetRevision> {
  return (await body<{ asset: AssetRevision }>(await request.post("/api/library/assets", {
    headers: apiHeaders,
    data: {
      ...(input.assetId ? { assetId: input.assetId } : {}),
      ...(input.baseRevisionId ? { baseRevisionId: input.baseRevisionId } : {}),
      kind: input.kind,
      name: input.name,
      description: input.description,
      tags: ["playwright", "arsenal"],
      provenance: { operatorAuthored: true, fixture: "payload-arsenal" },
      value: input.value,
      trusted: input.trusted
    }
  }), 201)).asset;
}

test("searches exact Arsenal revisions and hands them off without running anything", async ({ page, request }) => {
  const suffix = `${Date.now()}-${test.info().retry}`;
  const profileName = `Arsenal profile ${suffix}`;
  const instructionName = `Arsenal instruction ${suffix}`;
  const untrustedTechniqueName = `Untrusted technique ${suffix}`;
  const archivedPipelineName = `Archived pipeline ${suffix}`;

  const profile = await createAsset(request, {
    kind: "payload-generator-profile",
    name: profileName,
    description: "Inspectable helper profile that is never started",
    value: {
      backend: {
        kind: "codex-app-server",
        executablePath: "/usr/bin/false",
        expectedVersion: null,
        modelId: "fixture-codex-model",
        effort: "low",
        timeoutMs: 1_000,
        workspaceAccess: "isolated"
      }
    },
    trusted: true
  });
  const instructionOne = await createAsset(request, {
    kind: "payload-generator-instruction",
    name: instructionName,
    description: "Historical instruction revision",
    value: { template: "Return candidate revision one." },
    trusted: true
  });
  const instructionTwo = await createAsset(request, {
    kind: "payload-generator-instruction",
    name: instructionName,
    description: "Current instruction revision",
    value: { template: "Return candidate revision two." },
    trusted: true,
    assetId: instructionOne.assetId,
    baseRevisionId: instructionOne.id
  });
  expect(instructionTwo.revision).toBe(2);

  const untrustedTechnique = await createAsset(request, {
    kind: "payload-technique",
    name: untrustedTechniqueName,
    description: "Visible evidence that cannot be selected",
    value: { instructions: "Inspect only.", conflictsWith: [], before: [], after: [] },
    trusted: false
  });
  const archivedPipeline = await createAsset(request, {
    kind: "payload-pipeline",
    name: archivedPipelineName,
    description: "Archived deterministic pipeline",
    value: { steps: [{ transformId: "uppercase", version: 1, enabled: true }] },
    trusted: true
  });
  await body<{ deleted: true }>(await request.delete(`/api/library/assets/${archivedPipeline.id}`, {
    headers: apiHeaders
  }), 200);

  const project = (await body<{ project: { id: string } }>(await request.post("/api/projects", {
    headers: apiHeaders,
    data: { name: `Arsenal project ${suffix}`, description: "Deterministic Arsenal acceptance fixture" }
  }), 201)).project;
  const created = await body<{
    session: { id: string };
    branch: { id: string; headNodeId: string | null };
  }>(await request.post("/api/sessions", {
    headers: apiHeaders,
    data: { projectId: project.id, name: `Arsenal session ${suffix}`, description: "No model is configured." }
  }), 201);

  await page.goto(`/projects/${project.id}/sessions/${created.session.id}?token=${encodeURIComponent(E2E_TOKEN)}`);
  await expect(page).not.toHaveURL(/token=/);
  await page.getByRole("button", { name: "Open payload workbench" }).click();
  const workbench = page.getByRole("dialog", { name: "Payload workbench" });
  await expect(workbench).toBeVisible();
  await workbench.getByRole("tab", { name: "Arsenal" }).click();
  await expect(workbench.getByText("Searchable arsenal")).toBeVisible();

  const results = workbench.getByRole("region", { name: "Arsenal results" });
  const inspector = workbench.getByLabel("Arsenal entry details");

  await workbench.getByLabel("Kind").selectOption("profile");
  await workbench.getByLabel("Search").fill(profileName);
  await results.getByRole("button", { name: new RegExp(profileName) }).click();
  await expect(inspector.getByText(profile.id, { exact: true })).toBeVisible();
  await expect(inspector).toContainText("fixture-codex-model");
  await inspector.getByRole("button", { name: "Select exact profile" }).click();
  await expect(workbench.getByRole("tab", { name: "Generate" })).toHaveAttribute("data-state", "active");
  await expect(workbench.getByLabel("Generator profile")).toHaveValue(profile.id);

  await workbench.getByRole("tab", { name: "Arsenal" }).click();
  await workbench.getByLabel("Kind").selectOption("instruction");
  await workbench.getByLabel("Search").fill(instructionName);
  await workbench.getByLabel("Revisions").selectOption("all");
  await expect(results.getByRole("button")).toHaveCount(2);
  await workbench.getByLabel("Revisions").selectOption("historical");
  await expect(results.getByRole("button")).toHaveCount(1);
  await expect(results.getByRole("button")).toContainText("r1");
  await workbench.getByLabel("Revisions").selectOption("current");
  await expect(results.getByRole("button")).toHaveCount(1);
  await workbench.getByLabel("Revisions").selectOption("all");
  const currentInstruction = results.getByRole("button").filter({ hasText: "r2" });
  await expect(currentInstruction).toContainText("current");
  await currentInstruction.click();
  await expect(inspector.getByText(instructionTwo.id, { exact: true })).toBeVisible();
  await expect(inspector).toContainText("trusted");
  await inspector.getByRole("button", { name: "Select exact instruction" }).click();
  await expect(workbench.getByRole("tab", { name: "Generate" })).toHaveAttribute("data-state", "active");
  await expect(workbench.getByLabel("Reusable instruction")).toHaveValue(instructionTwo.id);

  await workbench.getByRole("tab", { name: "Arsenal" }).click();
  await workbench.getByLabel("Kind").selectOption("transform");
  await workbench.getByLabel("Search").fill("Caesar rotation");
  const caesar = results.getByRole("button", { name: /Caesar rotation/ });
  await expect(caesar).toContainText("built-in");
  await caesar.click();
  await expect(inspector).toContainText("caesar-rotate@1");
  await inspector.getByRole("button", { name: "Select transform" }).click();
  await expect(workbench.getByRole("tab", { name: "Transform" })).toHaveAttribute("data-state", "active");
  await expect(workbench.getByLabel("Selected transform")).toContainText("Caesar rotation");
  await expect(workbench.getByLabel("Next prompt")).toHaveValue("");

  await workbench.getByRole("tab", { name: "Arsenal" }).click();
  await workbench.getByLabel("Kind").selectOption("technique");
  await workbench.getByLabel("State").selectOption("active");
  await workbench.getByLabel("Trust").selectOption("untrusted");
  await workbench.getByLabel("Search").fill(untrustedTechniqueName);
  await results.getByRole("button", { name: new RegExp(untrustedTechniqueName) }).click();
  await expect(inspector.getByText(untrustedTechnique.id, { exact: true })).toBeVisible();
  await expect(inspector.getByRole("button", { name: "Add exact technique" })).toBeDisabled();

  await workbench.getByLabel("Kind").selectOption("pipeline");
  await workbench.getByLabel("State").selectOption("archived");
  await workbench.getByLabel("Trust").selectOption("trusted");
  await workbench.getByLabel("Search").fill(archivedPipelineName);
  await results.getByRole("button", { name: new RegExp(archivedPipelineName) }).click();
  await expect(inspector.getByText(archivedPipeline.id, { exact: true })).toBeVisible();
  await expect(inspector).toContainText("archived");
  await expect(inspector.getByRole("button", { name: "Select exact pipeline" })).toBeDisabled();

  const unchanged = await body<WorkbenchResponse>(await request.get(`/api/sessions/${created.session.id}`, {
    headers: apiHeaders
  }), 200);
  expect(unchanged.nodes).toEqual([]);
  expect(unchanged.runs).toEqual([]);
  expect(unchanged.branches).toEqual([expect.objectContaining({
    id: created.branch.id,
    headNodeId: null
  })]);
  const helperHistory = await body<{ generations: unknown[] }>(await request.get(`/api/payload-generations?sessionId=${created.session.id}`, {
    headers: apiHeaders
  }), 200);
  expect(helperHistory.generations).toEqual([]);
});
