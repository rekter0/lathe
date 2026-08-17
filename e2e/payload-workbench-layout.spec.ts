import { expect, test, type APIResponse, type Locator } from "@playwright/test";
import { E2E_PORT, E2E_TOKEN } from "../playwright.config.js";

const appOrigin = `http://127.0.0.1:${E2E_PORT}`;
const apiHeaders = {
  Authorization: `Bearer ${E2E_TOKEN}`,
  Origin: appOrigin
};

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

async function body<T>(response: APIResponse, expectedStatus: number): Promise<T> {
  expect(response.status(), await response.text()).toBe(expectedStatus);
  return response.json() as Promise<T>;
}

async function rect(locator: Locator, label: string): Promise<Rect> {
  const box = await locator.boundingBox();
  expect(box, `${label} should have a rendered box`).not.toBeNull();
  return box!;
}

async function expectContained(outer: Locator, inner: Locator, label: string): Promise<void> {
  const [outerBox, innerBox] = await Promise.all([
    rect(outer, `${label} container`),
    rect(inner, label)
  ]);
  const tolerance = 2;
  expect(innerBox.width, `${label} should not be horizontally clipped`).toBeGreaterThan(0);
  expect(innerBox.height, `${label} should not be vertically clipped`).toBeGreaterThan(0);
  expect(innerBox.x, `${label} should start inside its container`).toBeGreaterThanOrEqual(outerBox.x - tolerance);
  expect(innerBox.x + innerBox.width, `${label} should end inside its container`).toBeLessThanOrEqual(outerBox.x + outerBox.width + tolerance);
  expect(innerBox.y, `${label} should start inside its container`).toBeGreaterThanOrEqual(outerBox.y - tolerance);
  expect(innerBox.y + innerBox.height, `${label} should end inside its container`).toBeLessThanOrEqual(outerBox.y + outerBox.height + tolerance);
}

async function expectBefore(upper: Locator, lower: Locator, label: string): Promise<void> {
  const [upperBox, lowerBox] = await Promise.all([
    rect(upper, `${label} upper item`),
    rect(lower, `${label} lower item`)
  ]);
  expect(upperBox.y + upperBox.height, `${label} should not overlap`).toBeLessThanOrEqual(lowerBox.y + 2);
}

async function scrollToBottom(scroller: Locator, label: string): Promise<void> {
  const overflow = await scroller.evaluate((element) => ({
    clientHeight: element.clientHeight,
    scrollHeight: element.scrollHeight
  }));
  expect(overflow.scrollHeight, `${label} should have enough content to exercise scrolling`).toBeGreaterThan(overflow.clientHeight);
  await scroller.evaluate((element) => { element.scrollTop = element.scrollHeight; });
  await expect.poll(
    () => scroller.evaluate((element) => element.scrollTop),
    { message: `${label} should scroll away from its initial position` }
  ).toBeGreaterThan(0);
}

test.use({ viewport: { width: 1_400, height: 900 } });

test("keeps the scaled Payload Workbench panes independently scrollable without clipping", async ({ page, request }) => {
  const suffix = `${Date.now()}-${test.info().retry}`;
  const project = (await body<{ project: { id: string } }>(await request.post("/api/projects", {
    headers: apiHeaders,
    data: { name: `Layout project ${suffix}`, description: "Payload Workbench layout fixture" }
  }), 201)).project;
  const session = (await body<{ session: { id: string } }>(await request.post("/api/sessions", {
    headers: apiHeaders,
    data: { projectId: project.id, name: `Layout session ${suffix}`, description: "No provider is required." }
  }), 201)).session;

  await page.addInitScript(() => {
    window.localStorage.setItem("lathe.ui-preferences.v1", JSON.stringify({ fontScalePercent: 150 }));
  });
  await page.goto(`/projects/${project.id}/sessions/${session.id}?token=${encodeURIComponent(E2E_TOKEN)}`);
  await expect(page).not.toHaveURL(/token=/);
  await expect.poll(() => page.locator("html").getAttribute("data-ui-font-scale")).toBe("150");

  const controlText = [
    "Control payload line one",
    "Control payload line two",
    "Control payload line three"
  ].join("\n");
  await page.getByLabel("Next operator payload").fill(controlText);
  await page.getByRole("button", { name: "Open payload workbench" }).click();

  const dialog = page.getByRole("dialog", { name: "Payload workbench" });
  const tabs = dialog.locator(":scope > .payload-workbench-tabs > [role=tablist]");
  const footer = dialog.locator(":scope > .payload-workbench-footer");
  await expect(dialog).toBeVisible();
  await expectContained(dialog, tabs, "workbench tabs");
  await expectContained(dialog, footer, "workbench footer");

  await dialog.getByRole("tab", { name: "Variants" }).click();
  const matrix = dialog.getByRole("region", { name: "Payload variant matrix" });
  const controls = matrix.locator(".payload-variant-controls");
  const source = matrix.getByRole("region", { name: "Variant matrix control source" });
  const registryField = controls.locator("label.field").filter({ hasText: "Registry transform" });
  const transformSummary = controls.locator(".payload-variant-transform-summary");
  const factors = matrix.getByRole("region", { name: "Variant factor rows" });
  const addFactor = matrix.getByRole("button", { name: "Add factor" });

  for (let index = 0; index < 5; index += 1) await addFactor.click();
  await controls.evaluate((element) => { element.scrollTop = 0; });

  await expect(source.locator("pre")).toHaveText(controlText);
  await expectContained(source, source.locator("header"), "variant control header");
  await expectContained(source, source.locator("pre"), "variant control text");
  await expectContained(transformSummary, transformSummary.locator("p"), "variant transform description");
  await expectContained(factors.locator("fieldset").first(), factors.locator("fieldset").first().getByRole("spinbutton", { name: "Shift" }), "first factor input");
  await expectBefore(source, registryField, "control and registry field");
  await expectBefore(registryField, transformSummary, "registry field and transform summary");
  await expectBefore(transformSummary, factors, "transform summary and factors");

  const variantActions = controls.locator(".payload-variant-preflight-actions");
  await scrollToBottom(controls, "variant controls");
  await expectContained(controls, variantActions, "variant preflight actions");
  await expect(variantActions.getByRole("button", { name: "Run authoritative preflight" })).toBeVisible();
  await expect(variantActions.getByRole("button", { name: "Create variants" })).toBeVisible();
  await expectContained(dialog, tabs, "workbench tabs after variant scrolling");
  await expectContained(dialog, footer, "workbench footer after variant scrolling");

  await dialog.getByRole("tab", { name: "Transform" }).click();
  const editor = dialog.locator(".payload-workbench-editor");
  const toolbox = dialog.getByRole("complementary", { name: "Payload transformations" });
  const textarea = dialog.getByRole("textbox", { name: "Next prompt" });
  const inspection = dialog.getByRole("region", { name: "Payload inspection" });
  const variableEditor = toolbox.locator(".payload-variable-editor");

  // Reproduce an operator-resized draft at the screenshot-like viewport. The
  // editor must keep the inspector reachable instead of growing behind the
  // sticky dialog footer.
  await textarea.evaluate((element) => { element.style.height = "920px"; });
  await scrollToBottom(editor, "transform editor");
  await expectContained(editor, inspection, "payload inspection");
  await expect(inspection.getByText("Inspect payload", { exact: true })).toBeVisible();
  await expect(inspection.getByRole("tab", { name: "Round-trip" })).toBeVisible();

  await scrollToBottom(toolbox, "transform toolbox");
  await expectContained(toolbox, variableEditor, "variable controls");
  await expect(variableEditor.getByRole("button", { name: "Add variable" })).toBeVisible();
  await expectContained(dialog, tabs, "workbench tabs after transform scrolling");
  await expectContained(dialog, footer, "workbench footer after transform scrolling");

  const horizontalOverflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth
  }));
  expect(horizontalOverflow.document).toBeLessThanOrEqual(0);
  expect(horizontalOverflow.body).toBeLessThanOrEqual(0);

  // At the single-column breakpoint, Transform intentionally becomes one
  // continuous body scroller. The toolbox must remain reachable below the
  // editor without pushing the dialog chrome off-screen.
  await page.setViewportSize({ width: 560, height: 760 });
  const transformLayout = dialog.locator(".payload-workbench-layout");
  await scrollToBottom(transformLayout, "narrow transform body");
  await expectContained(transformLayout, variableEditor, "narrow variable controls");
  await expectContained(dialog, tabs, "narrow workbench tabs");
  await expectContained(dialog, footer, "narrow workbench footer");
  const narrowHorizontalOverflow = await page.evaluate(() => ({
    document: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    body: document.body.scrollWidth - document.body.clientWidth
  }));
  expect(narrowHorizontalOverflow.document).toBeLessThanOrEqual(0);
  expect(narrowHorizontalOverflow.body).toBeLessThanOrEqual(0);
});
