import { createHash } from "node:crypto";
import { expect, test, type APIResponse } from "@playwright/test";
import { E2E_PORT, E2E_TOKEN } from "../playwright.config.js";

const appOrigin = `http://127.0.0.1:${E2E_PORT}`;
const apiHeaders = {
  Authorization: `Bearer ${E2E_TOKEN}`,
  Origin: appOrigin
};

interface SessionWorkbench {
  nodes: Array<{ id: string }>;
  branches: Array<{ id: string; headNodeId: string | null }>;
  runs: Array<{ id: string }>;
}

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

interface PayloadHistory {
  generations: unknown[];
  standaloneRevisions: PayloadRevision[];
}

async function body<T>(response: APIResponse, expectedStatus: number): Promise<T> {
  expect(response.status(), await response.text()).toBe(expectedStatus);
  return response.json() as Promise<T>;
}

function payloadHash(text: string): string {
  return createHash("sha256").update(JSON.stringify(text)).digest("hex");
}

test("creates an attributable variant matrix without moving or running the conversation", async ({ page, request }) => {
  const suffix = `${Date.now()}-${test.info().retry}`;
  const controlText = "Abc xyz 123";
  const firstVariantText = "Bcd yza 123";
  const secondVariantText = "Fgh cde 123";

  const project = (await body<{ project: { id: string } }>(await request.post("/api/projects", {
    headers: apiHeaders,
    data: { name: `Variant project ${suffix}`, description: "Deterministic variant acceptance fixture" }
  }), 201)).project;
  const created = await body<{
    session: { id: string };
    branch: { id: string; headNodeId: string | null };
  }>(await request.post("/api/sessions", {
    headers: apiHeaders,
    data: {
      projectId: project.id,
      name: `Variant session ${suffix}`,
      description: "No target or helper model is configured."
    }
  }), 201);

  expect(created.branch.headNodeId).toBeNull();
  const modelMutations: string[] = [];
  page.on("request", (outgoing) => {
    if (outgoing.method() !== "POST") return;
    const path = new URL(outgoing.url()).pathname;
    if (path === "/api/runs" || path === "/api/payload-generations") modelMutations.push(path);
  });

  await page.goto(`/projects/${project.id}/sessions/${created.session.id}?token=${encodeURIComponent(E2E_TOKEN)}`);
  await expect(page).not.toHaveURL(/token=/);
  const composer = page.getByLabel("Next operator payload");
  await composer.fill(controlText);
  await page.getByRole("button", { name: "Open payload workbench" }).click();

  const workbench = page.getByRole("dialog", { name: "Payload workbench" });
  await expect(workbench).toBeVisible();
  const topLevelTabs = workbench.locator(":scope > .payload-workbench-tabs > [role=tablist]").getByRole("tab");
  await expect(topLevelTabs).toHaveCount(5);
  expect((await topLevelTabs.allTextContents()).map((label) => label.trim())).toEqual([
    "Transform",
    "Generate",
    "Variants",
    "Arsenal",
    "History"
  ]);
  await workbench.getByRole("tab", { name: "Variants" }).click();

  const matrix = workbench.getByRole("region", { name: "Payload variant matrix" });
  const control = matrix.getByRole("region", { name: "Variant matrix control source" });
  await expect(control.locator("pre")).toHaveText(controlText);
  await expect(matrix.getByLabel("Registry transform")).toHaveValue("caesar-rotate");

  const factorOne = matrix.getByRole("group", { name: "Factor 1 parameters" });
  const factorTwo = matrix.getByRole("group", { name: "Factor 2 parameters" });
  await factorOne.getByRole("spinbutton", { name: "Shift" }).fill("1");
  await factorTwo.getByRole("spinbutton", { name: "Shift" }).fill("5");
  await matrix.getByRole("button", { name: "Run authoritative preflight" }).click();

  const preflight = matrix.getByRole("region", { name: "Authoritative variant preflight" });
  await expect(preflight.getByText("Ready to create", { exact: true })).toBeVisible();
  await expect(preflight).toContainText("2 rows");
  await expect(preflight).toContainText("33 code points");
  await expect(preflight).toContainText("32 rows · 4,000,000 code points · 16,777,216 B");
  await expect(preflight.locator("ol > li")).toHaveCount(2);
  await expect(preflight.locator("ol > li").nth(0).locator("pre")).toHaveText('{\n  "shift": "1"\n}');
  await expect(preflight.locator("ol > li").nth(1).locator("pre")).toHaveText('{\n  "shift": "5"\n}');

  await matrix.getByRole("button", { name: "Create variants" }).click();
  const results = matrix.getByRole("main", { name: "Variant matrix results" });
  const variantCards = results.getByRole("article", { name: /Variant factor/ });
  await expect(variantCards).toHaveCount(2);
  const firstCard = results.getByRole("article", { name: "Variant factor 1" });
  const secondCard = results.getByRole("article", { name: "Variant factor 2" });
  await expect(firstCard.locator(".payload-variant-text")).toHaveText(firstVariantText);
  await expect(secondCard.locator(".payload-variant-text")).toHaveText(secondVariantText);

  await secondCard.getByText("Exact factor provenance", { exact: true }).click();
  await expect(secondCard).toContainText('"shift": "5"');
  await expect(secondCard).toContainText(payloadHash(secondVariantText));
  await secondCard.getByText("Compare raw control and variant", { exact: true }).click();
  const comparison = secondCard.locator(".payload-text-comparison");
  await expect(comparison.getByRole("heading", { name: "Exact control" })).toBeVisible();
  await expect(comparison.getByRole("heading", { name: "Factor 2" })).toBeVisible();
  await expect(comparison.locator("article").nth(0).locator("pre")).toHaveText(controlText);
  await expect(comparison.locator("article").nth(1).locator("pre")).toHaveText(secondVariantText);

  await expect.poll(async () => body<PayloadHistory>(await request.get(
    `/api/payload-generations?sessionId=${created.session.id}`,
    { headers: apiHeaders }
  ), 200), { message: "variant lineage should become visible through payload history" }).toMatchObject({
    generations: [],
    standaloneRevisions: expect.arrayContaining([
      expect.objectContaining({ operation: "edited", text: controlText }),
      expect.objectContaining({ operation: "transformed", text: firstVariantText }),
      expect.objectContaining({ operation: "transformed", text: secondVariantText })
    ])
  });

  const persistedHistory = await body<PayloadHistory>(await request.get(
    `/api/payload-generations?sessionId=${created.session.id}`,
    { headers: apiHeaders }
  ), 200);
  expect(persistedHistory.generations).toEqual([]);
  expect(persistedHistory.standaloneRevisions).toHaveLength(3);
  const source = persistedHistory.standaloneRevisions.find((revision) => revision.provenance.kind === "variant-matrix-control");
  const variants = persistedHistory.standaloneRevisions
    .filter((revision) => revision.provenance.kind === "variant-matrix")
    .toSorted((left, right) => Number(left.provenance.ordinal) - Number(right.provenance.ordinal));
  expect(source).toBeDefined();
  expect(source).toMatchObject({
    generationId: null,
    attemptId: null,
    parentRevisionId: null,
    operation: "edited",
    text: controlText,
    contentHash: payloadHash(controlText)
  });
  expect(variants).toHaveLength(2);
  const matrixId = variants[0]?.provenance.matrixId;
  const preflightHash = variants[0]?.provenance.preflightHash;
  expect(matrixId).toEqual(expect.any(String));
  expect(preflightHash).toEqual(expect.stringMatching(/^[a-f0-9]{64}$/));
  expect(source?.provenance).toEqual({
    kind: "variant-matrix-control",
    preflightHash,
    sourceHash: payloadHash(controlText)
  });
  expect(variants).toEqual([
    expect.objectContaining({
      generationId: null,
      attemptId: null,
      parentRevisionId: source?.id,
      operation: "transformed",
      text: firstVariantText,
      contentHash: payloadHash(firstVariantText),
      provenance: {
        kind: "variant-matrix",
        matrixId,
        preflightHash,
        sourceHash: payloadHash(controlText),
        transformId: "caesar-rotate",
        version: 1,
        parameters: { shift: "1" },
        ordinal: 1,
        variantCount: 2,
        outputCodePoints: 11,
        outputUtf8Bytes: 11,
        matchesControl: false,
        duplicateOutputOf: null
      }
    }),
    expect.objectContaining({
      generationId: null,
      attemptId: null,
      parentRevisionId: source?.id,
      operation: "transformed",
      text: secondVariantText,
      contentHash: payloadHash(secondVariantText),
      provenance: {
        kind: "variant-matrix",
        matrixId,
        preflightHash,
        sourceHash: payloadHash(controlText),
        transformId: "caesar-rotate",
        version: 1,
        parameters: { shift: "5" },
        ordinal: 2,
        variantCount: 2,
        outputCodePoints: 11,
        outputUtf8Bytes: 11,
        matchesControl: false,
        duplicateOutputOf: null
      }
    })
  ]);

  const unchanged = await body<SessionWorkbench>(await request.get(`/api/sessions/${created.session.id}`, {
    headers: apiHeaders
  }), 200);
  expect(unchanged.nodes).toEqual([]);
  expect(unchanged.runs).toEqual([]);
  expect(unchanged.branches).toEqual([expect.objectContaining({ id: created.branch.id, headNodeId: null })]);
  expect(modelMutations).toEqual([]);

  await workbench.getByRole("button", { name: "Close payload workbench" }).click();
  await expect.poll(async () => {
    const response = await body<{ settings: { variantMatrix: unknown } }>(await request.get(
      `/api/sessions/${created.session.id}/payload-workbench/settings`,
      { headers: apiHeaders }
    ), 200);
    return response.settings.variantMatrix;
  }, { message: "session matrix controls should be saved" }).toEqual({
    transformId: "caesar-rotate",
    version: 1,
    parameterSets: [{ shift: "1" }, { shift: "5" }]
  });

  await page.reload();
  await page.getByRole("button", { name: "Open payload workbench" }).click();
  await expect(workbench).toBeVisible();
  await workbench.getByRole("tab", { name: "Variants" }).click();
  await expect(matrix.getByLabel("Registry transform")).toHaveValue("caesar-rotate");
  await expect(matrix.getByRole("group", { name: "Factor 1 parameters" }).getByRole("spinbutton", { name: "Shift" })).toHaveValue("1");
  await expect(matrix.getByRole("group", { name: "Factor 2 parameters" }).getByRole("spinbutton", { name: "Shift" })).toHaveValue("5");
  await expect(results.getByRole("article", { name: /Variant factor/ })).toHaveCount(2);
  await expect(results.getByRole("article", { name: "Variant factor 1" }).locator(".payload-variant-text")).toHaveText(firstVariantText);
  await expect(results.getByRole("article", { name: "Variant factor 2" }).locator(".payload-variant-text")).toHaveText(secondVariantText);

  await results.getByRole("article", { name: "Variant factor 2" }).getByRole("button", { name: "Use as next prompt" }).click();
  await expect(workbench).toBeHidden();
  await expect(composer).toHaveValue(secondVariantText);

  const finalWorkbench = await body<SessionWorkbench>(await request.get(`/api/sessions/${created.session.id}`, {
    headers: apiHeaders
  }), 200);
  expect(finalWorkbench.nodes).toEqual([]);
  expect(finalWorkbench.runs).toEqual([]);
  expect(finalWorkbench.branches).toEqual([expect.objectContaining({ id: created.branch.id, headNodeId: null })]);
  expect(modelMutations).toEqual([]);
});
