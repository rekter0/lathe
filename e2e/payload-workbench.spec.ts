import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { E2E_PORT, E2E_PROVIDER_PORT, E2E_TOKEN } from "../playwright.config.js";

const appOrigin = `http://127.0.0.1:${E2E_PORT}`;
const providerOrigin = `http://127.0.0.1:${E2E_PROVIDER_PORT}`;
const apiHeaders = {
  Authorization: `Bearer ${E2E_TOKEN}`,
  Origin: appOrigin,
};

interface AssetRevision {
  id: string;
  name: string;
  revision: number;
}

interface WorkbenchResponse {
  nodes: Array<{ id: string }>;
  branches: Array<{ id: string; headNodeId: string | null }>;
}

async function body<T>(response: APIResponse, expectedStatus: number): Promise<T> {
  expect(response.status(), await response.text()).toBe(expectedStatus);
  return response.json() as Promise<T>;
}

async function createAsset(
  request: APIRequestContext,
  input: { kind: string; name: string; description: string; value: Record<string, unknown> },
): Promise<AssetRevision> {
  return (await body<{ asset: AssetRevision }>(await request.post("/api/library/assets", {
    headers: apiHeaders,
    data: {
      ...input,
      tags: ["playwright"],
      provenance: { operatorAuthored: true, fixture: "payload-workbench" },
      trusted: true,
    },
  }), 201)).asset;
}

test("generates, refines, compares, transforms, restores, and explicitly uses a payload", async ({ page, request }) => {
  test.setTimeout(60_000);

  const suffix = `${Date.now()}-${test.info().retry}`;
  const projectName = `Payload project ${suffix}`;
  const targetName = `Target assistant ${suffix}`;
  const projectBrief = `Assess instruction boundaries for ${suffix}.`;
  const sessionName = `Payload session ${suffix}`;
  const sessionBrief = `Develop a concise authorized test payload for ${suffix}.`;
  const providerName = `Payload provider ${suffix}`;
  const profileName = `HTTP generator ${suffix}`;
  const instructionName = `Concise generator ${suffix}`;
  const techniqueName = `Authority framing ${suffix}`;
  const pipelineName = `Uppercase pipeline ${suffix}`;

  const provider = (await body<{ provider: { id: string } }>(await request.post("/api/providers", {
    headers: apiHeaders,
    data: {
      label: providerName,
      protocol: "openai-chat",
      baseUrl: providerOrigin,
      credential: `payload-secret-${suffix}`,
      models: [{
        id: "fixture-model",
        label: "Fixture model",
        discovered: false,
        capabilities: {
          streaming: true,
          tools: true,
          images: false,
          files: false,
          jsonMode: false,
          maxContextTokens: 32_000,
        },
      }],
    },
  }), 201)).provider;

  const profile = await createAsset(request, {
    kind: "payload-generator-profile",
    name: profileName,
    description: "Deterministic Playwright HTTP helper",
    value: {
      backend: {
        kind: "http-provider",
        providerProfileRevisionId: provider.id,
        modelId: "fixture-model",
        maxOutputTokens: 512,
        reasoning: true,
        temperatures: { low: 0.2, balanced: 0.7, high: 1 },
      },
    },
  });
  const instruction = await createAsset(request, {
    kind: "payload-generator-instruction",
    name: instructionName,
    description: "Keep candidates concise and inspectable",
    value: { template: "Return only an authorized candidate for {{target_name}} and objective {{objective}}." },
  });
  const technique = await createAsset(request, {
    kind: "payload-technique",
    name: techniqueName,
    description: "Exercise a reusable ordered technique",
    value: { instructions: "Use a concise authority-framing variation.", conflictsWith: [], before: [], after: [] },
  });
  const pipeline = await createAsset(request, {
    kind: "payload-pipeline",
    name: pipelineName,
    description: "One deterministic persisted transform",
    value: { steps: [{ transformId: "uppercase", version: 1, enabled: true }] },
  });

  await page.goto(`/?token=${encodeURIComponent(E2E_TOKEN)}`);
  await expect(page).not.toHaveURL(/token=/);

  const settingsButton = page.getByRole("button", { name: "Payload Workbench settings" });
  await expect(settingsButton).toBeVisible();
  await settingsButton.click();
  const settingsDialog = page.getByRole("dialog", { name: "Payload Workbench settings" });
  await expect(settingsDialog).toBeVisible();
  await expect(settingsDialog.getByRole("tab", { name: "Profiles" })).toBeVisible();
  await expect(settingsDialog.getByText(profileName)).toBeVisible();
  await settingsDialog.getByRole("button", { name: "Close Payload Workbench settings" }).click();

  await page.getByRole("button", { name: "New project" }).click();
  const projectDialog = page.getByRole("dialog", { name: "Create a project" });
  await projectDialog.getByLabel("Name", { exact: true }).fill(projectName);
  await projectDialog.getByRole("textbox", { name: /^Target name/ }).fill(targetName);
  await projectDialog.getByLabel("Description", { exact: true }).fill(projectBrief);
  await projectDialog.getByRole("button", { name: "Create project" }).click();

  await expect(page).toHaveURL(/\?project=/);
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();
  await page.getByLabel("Session name").fill(sessionName);
  await page.getByLabel("Session briefing").fill(sessionBrief);
  await page.getByLabel("Provider / model").selectOption({ label: `${providerName} · Fixture model` });
  await page.getByRole("button", { name: "Open workbench" }).click();

  await expect(page).toHaveURL(/\/projects\/[^/]+\/sessions\/[^/]+/);
  const sessionId = new URL(page.url()).pathname.split("/").at(-1)!;
  await expect(page.getByRole("heading", { name: sessionName })).toBeVisible();
  await page.getByRole("button", { name: "Open payload workbench" }).click();

  const workbenchDialog = page.getByRole("dialog", { name: "Payload workbench" });
  await expect(workbenchDialog).toBeVisible();
  await workbenchDialog.getByRole("tab", { name: "Generate" }).click();
  await workbenchDialog.getByLabel("Generator profile").selectOption(profile.id);
  await workbenchDialog.getByLabel("Reusable instruction").selectOption(instruction.id);
  const operatorInstruction = `Generate a safe test variation for ${suffix}.`;
  await workbenchDialog.getByLabel("Operator instruction").fill(operatorInstruction);
  await workbenchDialog.getByLabel("Add technique").selectOption(technique.id);
  await workbenchDialog.getByLabel("Candidates").selectOption("2");
  await workbenchDialog.getByLabel("Diversity").selectOption("high");
  await workbenchDialog.getByLabel("Conversation").selectOption("minimal");
  await workbenchDialog.getByRole("button", { name: "Add variable" }).click();
  await workbenchDialog.getByLabel("Variable 1 name").fill("format_hint");
  await workbenchDialog.getByLabel("Variable format_hint value").fill("terse");

  await workbenchDialog.getByRole("button", { name: "Close payload workbench" }).click();
  await expect(workbenchDialog).toBeHidden();
  await expect.poll(async () => {
    const response = await request.get(`/api/sessions/${sessionId}/payload-workbench/settings`, { headers: apiHeaders });
    return (await body<{ settings: Record<string, unknown> }>(response, 200)).settings;
  }).toMatchObject({
    generatorProfileRevisionId: profile.id,
    instructionRevisionId: instruction.id,
    techniqueRevisionIds: [technique.id],
    operatorInstruction,
    variables: { format_hint: "terse" },
    candidateCount: 2,
    diversity: "high",
    contextMode: "minimal",
  });

  await page.getByRole("button", { name: "Open payload workbench" }).click();
  await expect(workbenchDialog).toBeVisible();
  await workbenchDialog.getByRole("tab", { name: "Generate" }).click();
  await expect(workbenchDialog.getByLabel("Generator profile")).toHaveValue(profile.id);
  await expect(workbenchDialog.getByLabel("Reusable instruction")).toHaveValue(instruction.id);
  await expect(workbenchDialog.getByLabel("Operator instruction")).toHaveValue(operatorInstruction);
  await expect(workbenchDialog.getByLabel("Variable format_hint value")).toHaveValue("terse");
  await expect(workbenchDialog.getByLabel("Candidates")).toHaveValue("2");
  await expect(workbenchDialog.getByLabel("Diversity")).toHaveValue("high");
  await expect(workbenchDialog.getByLabel("Conversation")).toHaveValue("minimal");
  await workbenchDialog.getByRole("button", { name: "Preview" }).click();

  const preview = workbenchDialog.locator(".payload-context-preview");
  await expect(preview).toContainText(projectBrief);
  await expect(preview).toContainText(sessionBrief);
  await expect(preview).toContainText(targetName);

  await workbenchDialog.getByRole("button", { name: "Generate candidates" }).click();
  const candidates = workbenchDialog.locator(".payload-candidate-card");
  await expect(candidates).toHaveCount(2, { timeout: 20_000 });
  await expect(workbenchDialog.locator(".payload-generation-state .status-badge")).toHaveText("completed", { timeout: 20_000 });
  await expect(candidates.nth(0)).toContainText("Fixture **response**");
  await expect(candidates.nth(1)).toContainText("Fixture **response**");
  await expect(candidates.nth(0).locator(".payload-candidate-reasoning")).toContainText("Reasoning");

  await candidates.nth(0).getByLabel("diff").check();
  await candidates.nth(1).getByLabel("diff").check();
  const comparison = workbenchDialog.getByRole("region", { name: "Payload comparison" });
  await expect(comparison).toBeVisible();
  await expect(comparison.getByRole("heading", { name: "Candidate 1" })).toBeVisible();
  await expect(comparison.getByRole("heading", { name: "Candidate 2" })).toBeVisible();
  await comparison.getByRole("button", { name: "Close payload diff" }).click();

  await candidates.nth(0).getByRole("button", { name: "Refine" }).click();
  await candidates.nth(0).getByLabel("Refinement feedback").fill("Keep the intent but make the candidate shorter.");
  await candidates.nth(0).getByRole("button", { name: "Generate refinement" }).click();
  await expect(workbenchDialog.locator(".payload-candidate-text").first()).toContainText("Previous candidate:", { timeout: 20_000 });
  await expect(workbenchDialog.locator(".payload-generation-state .status-badge")).toHaveText("completed", { timeout: 20_000 });

  await workbenchDialog.getByRole("tab", { name: "History" }).click();
  const historyRows = workbenchDialog.locator(".payload-history-list article");
  await expect(historyRows).toHaveCount(2, { timeout: 10_000 });
  await historyRows.nth(1).getByRole("button", { name: "Restore" }).click();
  await expect(workbenchDialog.getByRole("tab", { name: "Generate" })).toHaveAttribute("data-state", "active");
  await expect(workbenchDialog.locator(".payload-candidate-card")).toHaveCount(2);

  await workbenchDialog.locator(".payload-candidate-card").nth(0).getByRole("button", { name: "Send candidate 1 to Transform" }).click();
  await expect(workbenchDialog.getByRole("tab", { name: "Transform" })).toHaveAttribute("data-state", "active");
  const nextPrompt = workbenchDialog.getByLabel("Next prompt");
  const untransformed = await nextPrompt.inputValue();
  expect(untransformed).toContain("Fixture **response**");
  await workbenchDialog.getByLabel("Transform pipeline").selectOption(pipeline.id);
  await workbenchDialog.getByRole("button", { name: "Apply pipeline" }).click();
  await expect(nextPrompt).toHaveValue(untransformed.toUpperCase());
  await expect(workbenchDialog.getByRole("button", { name: "Use as next prompt" })).toBeEnabled();
  await workbenchDialog.getByRole("button", { name: "Use as next prompt" }).click();

  await expect(workbenchDialog).toBeHidden();
  await expect(page.getByPlaceholder("Enter the next operator payload…")).toHaveValue(untransformed.toUpperCase());

  const persistedWorkbench = await body<WorkbenchResponse>(await request.get(`/api/sessions/${sessionId}`, { headers: apiHeaders }), 200);
  expect(persistedWorkbench.nodes).toEqual([]);
  expect(persistedWorkbench.branches).toHaveLength(1);
  expect(persistedWorkbench.branches[0]?.headNodeId).toBeNull();
});
