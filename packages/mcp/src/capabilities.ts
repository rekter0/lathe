import { createHash } from "node:crypto";
import type {
  JsonValue,
  McpCapabilitySnapshot,
  McpPromptSnapshot,
  McpResourceSnapshot,
  McpResourceTemplateSnapshot,
  McpToolSnapshot,
} from "./types.js";
import { redactJson } from "./redaction.js";

export interface CapabilityClient {
  getServerVersion(): unknown;
  getServerCapabilities(): unknown;
  getInstructions(): string | undefined;
  getNegotiatedProtocolVersion?(): string | undefined;
  listTools(params?: { cursor?: string }): Promise<unknown>;
  listPrompts(params?: { cursor?: string }): Promise<unknown>;
  listResources(params?: { cursor?: string }): Promise<unknown>;
  listResourceTemplates(params?: { cursor?: string }): Promise<unknown>;
}

function asRecord(input: unknown): Record<string, unknown> {
  return input !== null && typeof input === "object" && !Array.isArray(input)
    ? (input as Record<string, unknown>)
    : {};
}

async function collectPages(
  load: (params?: { cursor?: string }) => Promise<unknown>,
  key: string,
): Promise<unknown[]> {
  const output: unknown[] = [];
  const seen = new Set<string>();
  let cursor: string | undefined;

  do {
    const result = asRecord(await load(cursor === undefined ? undefined : { cursor }));
    const page = result[key];
    if (Array.isArray(page)) output.push(...page);
    const nextCursor = asRecord(result._meta).nextCursor ?? result.nextCursor;
    cursor = typeof nextCursor === "string" && nextCursor.length > 0 ? nextCursor : undefined;
    if (cursor && seen.has(cursor)) throw new Error(`MCP ${key} pagination returned a repeated cursor`);
    if (cursor) seen.add(cursor);
  } while (cursor);

  return output;
}

function optionalString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  return typeof value === "string" ? value : undefined;
}

function toolSnapshot(input: unknown): McpToolSnapshot {
  const tool = asRecord(input);
  if (typeof tool.name !== "string" || tool.name.length === 0) {
    throw new Error("MCP server returned a tool without a name");
  }
  const description = optionalString(tool, "description");
  return {
    name: tool.name,
    ...(description === undefined ? {} : { description }),
    inputSchema: redactJson(tool.inputSchema ?? {}),
    ...(tool.outputSchema === undefined ? {} : { outputSchema: redactJson(tool.outputSchema) }),
    ...(tool.annotations === undefined ? {} : { annotations: redactJson(tool.annotations) }),
  };
}

function promptSnapshot(input: unknown): McpPromptSnapshot {
  const prompt = asRecord(input);
  if (typeof prompt.name !== "string" || prompt.name.length === 0) {
    throw new Error("MCP server returned a prompt without a name");
  }
  const description = optionalString(prompt, "description");
  return {
    name: prompt.name,
    ...(description === undefined ? {} : { description }),
    ...(prompt.arguments === undefined ? {} : { arguments: redactJson(prompt.arguments) }),
  };
}

function resourceSnapshot(input: unknown): McpResourceSnapshot {
  const resource = asRecord(input);
  if (typeof resource.uri !== "string" || typeof resource.name !== "string") {
    throw new Error("MCP server returned an invalid resource descriptor");
  }
  const description = optionalString(resource, "description");
  const mimeType = optionalString(resource, "mimeType");
  return {
    uri: resource.uri,
    name: resource.name,
    ...(description === undefined ? {} : { description }),
    ...(mimeType === undefined ? {} : { mimeType }),
  };
}

function templateSnapshot(input: unknown): McpResourceTemplateSnapshot {
  const template = asRecord(input);
  if (typeof template.uriTemplate !== "string" || typeof template.name !== "string") {
    throw new Error("MCP server returned an invalid resource template descriptor");
  }
  const description = optionalString(template, "description");
  const mimeType = optionalString(template, "mimeType");
  return {
    uriTemplate: template.uriTemplate,
    name: template.name,
    ...(description === undefined ? {} : { description }),
    ...(mimeType === undefined ? {} : { mimeType }),
  };
}

function canonicalJson(input: JsonValue): string {
  if (input === null || typeof input !== "object") return JSON.stringify(input);
  if (Array.isArray(input)) return `[${input.map(canonicalJson).join(",")}]`;
  const pairs = Object.entries(input)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, value]) => `${JSON.stringify(key)}:${canonicalJson(value)}`);
  return `{${pairs.join(",")}}`;
}

export async function captureCapabilitySnapshot(
  client: CapabilityClient,
  identity: {
    profileId: string;
    profileRevision: string;
    protocolVersion?: string;
    /** Resolved transport secrets are used only for redaction and are never retained. */
    secretValues?: readonly string[];
  },
  now: () => Date = () => new Date(),
): Promise<McpCapabilitySnapshot> {
  const secrets = identity.secretValues ?? [];
  const rawCapabilities = asRecord(client.getServerCapabilities());
  const declared = redactJson(rawCapabilities, secrets);
  const server = client.getServerVersion();
  const protocolVersion = identity.protocolVersion ?? client.getNegotiatedProtocolVersion?.();
  const instructions = client.getInstructions();
  const [tools, prompts, resources, resourceTemplates] = await Promise.all([
    rawCapabilities.tools === undefined
      ? Promise.resolve([])
      : collectPages((params) => client.listTools(params), "tools"),
    rawCapabilities.prompts === undefined
      ? Promise.resolve([])
      : collectPages((params) => client.listPrompts(params), "prompts"),
    rawCapabilities.resources === undefined
      ? Promise.resolve([])
      : collectPages((params) => client.listResources(params), "resources"),
    rawCapabilities.resources === undefined
      ? Promise.resolve([])
      : collectPages((params) => client.listResourceTemplates(params), "resourceTemplates"),
  ]);

  const withoutHash = {
    capturedAt: now().toISOString(),
    profileId: identity.profileId,
    profileRevision: identity.profileRevision,
    ...(protocolVersion === undefined ? {} : { protocolVersion }),
    ...(server === undefined ? {} : { server: redactJson(server, secrets) }),
    ...(instructions === undefined
      ? {}
      : { instructions: redactJson(instructions, secrets) as string }),
    declared,
    tools: tools
      .map((tool) => toolSnapshot(redactJson(tool, secrets)))
      .sort((left, right) => left.name.localeCompare(right.name)),
    prompts: prompts
      .map((prompt) => promptSnapshot(redactJson(prompt, secrets)))
      .sort((left, right) => left.name.localeCompare(right.name)),
    resources: resources
      .map((resource) => redactJson(resource, secrets))
      .map(resourceSnapshot)
      .sort((left, right) => left.uri.localeCompare(right.uri)),
    resourceTemplates: resourceTemplates
      .map((template) => redactJson(template, secrets))
      .map(templateSnapshot)
      .sort((left, right) => left.uriTemplate.localeCompare(right.uriTemplate)),
  } satisfies Omit<McpCapabilitySnapshot, "sha256">;

  const sha256 = createHash("sha256")
    .update(canonicalJson(redactJson(withoutHash)))
    .digest("hex");
  return { ...withoutHash, sha256 };
}
