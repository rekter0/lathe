import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { createPersistence } from "@lathe/db";
import {
  emptyResolvedConfig,
  type JsonObject,
  type ProviderProtocol,
  type ResolvedConfig
} from "@lathe/domain";
import { createApp } from "../src/app.js";
import { EventHub } from "../src/events.js";
import { UnavailableRunCoordinator } from "../src/run-coordinator.js";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

const token = "branch-export-test-token";
const requestHeaders = { authorization: `Bearer ${token}` };
const imageBytes = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a]);
const imageBase64 = Buffer.from(imageBytes).toString("base64");

function currentConfig(protocol: ProviderProtocol): ResolvedConfig {
  const config = emptyResolvedConfig();
  config.promptBlocks = [
    { revisionId: "prompt-second", name: "Second", content: "Second current instruction.", enabled: true, order: 2 },
    { revisionId: "prompt-disabled", name: "Disabled", content: "MUST NOT EXPORT", enabled: false, order: 1 },
    { revisionId: "prompt-first", name: "First", content: "First current instruction.", enabled: true, order: 0 }
  ];
  config.tools = [
    {
      toolRevisionId: "lookup-current",
      implementationRevisionId: null,
      name: "lookup",
      description: "Look up a value",
      inputSchema: {
        type: "object",
        properties: { query: { type: "string" }, password: { type: "string" } },
        required: ["query"],
        additionalProperties: false
      },
      enabled: true,
      mode: "manual",
      targetId: null,
      mcpServerId: null
    },
    {
      toolRevisionId: "disabled-tool",
      implementationRevisionId: null,
      name: "disabled_lookup",
      description: "Must not export",
      inputSchema: { type: "object" },
      enabled: false,
      mode: "manual",
      targetId: null,
      mcpServerId: null
    }
  ];
  config.temperature = 0.25;
  config.maxOutputTokens = 321;
  config.protocolOverrides[protocol] = { metadata: { exported_by: "branch-test" } };
  return config;
}

async function createFixture(protocol: ProviderProtocol) {
  const dataDirectory = await mkdtemp(join(tmpdir(), `lathe-branch-export-${protocol}-`));
  directories.push(dataDirectory);
  const persistence = await createPersistence({ dataDirectory });
  const project = await persistence.repository.createProject({ name: "Export project" });
  const profile = await persistence.repository.createProviderProfile({
    label: `Fixture ${protocol}`,
    protocol,
    baseUrl: "https://fixture.invalid/v1",
    credential: "fixture-provider-secret",
    models: [{
      id: "fixture-model",
      label: "Fixture model",
      discovered: false,
      capabilities: {
        streaming: true,
        tools: true,
        images: true,
        files: true,
        jsonMode: false,
        maxContextTokens: null
      }
    }]
  });
  const { session, branch } = await persistence.repository.createSession({
    projectId: project.id,
    name: "Export session",
    providerProfileId: profile.id,
    modelId: "fixture-model",
    draftConfig: currentConfig(protocol)
  });

  const historicalConfig = emptyResolvedConfig();
  historicalConfig.promptBlocks = [{
    revisionId: "historical-prompt",
    name: "Historical",
    content: "Historical configuration must not win.",
    enabled: true,
    order: 0
  }];
  historicalConfig.temperature = 0.99;
  historicalConfig.maxOutputTokens = 9;
  const historicalSnapshot = await persistence.repository.createConfigSnapshot(session.id, historicalConfig);

  const storedImage = await persistence.contentStore.put(imageBytes);
  const attachment = await persistence.repository.saveAttachment({
    projectId: project.id,
    fileName: "pixel.png",
    mediaType: "image/png",
    size: storedImage.size,
    sha256: storedImage.sha256
  });
  const user = await persistence.repository.appendNode({
    sessionId: session.id,
    branchId: branch.id,
    parentId: null,
    role: "user",
    configSnapshotId: historicalSnapshot.id,
    parts: [
      { type: "text", text: "Shared operator turn" },
      { type: "attachment", attachmentId: attachment.id, name: attachment.fileName, mediaType: attachment.mediaType }
    ]
  });
  const assistant = await persistence.repository.appendNode({
    sessionId: session.id,
    branchId: branch.id,
    parentId: user.id,
    role: "assistant",
    configSnapshotId: historicalSnapshot.id,
    parts: [
      { type: "text", text: "Calling lookup now." },
      { type: "tool-call", callId: "call-1", name: "lookup", arguments: { query: "needle" } }
    ]
  });
  const tool = await persistence.repository.appendNode({
    sessionId: session.id,
    branchId: branch.id,
    parentId: assistant.id,
    role: "tool",
    configSnapshotId: historicalSnapshot.id,
    parts: [{
      type: "tool-result",
      callId: "call-1",
      name: "lookup",
      result: { value: "tool output", count: 2 },
      isError: false
    }]
  });
  await persistence.repository.appendNode({
    sessionId: session.id,
    branchId: branch.id,
    parentId: tool.id,
    role: "assistant",
    configSnapshotId: historicalSnapshot.id,
    parts: [{ type: "text", text: "Selected branch final answer." }]
  });

  const sibling = await persistence.repository.createBranch(session.id, "sibling", tool.id);
  await persistence.repository.appendNode({
    sessionId: session.id,
    branchId: sibling.id,
    parentId: tool.id,
    role: "user",
    parts: [{ type: "text", text: "SIBLING TURN MUST NOT EXPORT" }]
  });

  const app = createApp({
    repository: persistence.repository,
    contentStore: persistence.contentStore,
    events: new EventHub(),
    runCoordinator: new UnavailableRunCoordinator(),
    apiToken: token,
    dataDirectory
  });
  return { ...persistence, app, project, profile, session, branch, sibling };
}

const toolSchema: JsonObject = {
  type: "object",
  // A red-team schema may legitimately name a field "password"; export
  // redaction must preserve the schema while scrubbing known credential values.
  properties: { query: { type: "string" }, password: { type: "string" } },
  required: ["query"],
  additionalProperties: false
};

describe("branch API request export", () => {
  it.each([
    {
      protocol: "openai-chat" as const,
      expected: {
        metadata: { exported_by: "branch-test" },
        model: "fixture-model",
        messages: [
          { role: "system", content: "First current instruction.\n\nSecond current instruction." },
          {
            role: "user",
            content: [
              { type: "text", text: "Shared operator turn" },
              { type: "image_url", image_url: { url: `data:image/png;base64,${imageBase64}`, detail: "auto" } }
            ]
          },
          {
            role: "assistant",
            content: "Calling lookup now.",
            tool_calls: [{
              id: "call-1",
              type: "function",
              function: { name: "lookup", arguments: '{"query":"needle"}' }
            }]
          },
          { role: "tool", tool_call_id: "call-1", content: '{"value":"tool output","count":2}' },
          { role: "assistant", content: "Selected branch final answer." }
        ],
        stream: false,
        tools: [{
          type: "function",
          function: { name: "lookup", description: "Look up a value", parameters: toolSchema }
        }],
        temperature: 0.25,
        max_completion_tokens: 321
      }
    },
    {
      protocol: "openai-responses" as const,
      expected: {
        metadata: { exported_by: "branch-test" },
        model: "fixture-model",
        input: [
          {
            type: "message",
            role: "user",
            content: [
              { type: "input_text", text: "Shared operator turn" },
              { type: "input_image", image_url: `data:image/png;base64,${imageBase64}`, detail: "auto" }
            ]
          },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Calling lookup now." }]
          },
          { type: "function_call", call_id: "call-1", name: "lookup", arguments: '{"query":"needle"}' },
          { type: "function_call_output", call_id: "call-1", output: '{"value":"tool output","count":2}' },
          {
            type: "message",
            role: "assistant",
            content: [{ type: "output_text", text: "Selected branch final answer." }]
          }
        ],
        stream: false,
        instructions: "First current instruction.\n\nSecond current instruction.",
        tools: [{ name: "lookup", type: "function", description: "Look up a value", parameters: toolSchema }],
        temperature: 0.25,
        max_output_tokens: 321
      }
    },
    {
      protocol: "anthropic-messages" as const,
      expected: {
        metadata: { exported_by: "branch-test" },
        model: "fixture-model",
        messages: [
          {
            role: "user",
            content: [
              { type: "text", text: "Shared operator turn" },
              { type: "image", source: { type: "base64", media_type: "image/png", data: imageBase64 } }
            ]
          },
          {
            role: "assistant",
            content: [
              { type: "text", text: "Calling lookup now." },
              { type: "tool_use", id: "call-1", name: "lookup", input: { query: "needle" } }
            ]
          },
          {
            role: "user",
            content: [{
              type: "tool_result",
              tool_use_id: "call-1",
              content: '{"value":"tool output","count":2}',
              is_error: false
            }]
          },
          { role: "assistant", content: [{ type: "text", text: "Selected branch final answer." }] }
        ],
        stream: false,
        max_tokens: 321,
        system: "First current instruction.\n\nSecond current instruction.",
        tools: [{ name: "lookup", description: "Look up a value", input_schema: toolSchema }],
        temperature: 0.25
      }
    }
  ])("exports the selected branch as an exact $protocol request body", async ({ protocol, expected }) => {
    const fixture = await createFixture(protocol);
    try {
      const response = await fixture.app.request(
        `/api/sessions/${fixture.session.id}/branches/${fixture.branch.id}/export`,
        { headers: requestHeaders }
      );
      expect(response.status).toBe(200);
      expect(response.headers.get("content-type")).toBe("application/json; charset=utf-8");
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(response.headers.get("content-disposition")).toContain(`${protocol}.json`);
      const text = await response.text();
      expect(text.endsWith("\n")).toBe(true);
      expect(text).not.toContain("SIBLING TURN MUST NOT EXPORT");
      expect(text).not.toContain("Historical configuration must not win");
      expect(JSON.parse(text)).toEqual(expected);
    } finally {
      await fixture.repository.close();
    }
  });

  it("redacts every stored provider and secret value from the exported body", async () => {
    const fixture = await createFixture("openai-chat");
    try {
      const profile = await fixture.repository.createProviderProfile({
        label: "Secrets fixture",
        protocol: "openai-chat",
        baseUrl: "https://fixture.invalid/v1",
        credential: "credential-value-123",
        headers: { "x-private-header": "header-value-456" },
        extraBody: { custom_auth_token: "body-value-789", public_hint: "contains credential-value-123" },
        models: fixture.profile.models
      });
      const storedSecret = await fixture.repository.createSecret("Export secret", "repository-value-012");
      await fixture.repository.updateSessionModel(fixture.session.id, profile.id, "fixture-model");
      const branch = (await fixture.repository.listBranches(fixture.session.id)).find((item) => item.id === fixture.branch.id)!;
      await fixture.repository.appendNode({
        sessionId: fixture.session.id,
        branchId: fixture.branch.id,
        parentId: branch.headNodeId,
        role: "user",
        parts: [{
          type: "text",
          text: "credential-value-123 header-value-456 body-value-789 repository-value-012"
        }]
      });

      const response = await fixture.app.request(
        `/api/sessions/${fixture.session.id}/branches/${fixture.branch.id}/export`,
        { headers: requestHeaders }
      );
      expect(response.status).toBe(200);
      const text = await response.text();
      for (const secret of [profile.credential, ...Object.values(profile.headers), "body-value-789", await fixture.repository.resolveSecret(storedSecret.id)]) {
        expect(secret).toBeTruthy();
        expect(text).not.toContain(secret!);
      }
      expect(text).toContain("[REDACTED]");
      expect(text).toContain("<redacted>");
    } finally {
      await fixture.repository.close();
    }
  });

  it("rejects an inline attachment that contains stored credential material", async () => {
    const fixture = await createFixture("openai-chat");
    try {
      const bytes = Buffer.from(`fixture notes: ${fixture.profile.credential}`, "utf8");
      const stored = await fixture.contentStore.put(bytes);
      const attachment = await fixture.repository.saveAttachment({
        projectId: fixture.project.id,
        fileName: "credential.txt",
        mediaType: "text/plain",
        size: stored.size,
        sha256: stored.sha256
      });
      const selected = (await fixture.repository.listBranches(fixture.session.id)).find((item) => item.id === fixture.branch.id)!;
      await fixture.repository.appendNode({
        sessionId: fixture.session.id,
        branchId: fixture.branch.id,
        parentId: selected.headNodeId,
        role: "user",
        parts: [{ type: "attachment", attachmentId: attachment.id, name: attachment.fileName, mediaType: attachment.mediaType }]
      });

      const response = await fixture.app.request(
        `/api/sessions/${fixture.session.id}/branches/${fixture.branch.id}/export`,
        { headers: requestHeaders }
      );
      expect(response.status).toBe(409);
      const text = await response.text();
      expect(text).toContain("contains stored credential material");
      expect(text).not.toContain(fixture.profile.credential);
    } finally {
      await fixture.repository.close();
    }
  });

  it("returns 404 for an unknown session or a branch outside the selected session", async () => {
    const fixture = await createFixture("openai-chat");
    try {
      const missingSession = await fixture.app.request(
        `/api/sessions/missing-session/branches/${fixture.branch.id}/export`,
        { headers: requestHeaders }
      );
      expect(missingSession.status).toBe(404);
      expect(await missingSession.json()).toMatchObject({ error: { message: "Session not found" } });

      const otherSession = await fixture.repository.createSession({
        projectId: fixture.project.id,
        name: "Other session",
        providerProfileId: fixture.profile.id,
        modelId: "fixture-model"
      });
      const foreignBranch = await fixture.app.request(
        `/api/sessions/${fixture.session.id}/branches/${otherSession.branch.id}/export`,
        { headers: requestHeaders }
      );
      expect(foreignBranch.status).toBe(404);
      expect(await foreignBranch.json()).toMatchObject({ error: { message: "Branch not found in this session" } });
    } finally {
      await fixture.repository.close();
    }
  });

  it("encodes operator-controlled branch names safely in the download header", async () => {
    const fixture = await createFixture("openai-chat");
    try {
      const selected = (await fixture.repository.listBranches(fixture.session.id)).find((item) => item.id === fixture.branch.id)!;
      const named = await fixture.repository.createBranch(fixture.session.id, "../目标\"\r\nX-Evil: yes", selected.headNodeId);
      const response = await fixture.app.request(
        `/api/sessions/${fixture.session.id}/branches/${named.id}/export`,
        { headers: requestHeaders }
      );
      expect(response.status).toBe(200);
      const disposition = response.headers.get("content-disposition") ?? "";
      expect(disposition).toContain("filename*=UTF-8''");
      expect(disposition).toContain("%0D%0A");
      expect(disposition).not.toContain("\r");
      expect(disposition).not.toContain("\n");
      expect(response.headers.get("x-evil")).toBeNull();
    } finally {
      await fixture.repository.close();
    }
  });

  it("returns 409 when the session has no provider/model selection or an attachment blob is unavailable", async () => {
    const fixture = await createFixture("openai-chat");
    try {
      const unconfigured = await fixture.repository.createSession({ projectId: fixture.project.id, name: "Unconfigured" });
      const noProvider = await fixture.app.request(
        `/api/sessions/${unconfigured.session.id}/branches/${unconfigured.branch.id}/export`,
        { headers: requestHeaders }
      );
      expect(noProvider.status).toBe(409);
      expect(await noProvider.json()).toMatchObject({ error: { message: "Select a provider and model before exporting an API request" } });

      const missingAttachment = await fixture.repository.saveAttachment({
        projectId: fixture.project.id,
        fileName: "missing.txt",
        mediaType: "text/plain",
        size: 7,
        sha256: "0".repeat(64)
      });
      const selected = (await fixture.repository.listBranches(fixture.session.id)).find((item) => item.id === fixture.branch.id)!;
      await fixture.repository.appendNode({
        sessionId: fixture.session.id,
        branchId: fixture.branch.id,
        parentId: selected.headNodeId,
        role: "user",
        parts: [{
          type: "attachment",
          attachmentId: missingAttachment.id,
          name: missingAttachment.fileName,
          mediaType: missingAttachment.mediaType
        }]
      });
      const unavailableBlob = await fixture.app.request(
        `/api/sessions/${fixture.session.id}/branches/${fixture.branch.id}/export`,
        { headers: requestHeaders }
      );
      expect(unavailableBlob.status).toBe(409);
      expect(await unavailableBlob.json()).toMatchObject({ error: { message: "Branch attachment missing.txt is missing from the content store" } });
    } finally {
      await fixture.repository.close();
    }
  });

  it("returns 422 when the branch cannot be represented by the selected protocol", async () => {
    const fixture = await createFixture("anthropic-messages");
    try {
      const selected = (await fixture.repository.listBranches(fixture.session.id)).find((item) => item.id === fixture.branch.id)!;
      await fixture.repository.appendNode({
        sessionId: fixture.session.id,
        branchId: fixture.branch.id,
        parentId: selected.headNodeId,
        role: "assistant",
        parts: [{ type: "tool-call", callId: "invalid-call", name: "lookup", arguments: "not-json" }]
      });
      const response = await fixture.app.request(
        `/api/sessions/${fixture.session.id}/branches/${fixture.branch.id}/export`,
        { headers: requestHeaders }
      );
      expect(response.status).toBe(422);
      expect(await response.json()).toMatchObject({
        error: { message: expect.stringContaining("Anthropic tool call invalid-call has arguments that are not valid JSON") }
      });
    } finally {
      await fixture.repository.close();
    }
  });
});
