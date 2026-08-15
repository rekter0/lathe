import { expect, test } from "@playwright/test";
import { E2E_TOKEN } from "../playwright.config.js";

test("protects the local API and creates a persistent workbench", async ({ page, request }) => {
  const unprotectedHealth = await request.get("/api/health");
  expect(unprotectedHealth.ok()).toBe(true);

  const missingToken = await request.get("/api/config");
  expect(missingToken.status()).toBe(401);

  const foreignOrigin = await request.get("/api/config", {
    headers: {
      Authorization: `Bearer ${E2E_TOKEN}`,
      Origin: "https://example.invalid"
    }
  });
  expect(foreignOrigin.status()).toBe(403);

  await page.goto("/");
  await expect(page.getByRole("heading", { name: "Launch token missing" })).toBeVisible();

  await page.goto(`/?token=${encodeURIComponent(E2E_TOKEN)}`);
  await expect(page).toHaveTitle(/Lathe/i);
  await expect(page.getByRole("heading", { name: /Explore the path/i })).toBeVisible();
  await expect(page.getByText(/Credentials are stored plaintext/i)).toBeVisible();
  await expect(page).not.toHaveURL(/token=/);

  const suffix = `${Date.now()}-${test.info().retry}`;
  const projectName = `Playwright project ${suffix}`;
  const sessionName = `Branch smoke ${suffix}`;

  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog", { name: "Create a project" });
  await dialog.getByLabel("Name").fill(projectName);
  await dialog.getByLabel("Description").fill("Playwright acceptance fixture");
  await dialog.getByRole("button", { name: "Create project" }).click();

  await expect(page).toHaveURL(/\?project=/);
  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.getByRole("button", { name: "Collapse projects sidebar" }).click();
  await expect(page.getByRole("button", { name: "Expand projects sidebar" })).toBeVisible();
  await expect(page.getByRole("link", { name: projectName })).toBeVisible();
  await page.reload();
  await expect(page.getByRole("button", { name: "Expand projects sidebar" })).toBeVisible();
  await page.getByRole("button", { name: "Expand projects sidebar" }).click();
  await expect(page.getByRole("button", { name: "Collapse projects sidebar" })).toBeVisible();

  await page.getByPlaceholder("Tool result injection").fill(sessionName);
  await page.getByRole("button", { name: /Open workbench/ }).click();

  await expect(page).toHaveURL(/\/projects\/[^/]+\/sessions\/[^/]+/);
  await expect(page.getByRole("heading", { name: sessionName })).toBeVisible();
  await expect(page.getByText("CONVERSATION TREE")).toBeVisible();
  await expect(page.getByRole("heading", { name: "The branch starts here" })).toBeVisible();
  await expect(page.getByLabel("Active branch")).toHaveValue(/.+/);
});
