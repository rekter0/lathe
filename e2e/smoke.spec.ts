import { expect, test, type Page } from "@playwright/test";
import { E2E_TOKEN } from "../playwright.config.js";

async function expectOriginalCasingOnCodeSurfaces(page: Page): Promise<void> {
  const transformed = await page.locator("code, pre, .cm-editor, .cm-content, .input, .select, .textarea").evaluateAll((elements) =>
    elements.flatMap((element) => {
      const transform = getComputedStyle(element).textTransform;
      if (transform === "none") return [];
      return [{
        element: element.tagName.toLowerCase(),
        className: element.getAttribute("class") ?? "",
        text: (element.textContent ?? "").slice(0, 80),
        transform,
      }];
    })
  );
  expect(transformed).toEqual([]);
}

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
  await expect(page).not.toHaveURL(/token=/);

  const librarySettings = page.getByRole("link", { name: "Settings" });
  const interfaceSettings = page.getByRole("button", { name: "Interface settings" });
  await expect(librarySettings).toHaveAttribute("href", "/settings");
  await expect(interfaceSettings).toBeVisible();

  await interfaceSettings.click();
  let interfaceDialog = page.getByRole("dialog", { name: "Interface settings" });
  await expect(interfaceDialog).toBeVisible();
  await interfaceDialog.getByRole("button", { name: /Extra large/ }).click();
  await expect(interfaceDialog.getByRole("slider", { name: "Interface text size" })).toHaveValue("130");
  await expect.poll(() => page.locator("html").evaluate((element) => getComputedStyle(element).fontSize)).toBe("20.8px");
  await interfaceDialog.getByRole("button", { name: "Done" }).click();

  await page.reload();
  await expect.poll(() => page.locator("html").evaluate((element) => getComputedStyle(element).fontSize)).toBe("20.8px");
  await page.getByRole("button", { name: "Interface settings" }).click();
  interfaceDialog = page.getByRole("dialog", { name: "Interface settings" });
  await expect(interfaceDialog.getByRole("slider", { name: "Interface text size" })).toHaveValue("130");
  await interfaceDialog.getByRole("button", { name: "Reset text size" }).click();
  await expect.poll(() => page.locator("html").evaluate((element) => getComputedStyle(element).fontSize)).toBe("16px");
  await interfaceDialog.getByRole("button", { name: "Done" }).click();

  const suffix = `${Date.now()}-${test.info().retry}`;
  const projectName = `Playwright project ${suffix}`;
  const sessionName = `Branch smoke ${suffix}`;
  const providerLabel = `Editable provider ${suffix}`;
  const revisedProviderLabel = `${providerLabel} revised`;
  const promptLabel = `Editable prompt ${suffix}`;
  const toolLabel = `Editable tool ${suffix}`;
  const implementationLabel = `Editable implementation ${suffix}`;
  const revisedImplementationLabel = `${implementationLabel} revised`;
  const targetLabel = `Editable target ${suffix}`;
  const revisedTargetLabel = `${targetLabel} revised`;
  const mcpLabel = `Editable MCP ${suffix}`;
  const revisedMcpLabel = `${mcpLabel} revised`;
  const apiHeaders = { Authorization: `Bearer ${E2E_TOKEN}`, Origin: "http://127.0.0.1:4318" };

  const providerResponse = await request.post("/api/providers", {
    headers: { Authorization: `Bearer ${E2E_TOKEN}`, Origin: "http://127.0.0.1:4318" },
    data: {
      label: providerLabel,
      protocol: "openai-chat",
      baseUrl: "https://fixture.invalid/v1",
      credential: `credential-${suffix}`,
      headers: { "x-fixture-secret": `header-${suffix}` },
      extraBody: { api_key: `body-${suffix}`, stable: true },
      models: [{
        id: "fixture-model",
        label: "fixture-model",
        discovered: false,
        capabilities: { streaming: true, tools: true, images: false, files: false, jsonMode: false, maxContextTokens: null }
      }]
    }
  });
  expect(providerResponse.status()).toBe(201);

  await page.goto("/settings");
  await expect(page.getByRole("button", { name: "Interface settings" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "Workbench settings" })).toBeVisible();
  await page.getByRole("button", { name: `Edit ${providerLabel}` }).click();
  const providerEditor = page.locator(".editor-panel");
  await expect(providerEditor.getByText("Edit provider · revision 1")).toBeVisible();
  await expectOriginalCasingOnCodeSurfaces(page);
  await providerEditor.getByLabel("Label").fill(revisedProviderLabel);
  await providerEditor.getByRole("button", { name: "Save new revision" }).click();
  await expect(page.getByRole("button", { name: `Edit ${revisedProviderLabel}` })).toBeVisible();
  const activeProviders = await request.get("/api/providers", { headers: { Authorization: `Bearer ${E2E_TOKEN}` } });
  expect(activeProviders.status()).toBe(200);
  const activeProvidersText = await activeProviders.text();
  expect(activeProvidersText).not.toContain(`credential-${suffix}`);
  expect(JSON.parse(activeProvidersText)).toMatchObject({ providers: expect.arrayContaining([expect.objectContaining({ label: revisedProviderLabel, revision: 2, hasCredential: true })]) });
  await page.getByRole("button", { name: `Delete ${revisedProviderLabel} provider` }).click();
  const providerDeleteDialog = page.getByRole("dialog", { name: `Delete provider “${revisedProviderLabel}”?` });
  await expect(providerDeleteDialog).toBeVisible();
  await providerDeleteDialog.getByRole("button", { name: "Cancel" }).click();
  await expect(page.getByRole("button", { name: `Edit ${revisedProviderLabel}` })).toBeVisible();
  await page.getByRole("button", { name: `Delete ${revisedProviderLabel} provider` }).click();
  await page.getByRole("dialog", { name: `Delete provider “${revisedProviderLabel}”?` }).getByRole("button", { name: "Delete provider" }).click();
  await expect(page.getByRole("button", { name: `Edit ${revisedProviderLabel}` })).toHaveCount(0);

  const assetPayloads = [
    { kind: "prompt", name: promptLabel, description: "Prompt before edit", tags: [], provenance: { operatorAuthored: true }, trusted: true, value: { content: "Prompt before edit" } },
    { kind: "tool-spec", name: toolLabel, description: "Tool before edit", tags: [], provenance: { operatorAuthored: true }, trusted: true, value: { name: toolLabel, description: "Tool before edit", inputSchema: { type: "object", properties: {} } } },
    { kind: "tool-implementation", name: implementationLabel, description: "Implementation before edit", tags: ["real"], provenance: { operatorAuthored: true }, trusted: true, value: { source: "function build() { return { program: '/bin/true' }; } function formatResult(result) { return { status: result.status }; }" } },
    { kind: "target", name: targetLabel, description: "Target before edit", tags: [], provenance: { operatorAuthored: true }, trusted: true, value: { id: `target-${suffix}`, label: targetLabel, kind: "container", runtime: "docker", container: "fixture", environment: { FIXTURE_SECRET: `target-secret-${suffix}` } } },
    { kind: "mcp-server", name: mcpLabel, description: "MCP before edit", tags: ["stdio"], provenance: { operatorAuthored: true }, trusted: true, value: { id: `mcp-${suffix}`, revision: "1", name: mcpLabel, transport: { kind: "stdio", command: "/bin/false", args: ["--version"] }, roots: [] } }
  ];
  for (const data of assetPayloads) {
    const response = await request.post("/api/library/assets", { headers: apiHeaders, data });
    expect(response.status(), await response.text()).toBe(201);
  }

  await page.getByRole("tab", { name: "Prompts" }).click();
  await page.getByRole("button", { name: `Edit ${promptLabel}` }).click();
  await page.getByLabel("System prompt").fill("Prompt after edit");
  await page.getByRole("button", { name: "Save new revision" }).click();
  await expect(page.getByRole("button", { name: `Edit ${promptLabel}` })).toBeVisible();

  await page.getByRole("tab", { name: "Tools" }).click();
  await page.getByRole("button", { name: `Edit ${toolLabel}` }).click();
  await page.locator(".editor-panel").getByLabel("Description").fill("Tool after edit");
  await page.locator(".editor-panel").getByRole("button", { name: "Save new revision" }).click();
  await expect(page.getByRole("button", { name: `Edit ${toolLabel}` })).toBeVisible();
  await page.getByRole("button", { name: `Edit ${implementationLabel} implementation` }).click();
  await expect(page.locator(".implementation-panel .cm-content")).toContainText("function build");
  await expectOriginalCasingOnCodeSurfaces(page);
  await page.locator(".implementation-panel form").getByLabel("Label").fill(revisedImplementationLabel);
  await page.locator(".implementation-panel form").getByRole("button", { name: "Save new revision" }).click();
  await expect(page.getByRole("button", { name: `Edit ${revisedImplementationLabel} implementation` })).toBeVisible();

  await page.getByRole("tab", { name: "Targets" }).click();
  await page.getByRole("button", { name: `Edit ${targetLabel} target` }).click();
  await expectOriginalCasingOnCodeSurfaces(page);
  await page.getByLabel("Target label").fill(revisedTargetLabel);
  await page.getByRole("button", { name: "Save new revision" }).click();
  await expect(page.getByRole("button", { name: `Edit ${revisedTargetLabel} target` })).toBeVisible();
  await page.getByRole("tab", { name: "MCP", exact: true }).click();
  await page.getByRole("button", { name: `Edit ${mcpLabel} MCP profile` }).click();
  await expectOriginalCasingOnCodeSurfaces(page);
  await page.getByLabel("Server label").fill(revisedMcpLabel);
  await page.getByRole("button", { name: "Save new revision" }).click();
  await expect(page.getByRole("button", { name: `Edit ${revisedMcpLabel} MCP profile` })).toBeVisible();

  const revisedAssetsResponse = await request.get("/api/assets", { headers: apiHeaders });
  expect(revisedAssetsResponse.status()).toBe(200);
  const revisedAssets = (await revisedAssetsResponse.json() as { assets: Array<{ kind: string; name: string; revision: number; value: unknown }> }).assets;
  expect(revisedAssets).toEqual(expect.arrayContaining([
    expect.objectContaining({ kind: "prompt", name: promptLabel, revision: 2, value: { content: "Prompt after edit" } }),
    expect.objectContaining({ kind: "tool-spec", name: toolLabel, revision: 2, value: expect.objectContaining({ description: "Tool after edit" }) }),
    expect.objectContaining({ kind: "tool-implementation", name: revisedImplementationLabel, revision: 2 }),
    expect.objectContaining({ kind: "target", name: revisedTargetLabel, revision: 2 }),
    expect.objectContaining({ kind: "mcp-server", name: revisedMcpLabel, revision: 2, value: expect.objectContaining({ name: revisedMcpLabel, revision: "2" }) })
  ]));
  expect(JSON.stringify(revisedAssets)).not.toContain(`target-secret-${suffix}`);

  await page.goto("/");

  await page.getByRole("button", { name: "New project" }).click();
  const dialog = page.getByRole("dialog", { name: "Create a project" });
  await dialog.getByLabel("Name", { exact: true }).fill(projectName);
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
  await expect(page.getByRole("button", { name: "Interface settings" })).toBeVisible();
  await expect(page.getByText("CONVERSATION TREE")).toBeVisible();
  await expect(page.getByRole("heading", { name: "The branch starts here" })).toBeVisible();
  await expectOriginalCasingOnCodeSurfaces(page);
  await expect(page.getByLabel("Active branch")).toHaveValue(/.+/);

  const executionPermission = page.getByLabel("Tool execution permission");
  await expect(executionPermission).toHaveValue("manual");
  await executionPermission.selectOption("bypass-approval");
  await expect(page.getByText("Commands run without per-call approval.")).toBeVisible();
  await page.getByRole("button", { name: "Save draft" }).click();
  await expect.poll(async () => {
    const url = new URL(page.url());
    const id = url.pathname.split("/").at(-1)!;
    const response = await request.get(`/api/sessions/${id}`, { headers: apiHeaders });
    return ((await response.json()) as { session: { draftConfig: { toolApprovalMode?: string } } }).session.draftConfig.toolApprovalMode;
  }).toBe("bypass-approval");
  await page.reload();
  await expect(page.getByLabel("Tool execution permission")).toHaveValue("bypass-approval");

  await page.setViewportSize({ width: 390, height: 844 });
  const continuation = page.locator(".continuation-control");
  await continuation.scrollIntoViewIfNeeded();
  await expect(continuation).toBeVisible();

  const layout = await page.evaluate(() => {
    const main = document.querySelector<HTMLElement>(".main-stage");
    const inspector = document.querySelector<HTMLElement>(".inspector-pane");
    const continuationControl = document.querySelector<HTMLElement>(".continuation-control");
    const turnLimitField = continuationControl?.querySelector<HTMLElement>(".field");
    const label = continuationControl?.children.item(0)?.getBoundingClientRect();
    const turnLimit = continuationControl?.children.item(1)?.getBoundingClientRect();
    const turnLimitChildren = turnLimitField
      ? [...turnLimitField.children].map((child) => child.getBoundingClientRect())
      : [];
    return {
      documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      mainOverflow: (main?.scrollWidth ?? 0) - (main?.clientWidth ?? 0),
      inspectorOverflow: (inspector?.scrollWidth ?? 0) - (inspector?.clientWidth ?? 0),
      continuationColumns: continuationControl ? getComputedStyle(continuationControl).gridTemplateColumns : "",
      continuationOverlaps: label && turnLimit ? label.bottom > turnLimit.top + 1 : true,
      turnLimitDisplay: turnLimitField ? getComputedStyle(turnLimitField).display : "",
      turnLimitChildrenOverlap: turnLimitChildren.some((box, index) => index > 0 && box.top < turnLimitChildren[index - 1]!.bottom)
    };
  });

  expect(layout.documentOverflow).toBe(0);
  expect(layout.mainOverflow).toBe(0);
  expect(layout.inspectorOverflow).toBe(0);
  expect(layout.continuationColumns.split(" ")).toHaveLength(1);
  expect(layout.continuationOverlaps).toBe(false);
  expect(layout.turnLimitDisplay).toBe("grid");
  expect(layout.turnLimitChildrenOverlap).toBe(false);

  const workbenchUrl = new URL(page.url());
  const workbenchSegments = workbenchUrl.pathname.split("/");
  const projectId = workbenchSegments[2]!;
  const sessionId = workbenchSegments[4]!;
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(`/?project=${projectId}`);
  await page.getByRole("button", { name: `Delete ${sessionName} session` }).click();
  const sessionDeleteDialog = page.getByRole("dialog", { name: `Delete session “${sessionName}”?` });
  await expect(sessionDeleteDialog).toBeVisible();
  await sessionDeleteDialog.getByRole("button", { name: "Delete session" }).click();
  await expect(page.getByRole("link", { name: sessionName })).toHaveCount(0);
  expect((await request.get(`/api/sessions/${sessionId}`, { headers: apiHeaders })).status()).toBe(404);

  await page.getByRole("button", { name: "Delete project" }).click();
  const projectDeleteDialog = page.getByRole("dialog", { name: `Delete project “${projectName}”?` });
  await expect(projectDeleteDialog).toBeVisible();
  await projectDeleteDialog.getByRole("button", { name: "Delete project" }).click();
  await expect(page.getByRole("heading", { name: projectName })).toHaveCount(0);
  expect((await request.get(`/api/sessions?projectId=${projectId}`, { headers: apiHeaders })).status()).toBe(200);
});
