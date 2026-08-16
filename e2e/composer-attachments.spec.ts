import { Buffer } from "node:buffer";
import { expect, test, type APIRequestContext, type APIResponse } from "@playwright/test";
import { E2E_PORT, E2E_PROVIDER_PORT, E2E_TOKEN } from "../playwright.config.js";

const appOrigin = `http://127.0.0.1:${E2E_PORT}`;
const providerOrigin = `http://127.0.0.1:${E2E_PROVIDER_PORT}`;
const apiHeaders = {
  Authorization: `Bearer ${E2E_TOKEN}`,
  Origin: appOrigin,
};

interface MessagePart {
  type: string;
  text?: string;
  attachmentId?: string;
  name?: string;
  mediaType?: string;
}

interface MessageNode {
  id: string;
  role: "user" | "assistant" | "tool";
  parts: MessagePart[];
}

interface WorkbenchResponse {
  nodes: MessageNode[];
  runs: Array<{
    id: string;
    contextNodeId: string | null;
    status: string;
  }>;
  attachments: Array<{
    id: string;
    fileName: string;
    mediaType: string;
    size: number;
  }>;
}

async function body<T>(response: APIResponse, expectedStatus: number): Promise<T> {
  expect(response.status(), await response.text()).toBe(expectedStatus);
  return response.json() as Promise<T>;
}

async function getWorkbench(request: APIRequestContext, sessionId: string): Promise<WorkbenchResponse> {
  return body<WorkbenchResponse>(await request.get(`/api/sessions/${sessionId}`, { headers: apiHeaders }), 200);
}

test("pastes a screenshot and submits it as an attachment-only operator turn", async ({ page, request }) => {
  const suffix = `${Date.now()}-${test.info().retry}`;
  const screenshotBytes = [137, 80, 78, 71, 13, 10, 26, 10];

  const project = (await body<{ project: { id: string } }>(await request.post("/api/projects", {
    headers: apiHeaders,
    data: { name: `Clipboard project ${suffix}`, description: "Composer attachment regression" },
  }), 201)).project;

  const provider = (await body<{ provider: { id: string } }>(await request.post("/api/providers", {
    headers: apiHeaders,
    data: {
      label: `Clipboard provider ${suffix}`,
      protocol: "openai-chat",
      baseUrl: providerOrigin,
      credential: `clipboard-secret-${suffix}`,
      models: [{
        id: "fixture-model",
        label: "Fixture model",
        discovered: false,
        capabilities: {
          streaming: true,
          tools: false,
          images: true,
          files: false,
          jsonMode: false,
          maxContextTokens: 32_000,
        },
      }],
    },
  }), 201)).provider;

  const created = await body<{ session: { id: string } }>(await request.post("/api/sessions", {
    headers: apiHeaders,
    data: {
      projectId: project.id,
      name: `Clipboard session ${suffix}`,
      providerProfileId: provider.id,
      modelId: "fixture-model",
    },
  }), 201);
  const sessionId = created.session.id;

  await page.goto(`/?token=${encodeURIComponent(E2E_TOKEN)}`);
  await page.goto(`/projects/${project.id}/sessions/${sessionId}`);

  const composer = page.getByLabel("Next operator payload");
  const runButton = page.getByRole("button", { name: "Run", exact: true });
  await expect(composer).toBeVisible();
  await expect(composer).toHaveValue("");
  await expect(runButton).toBeDisabled();

  let releaseUpload!: () => void;
  const uploadGate = new Promise<void>((resolve) => { releaseUpload = resolve; });
  await page.route("**/api/projects/*/attachments", async (route) => {
    await uploadGate;
    await route.continue();
  });

  await composer.evaluate((element, bytes) => {
    const transfer = new DataTransfer();
    transfer.items.add(new File([new Uint8Array(bytes)], "image.png", { type: "image/png" }));
    element.dispatchEvent(new ClipboardEvent("paste", {
      bubbles: true,
      cancelable: true,
      clipboardData: transfer,
    }));
  }, screenshotBytes);

  const attachmentChip = page.locator(".composer-attachment").filter({ hasText: /^pasted-image-/ });
  await expect(attachmentChip).toHaveClass(/uploading/);
  await expect(page.getByText("Uploading attachment… Run will be available when it finishes.")).toBeVisible();
  await expect(runButton).toBeDisabled();
  await expect(composer).toHaveValue("");

  releaseUpload();
  await expect(attachmentChip).toHaveClass(/ready/);
  await expect(runButton).toBeEnabled();
  const pastedFileName = (await attachmentChip.locator("span").last().textContent())!;
  expect(pastedFileName).toMatch(/^pasted-image-\d{8}T\d{9}Z\.png$/);

  await runButton.click();
  await expect(attachmentChip).toHaveCount(0);
  await expect(composer).toHaveValue("");

  let persistedNode: MessageNode | undefined;
  let requestRun: WorkbenchResponse["runs"][number] | undefined;
  let persistedAttachment: WorkbenchResponse["attachments"][number] | undefined;
  await expect.poll(async () => {
    const workbench = await getWorkbench(request, sessionId);
    persistedNode = workbench.nodes.find((node) => node.role === "user" && node.parts.some((part) => part.type === "attachment" && part.name === pastedFileName));
    requestRun = workbench.runs.find((run) => run.contextNodeId === persistedNode?.id);
    const attachmentId = persistedNode?.parts.find((part) => part.type === "attachment")?.attachmentId;
    persistedAttachment = workbench.attachments.find((attachment) => attachment.id === attachmentId);
    return Boolean(persistedNode && persistedAttachment && requestRun);
  }).toBe(true);

  expect(persistedNode!.parts).toEqual([
    expect.objectContaining({
      type: "attachment",
      attachmentId: persistedAttachment!.id,
      name: pastedFileName,
      mediaType: "image/png",
    }),
  ]);
  expect(persistedAttachment).toMatchObject({
    fileName: pastedFileName,
    mediaType: "image/png",
    size: screenshotBytes.length,
  });

  const storedContent = await request.get(`/api/attachments/${persistedAttachment!.id}/content`, { headers: apiHeaders });
  expect(storedContent.status(), await storedContent.text()).toBe(200);
  expect(Buffer.from(await storedContent.body())).toEqual(Buffer.from(screenshotBytes));

  const operatorMessage = page.locator(`[data-message-node-id="${persistedNode!.id}"]`);
  await operatorMessage.getByRole("button", { name: "Inspect request run" }).click();
  await expect(page.getByRole("tab", { name: "Run" })).toHaveAttribute("aria-selected", "true");
  await expect(page.locator(".run-status code")).toContainText(requestRun!.id.slice(0, 12));
});
