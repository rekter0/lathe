import { createHash } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";
import { E2E_PORT, E2E_TOKEN } from "../playwright.config.js";

const appOrigin = `http://127.0.0.1:${E2E_PORT}`;
const apiHeaders = {
  Authorization: `Bearer ${E2E_TOKEN}`,
  Origin: appOrigin
};

interface PayloadRevision {
  id: string;
  generationId: string | null;
  attemptId: string | null;
  parentRevisionId: string | null;
  operation: "edited" | "transformed";
  text: string;
  contentHash: string;
  provenance: Record<string, unknown>;
}

interface PayloadRecipeAsset {
  id: string;
  contentHash: string;
  name: string;
  kind: "payload-recipe";
  trusted: boolean;
  value: {
    version: 1;
    finalContentHash: string;
    variables: Array<{ name: string; defaultValue: string | null }>;
    steps: Array<Record<string, unknown>>;
  };
}

interface PayloadHistory {
  generations: unknown[];
  standaloneRevisions: PayloadRevision[];
}

interface SessionWorkbench {
  nodes: Array<{ id: string }>;
  branches: Array<{ id: string; headNodeId: string | null }>;
  runs: Array<{ id: string }>;
}

async function body<T>(response: APIResponse, expectedStatus: number): Promise<T> {
  expect(response.status(), await response.text()).toBe(expectedStatus);
  return response.json() as Promise<T>;
}

function payloadHash(text: string): string {
  return createHash("sha256").update(JSON.stringify(text)).digest("hex");
}

test("saves, inspects, previews, and replays a payload recipe without touching the conversation", async ({ page, request }) => {
  const suffix = `${Date.now()}-${test.info().retry}`;
  const recipeName = `History recipe ${suffix}`;
  const seedText = `Hello {{recipient}} from ${suffix}`;
  const renderedText = `Hello operator-${suffix} from ${suffix}`;
  const finalText = Buffer.from(renderedText, "utf8").toString("base64");

  const project = (await body<{ project: { id: string } }>(await request.post("/api/projects", {
    headers: apiHeaders,
    data: { name: `Recipe project ${suffix}`, description: "Deterministic recipe acceptance fixture" }
  }), 201)).project;
  const created = await body<{
    session: { id: string };
    branch: { id: string; headNodeId: string | null };
  }>(await request.post("/api/sessions", {
    headers: apiHeaders,
    data: { projectId: project.id, name: `Recipe session ${suffix}`, description: "No model is configured." }
  }), 201);

  const seed = (await body<{ revision: PayloadRevision }>(await request.post("/api/payload-revisions", {
    headers: apiHeaders,
    data: { sessionId: created.session.id, text: seedText }
  }), 201)).revision;
  const rendered = (await body<{ revision: PayloadRevision }>(await request.post(`/api/payload-revisions/${seed.id}/derive`, {
    headers: apiHeaders,
    data: {
      kind: "transform",
      transformId: "render-variables",
      version: 1,
      parameters: { recipient: `operator-${suffix}` }
    }
  }), 201)).revision;
  const encoded = (await body<{ revision: PayloadRevision }>(await request.post(`/api/payload-revisions/${rendered.id}/derive`, {
    headers: apiHeaders,
    data: { kind: "transform", transformId: "base64-encode", version: 1, parameters: {} }
  }), 201)).revision;
  expect(encoded.text).toBe(finalText);

  const before = await body<SessionWorkbench>(await request.get(`/api/sessions/${created.session.id}`, {
    headers: apiHeaders
  }), 200);
  expect(before.nodes).toEqual([]);
  expect(before.runs).toEqual([]);
  expect(before.branches).toEqual([expect.objectContaining({ id: created.branch.id, headNodeId: null })]);

  const modelMutations: string[] = [];
  page.on("request", (outgoing) => {
    if (outgoing.method() !== "POST") return;
    const path = new URL(outgoing.url()).pathname;
    if (path === "/api/runs" || path === "/api/payload-generations") modelMutations.push(path);
  });

  await page.goto(`/projects/${project.id}/sessions/${created.session.id}?token=${encodeURIComponent(E2E_TOKEN)}`);
  await expect(page).not.toHaveURL(/token=/);
  const composer = page.getByLabel("Next operator payload");
  await expect(composer).toHaveValue("");
  await page.getByRole("button", { name: "Open payload workbench" }).click();

  const workbench = page.getByRole("dialog", { name: "Payload workbench" });
  await expect(workbench).toBeVisible();
  await workbench.getByRole("tab", { name: "History" }).click();
  const finalHistoryRow = workbench.locator(".payload-standalone-history article").filter({ hasText: finalText });
  await expect(finalHistoryRow).toHaveCount(1);
  await finalHistoryRow.getByRole("button", { name: "Save as recipe" }).click();

  const metadata = page.getByRole("dialog", { name: "Save payload lineage as recipe" });
  await expect(metadata).toBeVisible();
  await metadata.getByLabel("Name", { exact: true }).fill(recipeName);
  await metadata.getByLabel("Description", { exact: true }).fill("Captured History-to-Transform recipe acceptance fixture.");
  await metadata.getByLabel("Tags", { exact: true }).fill("playwright, recipe");
  await metadata.getByRole("button", { name: "Save recipe" }).click();
  await expect(metadata).toBeHidden();

  await expect.poll(async () => {
    const response = await body<{ assets: PayloadRecipeAsset[] }>(await request.get("/api/assets?kind=payload-recipe", {
      headers: apiHeaders
    }), 200);
    return response.assets.find((asset) => asset.name === recipeName) ?? null;
  }).not.toBeNull();
  const recipeAssets = await body<{ assets: PayloadRecipeAsset[] }>(await request.get("/api/assets?kind=payload-recipe", {
    headers: apiHeaders
  }), 200);
  const savedRecipe = recipeAssets.assets.find((asset) => asset.name === recipeName);
  expect(savedRecipe).toBeDefined();
  expect(savedRecipe).toMatchObject({ kind: "payload-recipe", trusted: true });
  expect(savedRecipe?.value).toMatchObject({
    version: 1,
    finalContentHash: payloadHash(finalText),
    variables: [{ name: "recipient", defaultValue: `operator-${suffix}` }]
  });
  expect(savedRecipe?.value.steps).toHaveLength(3);

  await workbench.getByRole("tab", { name: "Arsenal" }).click();
  await workbench.getByLabel("Kind").selectOption("recipe");
  await workbench.getByLabel("Search").fill(recipeName);
  const results = workbench.getByRole("region", { name: "Arsenal results" });
  await results.getByRole("button", { name: new RegExp(recipeName) }).click();

  const inspector = workbench.getByLabel("Arsenal entry details");
  await expect(inspector.getByRole("heading", { name: recipeName })).toBeVisible();
  await expect(inspector).toContainText(savedRecipe!.id);
  await expect(inspector).toContainText("render-variables");
  await expect(inspector).toContainText("base64-encode");
  await expect(inspector).toContainText("3");
  const replay = inspector.getByRole("region", { name: "Recipe replay" });
  await expect(replay.getByLabel("recipient")).toHaveValue(`operator-${suffix}`);
  await replay.getByRole("button", { name: "Preview recipe" }).click();

  const preview = replay.getByRole("region", { name: "Recipe preview result" });
  await expect(preview.getByText("Compatible preflight", { exact: true })).toBeVisible();
  await expect(preview.getByText("Final hash matches captured", { exact: true })).toBeVisible();
  await expect(preview).toContainText(savedRecipe!.contentHash);
  await expect(preview.locator("ol > li")).toHaveCount(3);
  await replay.getByRole("button", { name: "Replay into Transform" }).click();

  await expect(workbench.getByRole("tab", { name: "Transform" })).toHaveAttribute("data-state", "active");
  await expect(workbench.getByLabel("Next prompt")).toHaveValue(finalText);
  await expect(composer).toHaveValue("");

  await expect.poll(async () => {
    const persisted = await body<PayloadHistory>(await request.get(
      `/api/payload-generations?sessionId=${created.session.id}`,
      { headers: apiHeaders }
    ), 200);
    return persisted.standaloneRevisions.filter((revision) => revision.provenance.kind === "recipe-replay").length;
  }).toBe(3);
  const persistedHistory = await body<PayloadHistory>(await request.get(
    `/api/payload-generations?sessionId=${created.session.id}`,
    { headers: apiHeaders }
  ), 200);
  expect(persistedHistory.generations).toEqual([]);
  const replayed = persistedHistory.standaloneRevisions
    .filter((revision) => revision.provenance.kind === "recipe-replay")
    .toSorted((left, right) => Number(left.provenance.stepIndex) - Number(right.provenance.stepIndex));
  expect(replayed).toHaveLength(3);
  expect(replayed.map((revision) => revision.text)).toEqual([seedText, renderedText, finalText]);
  expect(replayed.map((revision) => revision.operation)).toEqual(["edited", "transformed", "transformed"]);
  expect(replayed.map((revision) => revision.parentRevisionId)).toEqual([null, replayed[0]?.id, replayed[1]?.id]);
  expect(replayed.every((revision) => revision.generationId === null && revision.attemptId === null)).toBe(true);
  const replayId = replayed[0]?.provenance.replayId;
  expect(replayId).toEqual(expect.any(String));
  for (const [index, revision] of replayed.entries()) {
    expect(revision.provenance).toMatchObject({
      kind: "recipe-replay",
      recipeRevisionId: savedRecipe!.id,
      recipeContentHash: savedRecipe!.contentHash,
      replayId,
      stepIndex: index,
      stepCount: 3,
      capturedContentHash: revision.contentHash,
      matchesCaptured: true
    });
  }
  expect(replayed[1]?.provenance).toMatchObject({
    stepKind: "transform",
    transformId: "render-variables",
    version: 1,
    parameters: { recipient: `operator-${suffix}` }
  });
  expect(replayed[2]?.provenance).toMatchObject({
    stepKind: "transform",
    transformId: "base64-encode",
    version: 1,
    parameters: {}
  });

  const after = await body<SessionWorkbench>(await request.get(`/api/sessions/${created.session.id}`, {
    headers: apiHeaders
  }), 200);
  expect(after.nodes).toEqual([]);
  expect(after.runs).toEqual([]);
  expect(after.branches).toEqual([expect.objectContaining({ id: created.branch.id, headNodeId: null })]);
  expect(modelMutations).toEqual([]);
});
