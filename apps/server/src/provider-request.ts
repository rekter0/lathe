import {
  compileSystemPrompt,
  type JsonObject,
  type MessageNode,
  type ProviderProfile,
  type ResolvedConfig,
  type ToolCallPart
} from "@lathe/domain";
import type { ContentStore, LatheRepository } from "@lathe/db";
import {
  redactHeaders,
  redactJson,
  redactUrl,
  providerSecretValues,
  type CanonicalContentPart,
  type CanonicalGenerationRequest,
  type CanonicalMessage,
  type CanonicalToolCall,
  type ProviderProfile as TransportProviderProfile
} from "@lathe/providers";

export function resolvedProviderConfig(
  profile: ProviderProfile,
  modelId: string,
  config: ResolvedConfig,
  redactionEnabled = true,
): ResolvedConfig {
  const knownSecrets = providerSecretValues(profile);
  const headers = redactHeaders(profile.headers, knownSecrets, redactionEnabled);
  const model = profile.models.find((entry) => entry.id === modelId);
  return {
    ...structuredClone(config),
    toolApprovalMode: config.toolApprovalMode ?? "manual",
    provider: {
      profileId: profile.id,
      profileRevision: profile.revision,
      protocol: profile.protocol,
      label: profile.label,
      baseUrl: redactUrl(profile.baseUrl, knownSecrets, redactionEnabled),
      endpointOverride: profile.endpointOverride === null
        ? null
        : redactUrl(profile.endpointOverride, knownSecrets, redactionEnabled),
      modelId,
      headers,
      extraBody: redactJson(profile.extraBody, knownSecrets, redactionEnabled) as JsonObject,
      capabilities: model?.capabilities ?? {
        streaming: true,
        tools: true,
        images: false,
        files: false,
        jsonMode: false,
        maxContextTokens: null
      }
    }
  };
}

export function transportProviderProfile(profile: ProviderProfile): TransportProviderProfile {
  return {
    id: profile.id,
    label: profile.label,
    protocol: profile.protocol,
    baseUrl: profile.baseUrl,
    credential: profile.credential,
    headers: profile.headers,
    extraBody: profile.extraBody,
    endpointOverride: profile.endpointOverride,
    models: profile.models
  };
}

async function canonicalContent(
  repository: LatheRepository,
  contentStore: ContentStore,
  node: MessageNode,
  config: ResolvedConfig
): Promise<string | CanonicalContentPart[]> {
  const parts: CanonicalContentPart[] = [];
  for (const part of node.parts) {
    if (part.type === "text") parts.push({ type: "text", text: part.text });
    if (part.type === "attachment") {
      const attachment = await repository.getAttachment(part.attachmentId);
      if (!attachment) continue;
      const bytes = await contentStore.get(attachment.sha256);
      const data = bytes.toString("base64");
      if (attachment.mediaType.startsWith("image/") && config.provider?.capabilities.images) {
        parts.push({ type: "image", mediaType: attachment.mediaType, data });
      } else if (config.provider?.capabilities.files) {
        parts.push({ type: "file", name: attachment.fileName, mediaType: attachment.mediaType, data });
      } else {
        parts.push({ type: "text", text: `[Stored attachment not supported by this model: ${attachment.fileName} (${attachment.mediaType}, sha256:${attachment.sha256})]` });
      }
    }
  }
  return parts.length === 1 && parts[0]?.type === "text" ? parts[0].text : parts;
}

export async function canonicalMessages(
  repository: LatheRepository,
  contentStore: ContentStore,
  nodes: readonly MessageNode[],
  config: ResolvedConfig
): Promise<CanonicalMessage[]> {
  const messages: CanonicalMessage[] = [];
  for (const node of nodes) {
    if (node.role === "tool") {
      for (const part of node.parts) {
        if (part.type !== "tool-result") continue;
        messages.push({ role: "tool", content: JSON.stringify(part.result), toolCallId: part.callId, isError: part.isError });
      }
      continue;
    }
    const toolCalls: CanonicalToolCall[] = node.parts
      .filter((part): part is ToolCallPart => part.type === "tool-call")
      .map((part) => ({ id: part.callId, name: part.name, arguments: part.arguments }));
    messages.push({
      id: node.id,
      role: node.role,
      content: await canonicalContent(repository, contentStore, node, config),
      ...(toolCalls.length > 0 ? { toolCalls } : {})
    });
  }
  return messages;
}

export async function buildCanonicalGenerationRequest(
  repository: LatheRepository,
  contentStore: ContentStore,
  nodes: readonly MessageNode[],
  config: ResolvedConfig,
  profile: ProviderProfile,
  stream: boolean
): Promise<CanonicalGenerationRequest> {
  return {
    model: config.provider?.modelId ?? "",
    messages: await canonicalMessages(repository, contentStore, nodes, config),
    systemPrompt: compileSystemPrompt(config.promptBlocks),
    tools: config.tools
      .filter((tool) => tool.enabled)
      .map((tool) => ({ name: tool.name, description: tool.description, inputSchema: tool.inputSchema })),
    stream,
    ...(config.temperature === null ? {} : { temperature: config.temperature }),
    ...(config.maxOutputTokens === null ? {} : { maxOutputTokens: config.maxOutputTokens }),
    extraBody: config.protocolOverrides[profile.protocol] ?? {}
  };
}
