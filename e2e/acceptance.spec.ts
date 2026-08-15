import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { E2E_PORT, E2E_PROVIDER_PORT, E2E_TOKEN } from "../playwright.config.js";

const appOrigin = `http://127.0.0.1:${E2E_PORT}`;
const providerOrigin = `http://127.0.0.1:${E2E_PROVIDER_PORT}`;
const apiHeaders = {
  Authorization: `Bearer ${E2E_TOKEN}`,
  Origin: appOrigin
};

interface MessagePart {
  type: string;
  text?: string;
  callId?: string;
  name?: string;
}

interface MessageNode {
  id: string;
  parentId: string | null;
  role: "user" | "assistant" | "tool";
  parts: MessagePart[];
  sourceRunId: string | null;
}

interface Branch {
  id: string;
  name: string;
  headNodeId: string | null;
}

interface Run {
  id: string;
  status: string;
  resultNodeId: string | null;
  normalizedOutput: Record<string, unknown> | null;
}

interface Workbench {
  session: {
    id: string;
    projectId: string;
    name: string;
    providerProfileId: string | null;
    modelId: string | null;
    draftConfig: {
      promptBlocks: Array<{ name: string; content: string; enabled: boolean }>;
      tools: Array<{ name: string; enabled: boolean; mode: string }>;
      temperature: number | null;
      [key: string]: unknown;
    };
  };
  nodes: MessageNode[];
  branches: Branch[];
  runs: Run[];
}

async function body<T>(response: APIResponse, expectedStatus: number): Promise<T> {
  expect(response.status(), await response.text()).toBe(expectedStatus);
  return response.json() as Promise<T>;
}

async function getWorkbench(request: APIRequestContext, sessionId: string): Promise<Workbench> {
  return body<Workbench>(await request.get(`/api/sessions/${sessionId}`, { headers: apiHeaders }), 200);
}

async function waitForRun(request: APIRequestContext, sessionId: string, runId: string, status: string): Promise<Workbench> {
  let latest: Workbench | undefined;
  await expect.poll(async () => {
    latest = await getWorkbench(request, sessionId);
    return latest.runs.find((run) => run.id === runId)?.status;
  }, { timeout: 15_000, intervals: [50, 100, 250] }).toBe(status);
  return latest!;
}

async function startTextRun(request: APIRequestContext, sessionId: string, branch: Branch, text: string): Promise<{ runId: string; workbench: Workbench }> {
  const started = await body<{ run: { id: string; status: string } }>(await request.post("/api/runs", {
    headers: apiHeaders,
    data: {
      sessionId,
      branchId: branch.id,
      contextNodeId: branch.headNodeId,
      userMessage: text
    }
  }), 202);
  return { runId: started.run.id, workbench: await waitForRun(request, sessionId, started.run.id, "completed") };
}

test("runs the complete manual red-team workflow and round-trips a finding", async ({ page, request }) => {
  const suffix = `${Date.now()}-${test.info().retry}`;
  const credential = `e2e-secret-${suffix}`;
  const fixtureHeader = `fixture-header-${suffix}`;
  const projectName = `Acceptance project ${suffix}`;
  const sessionName = `Acceptance session ${suffix}`;
  const redBranchName = `red-path-${suffix}`;
  const blueBranchName = `blue-path-${suffix}`;

  const project = (await body<{ project: { id: string } }>(await request.post("/api/projects", {
    headers: apiHeaders,
    data: { name: projectName, description: "Full Playwright v1 acceptance flow" }
  }), 201)).project;

  const provider = (await body<{ provider: { id: string; hasCredential: boolean } }>(await request.post("/api/providers", {
    headers: apiHeaders,
    data: {
      label: `Deterministic provider ${suffix}`,
      protocol: "openai-chat",
      baseUrl: providerOrigin,
      credential,
      headers: { "x-lathe-fixture": fixtureHeader },
      extraBody: { fixture_nonce: suffix },
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
          maxContextTokens: 32_000
        }
      }]
    }
  }), 201)).provider;
  expect(provider.hasCredential).toBe(true);

  const discovery = await body<{ models: Array<{ id: string }> }>(await request.post(`/api/providers/${provider.id}/discover`, {
    headers: apiHeaders
  }), 200);
  expect(discovery.models).toContainEqual(expect.objectContaining({ id: "fixture-model" }));

  const harnesses = await body<{ assets: Array<{ id: string; name: string }> }>(await request.get("/api/assets?kind=harness", {
    headers: apiHeaders
  }), 200);
  const harness = harnesses.assets.find((asset) => asset.name === "Codex-inspired");
  expect(harness, "built-in Codex-inspired harness").toBeDefined();

  const created = await body<{ session: { id: string }; branch: Branch }>(await request.post("/api/sessions", {
    headers: apiHeaders,
    data: {
      projectId: project.id,
      name: sessionName,
      providerProfileId: provider.id,
      modelId: "fixture-model",
      harnessRevisionId: harness!.id
    }
  }), 201);
  const sessionId = created.session.id;
  const mainBranch = created.branch;

  let workbench = await getWorkbench(request, sessionId);
  expect(workbench.session.draftConfig.promptBlocks).toEqual([
    expect.objectContaining({ name: "Codex-inspired coding operator", enabled: true })
  ]);
  expect(workbench.session.draftConfig.tools).toEqual([
    expect.objectContaining({ name: "shell", enabled: true, mode: "manual" })
  ]);

  const toolRun = await body<{ run: { id: string } }>(await request.post("/api/runs", {
    headers: apiHeaders,
    data: {
      sessionId,
      branchId: mainBranch.id,
      contextNodeId: mainBranch.headNodeId,
      userMessage: `[call-tool] establish the shared attack state ${suffix}`
    }
  }), 202);
  workbench = await waitForRun(request, sessionId, toolRun.run.id, "awaiting-tool");
  const toolAssistant = workbench.nodes.find((node) => node.sourceRunId === toolRun.run.id);
  const toolCall = toolAssistant?.parts.find((part) => part.type === "tool-call");
  expect(toolCall).toMatchObject({ name: "shell" });

  await body<{ ok: true }>(await request.post(`/api/runs/${toolRun.run.id}/tool-calls/${toolCall!.callId}/resolve`, {
    headers: apiHeaders,
    data: { resolution: { result: { stdout: "fixture tool output", exitCode: 0 }, isError: false } }
  }), 200);
  workbench = await waitForRun(request, sessionId, toolRun.run.id, "completed");
  const mainAfterTool = workbench.branches.find((branch) => branch.id === mainBranch.id)!;
  const checkpointNodeId = mainAfterTool.headNodeId;
  expect(workbench.nodes.find((node) => node.id === checkpointNodeId)).toMatchObject({ role: "tool" });

  const providerRequests = await body<{
    requests: Array<{
      body: { messages: Array<{ role: string; content: string }>; tools: Array<{ function: { name: string } }> };
      authorizationPresent: boolean;
      fixtureHeader: string;
    }>;
  }>(await request.get(`${providerOrigin}/__requests?nonce=${encodeURIComponent(suffix)}`), 200);
  expect(providerRequests.requests[0]).toMatchObject({ authorizationPresent: true, fixtureHeader });
  expect(providerRequests.requests[0]?.body.messages[0]).toMatchObject({
    role: "system",
    content: expect.stringContaining("careful coding collaborator")
  });
  expect(providerRequests.requests[0]?.body.tools).toContainEqual(expect.objectContaining({
    function: expect.objectContaining({ name: "shell" })
  }));

  const checkpoint = (await body<{ checkpoint: { id: string; nodeId: string } }>(await request.post(`/api/sessions/${sessionId}/checkpoints`, {
    headers: apiHeaders,
    data: { name: `shared-state-${suffix}`, nodeId: checkpointNodeId }
  }), 201)).checkpoint;

  const changedConfig = structuredClone(workbench.session.draftConfig);
  changedConfig.temperature = 1.25;
  await body(await request.patch(`/api/sessions/${sessionId}/config`, {
    headers: apiHeaders,
    data: { config: changedConfig }
  }), 200);

  const redBranch = (await body<{ branch: Branch }>(await request.post("/api/branches", {
    headers: apiHeaders,
    data: { sessionId, name: redBranchName, headNodeId: checkpointNodeId }
  }), 201)).branch;
  const firstRedPayload = `first red divergence ${suffix}`;
  const firstRed = await startTextRun(request, sessionId, redBranch, firstRedPayload);
  const oldRedHead = firstRed.workbench.branches.find((branch) => branch.id === redBranch.id)!.headNodeId;

  const blueBranch = (await body<{ branch: Branch }>(await request.post("/api/branches", {
    headers: apiHeaders,
    data: { sessionId, name: blueBranchName, headNodeId: checkpointNodeId }
  }), 201)).branch;
  const bluePayload = `blue divergence ${suffix}`;
  const blue = await startTextRun(request, sessionId, blueBranch, bluePayload);
  const blueHead = blue.workbench.branches.find((branch) => branch.id === blueBranch.id)!.headNodeId;

  const firstComparison = await body<{
    comparison: { ancestor: { id: string }; shared: MessageNode[]; left: MessageNode[]; right: MessageNode[] };
  }>(await request.get(`/api/compare?sessionId=${sessionId}&left=${oldRedHead}&right=${blueHead}`, { headers: apiHeaders }), 200);
  expect(firstComparison.comparison.ancestor.id).toBe(checkpointNodeId);
  expect(firstComparison.comparison.left.some((node) => node.parts.some((part) => part.text === firstRedPayload))).toBe(true);
  expect(firstComparison.comparison.right.some((node) => node.parts.some((part) => part.text === bluePayload))).toBe(true);

  const restored = await body<{ branch: Branch; session: Workbench["session"] }>(await request.post(
    `/api/checkpoints/${checkpoint.id}/restore?sessionId=${sessionId}&branchId=${redBranch.id}`,
    { headers: apiHeaders }
  ), 200);
  expect(restored.branch.headNodeId).toBe(checkpointNodeId);
  expect(restored.session.draftConfig.temperature).toBeNull();

  const restoredPayload = `restored red divergence ${suffix}`;
  const restoredRed = await startTextRun(request, sessionId, restored.branch, restoredPayload);
  workbench = restoredRed.workbench;
  const restoredRedHead = workbench.branches.find((branch) => branch.id === redBranch.id)!.headNodeId;
  expect(workbench.nodes.some((node) => node.id === oldRedHead)).toBe(true);

  const restoredComparison = await body<{
    comparison: { ancestor: { id: string }; left: MessageNode[]; right: MessageNode[] };
  }>(await request.get(`/api/compare?sessionId=${sessionId}&left=${restoredRedHead}&right=${blueHead}`, { headers: apiHeaders }), 200);
  expect(restoredComparison.comparison.ancestor.id).toBe(checkpointNodeId);

  await page.goto(`/projects/${project.id}/sessions/${sessionId}?token=${encodeURIComponent(E2E_TOKEN)}`);
  await expect(page.getByRole("heading", { name: sessionName })).toBeVisible();
  await page.getByLabel("Active branch").selectOption({ label: redBranchName });
  await page.locator("details.comparison-picker > summary").click();
  await page.getByRole("checkbox", { name: blueBranchName }).check();
  const comparisonView = page.locator(".comparison-view");
  await expect(comparisonView.getByText(/Common ancestor:/)).toContainText(checkpointNodeId!.slice(0, 8));
  await expect(comparisonView.getByRole("heading", { name: redBranchName })).toBeVisible();
  await expect(comparisonView.getByRole("heading", { name: blueBranchName })).toBeVisible();
  await expect(comparisonView).toContainText(restoredPayload);
  await expect(comparisonView).toContainText(bluePayload);

  await page.getByRole("checkbox", { name: blueBranchName }).uncheck();
  await page.locator(".comparison-picker > summary").click();
  const keyboardFirstLine = `[stream-chat] keyboard first line ${suffix}`;
  const keyboardPayload = `${keyboardFirstLine}\nkeyboard second line ${suffix}`;
  const composer = page.getByPlaceholder("Enter the next operator payload…");
  await composer.fill(keyboardFirstLine);
  await composer.press("Shift+Enter");
  await composer.pressSequentially(`keyboard second line ${suffix}`);
  await expect(composer).toHaveValue(keyboardPayload);
  const transcript = page.locator(".transcript-scroll");
  await transcript.evaluate((element) => { element.scrollTop = 0; });
  await composer.press("Enter");
  await expect(composer).toHaveValue("");
  const streamingMessage = page.getByRole("article", { name: "Streaming model response" });
  await expect(streamingMessage).toBeVisible();
  await expect(streamingMessage.locator(".message-reasoning strong")).toHaveText("reasoning");
  await expect(streamingMessage.locator(".message-body > p strong")).toHaveText("answer");
  await expect.poll(() => transcript.evaluate((element) => element.scrollHeight - element.scrollTop - element.clientHeight)).toBeLessThanOrEqual(2);
  await expect.poll(async () => {
    const keyboardWorkbench = await getWorkbench(request, sessionId);
    return keyboardWorkbench.nodes.some((node) => node.parts.some((part) => part.text === keyboardPayload));
  }).toBe(true);
  await expect(streamingMessage).toHaveCount(0);
  const latestModelMessage = page.locator("article.message-assistant").last();
  await expect(latestModelMessage).toContainText(keyboardPayload);
  await expect(latestModelMessage.locator(".message-reasoning > summary")).toContainText("Reasoning");
  await expect(latestModelMessage.locator(".message-reasoning strong")).toHaveText("reasoning");
  await expect(latestModelMessage.locator(".message-body > p strong")).toHaveText("answer");
  await latestModelMessage.getByRole("button", { name: "Show raw message text" }).click();
  await expect(latestModelMessage.getByRole("button", { name: "Show rendered message" })).toBeVisible();
  await expect(latestModelMessage.locator("pre.message-raw")).toContainText([
    "Streaming **reasoning**:",
    "Streaming **answer**:"
  ]);
  await page.getByRole("tab", { name: "Run", exact: true }).click();
  const inspectorLayout = await page.locator(".inspector-pane").evaluate((inspector) => {
    const panel = inspector.querySelector<HTMLElement>("[role='tabpanel'][data-state='active']");
    const content = panel?.querySelector<HTMLElement>(".inspector-content");
    const contentStyle = content ? getComputedStyle(content) : null;
    return {
      width: inspector.clientWidth,
      overflow: panel ? panel.scrollWidth - panel.clientWidth : Number.POSITIVE_INFINITY,
      paddingLeft: contentStyle ? Number.parseFloat(contentStyle.paddingLeft) : 0,
      paddingRight: contentStyle ? Number.parseFloat(contentStyle.paddingRight) : 0
    };
  });
  expect(inspectorLayout.width).toBeGreaterThanOrEqual(349);
  expect(inspectorLayout.overflow).toBeLessThanOrEqual(0);
  expect(inspectorLayout.paddingLeft).toBeGreaterThanOrEqual(20);
  expect(inspectorLayout.paddingRight).toBe(inspectorLayout.paddingLeft);

  const automation = (await body<{ job: { id: string } }>(await request.post("/api/automation", {
    headers: apiHeaders,
    data: {
      projectId: project.id,
      sessionId,
      kind: "batch-vary",
      concurrency: 2,
      plan: {
        pointer: "/payload",
        values: [`batch alpha ${suffix}`, `batch beta ${suffix}`],
        template: { branchId: redBranch.id, payload: "placeholder" }
      }
    }
  }), 202)).job;

  let completedJob: { status: string; progress: { completed?: number; total?: number } } | undefined;
  await expect.poll(async () => {
    const jobs = await body<{ jobs: Array<{ id: string; status: string; progress: { completed?: number; total?: number } }> }>(
      await request.get(`/api/automation?sessionId=${sessionId}`, { headers: apiHeaders }),
      200
    );
    completedJob = jobs.jobs.find((job) => job.id === automation.id);
    return completedJob?.status;
  }, { timeout: 20_000, intervals: [50, 100, 250] }).toBe("completed");
  expect(completedJob?.progress).toMatchObject({ completed: 2, total: 2 });
  workbench = await getWorkbench(request, sessionId);
  expect(workbench.branches.filter((branch) => branch.name.startsWith("batch-")).length).toBeGreaterThanOrEqual(2);

  const finalBlueBranch = workbench.branches.find((branch) => branch.id === blueBranch.id)!;
  const findingTitle = `Reproducible finding ${suffix}`;
  const finding = (await body<{ finding: { id: string; title: string } }>(await request.post("/api/findings", {
    headers: apiHeaders,
    data: {
      projectId: project.id,
      sessionId,
      branchId: finalBlueBranch.id,
      nodeId: finalBlueBranch.headNodeId,
      title: findingTitle,
      severity: "high",
      summary: "A deterministic red-team branch reproduced the behavior.",
      expected: "The fixture policy should hold.",
      observed: "The alternate branch produced the recorded response.",
      tags: ["playwright", "reproducible"]
    }
  }), 201)).finding;

  const exported = await request.get(`/api/findings/${finding.id}/export?projectId=${project.id}`, { headers: apiHeaders });
  expect(exported.status()).toBe(200);
  expect(exported.headers()["content-type"]).toContain("application/zip");
  const archive = await exported.body();
  expect(archive.byteLength).toBeGreaterThan(500);
  expect(archive.toString("utf8")).not.toContain(credential);

  const imported = await body<{
    manifest: { kind: string; artifactId: string };
    project: { id: string };
    session: { id: string };
    finding: { id: string; title: string };
    scriptsEnabled: boolean;
  }>(await request.post("/api/artifacts/import", {
    headers: apiHeaders,
    multipart: {
      file: {
        name: `${findingTitle}.lathe-finding`,
        mimeType: "application/zip",
        buffer: archive
      }
    }
  }), 201);
  expect(imported.manifest).toMatchObject({ kind: "finding", artifactId: finding.id });
  expect(imported.project.id).not.toBe(project.id);
  expect(imported.finding.title).toBe(findingTitle);
  expect(imported.scriptsEnabled).toBe(false);

  const importedFindings = await body<{ findings: Array<{ id: string; title: string }> }>(
    await request.get(`/api/findings?projectId=${imported.project.id}`, { headers: apiHeaders }),
    200
  );
  expect(importedFindings.findings).toContainEqual(expect.objectContaining({
    id: imported.finding.id,
    title: findingTitle
  }));
  const importedWorkbench = await getWorkbench(request, imported.session.id);
  expect(importedWorkbench.nodes.some((node) => node.parts.some((part) => part.text === bluePayload))).toBe(true);
});
