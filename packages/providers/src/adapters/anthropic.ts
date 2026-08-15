import {
  assertExclusiveLocation,
  classifyProviderError,
  errorEvent,
  isRecord,
  makeCompiledRequest,
  mergeExtraBody,
  numberValue,
  serializeArguments,
  stringValue,
  textFromContent,
  usageFrom,
} from "../shared.js";
import { ProviderCompileError } from "../types.js";
import type {
  CanonicalContent,
  CanonicalGenerationRequest,
  CompileWarning,
  JsonObject,
  JsonValue,
  NormalizedProviderEvent,
  ProtocolAdapter,
  ProviderProfile,
  ServerSentEvent,
} from "../types.js";

const PROTECTED = new Set([
  "model",
  "messages",
  "system",
  "tools",
  "tool_choice",
  "stream",
  "max_tokens",
]);

function anthropicParts(content: CanonicalContent): JsonValue[] {
  if (typeof content === "string") return content === "" ? [] : [{ type: "text", text: content }];
  return content.map((part): JsonValue => {
    if (part.type === "text") return { type: "text", text: part.text };
    const location = assertExclusiveLocation(part);
    const type = part.type === "image" ? "image" : "document";
    const source =
      location === "url"
        ? { type: "url", url: part.url! }
        : { type: "base64", media_type: part.mediaType, data: part.data! };
    return part.type === "file"
      ? { type, source, title: part.name }
      : { type, source };
  });
}

function pushMessage(messages: JsonObject[], role: "user" | "assistant", content: JsonValue[]): void {
  const previous = messages.at(-1);
  if (previous?.role === role && Array.isArray(previous.content)) {
    previous.content.push(...content);
  } else {
    messages.push({ role, content });
  }
}

function messages(request: CanonicalGenerationRequest): JsonValue[] {
  const result: JsonObject[] = [];
  for (const message of request.messages) {
    if (message.role === "tool") {
      if (message.toolCallId === undefined) {
        throw new ProviderCompileError("unsupported-content", "A tool result message requires toolCallId.");
      }
      pushMessage(result, "user", [{
        type: "tool_result",
        tool_use_id: message.toolCallId,
        content: textFromContent(message.content),
        ...(message.isError === undefined ? {} : { is_error: message.isError }),
      }]);
      continue;
    }
    const parts = anthropicParts(message.content);
    if (message.role === "assistant") {
      for (const call of message.toolCalls ?? []) {
        parts.push({
          type: "tool_use",
          id: call.id,
          name: call.name,
          input:
            typeof call.arguments === "string"
              ? (() => {
                  try {
                    return JSON.parse(call.arguments) as JsonValue;
                  } catch {
                    throw new ProviderCompileError(
                      "unsupported-content",
                      `Anthropic tool call ${call.id} has arguments that are not valid JSON.`,
                    );
                  }
                })()
              : call.arguments,
        });
      }
    }
    pushMessage(result, message.role, parts);
  }
  return result;
}

function contentEvents(payload: Record<string, unknown>): NormalizedProviderEvent[] {
  const events: NormalizedProviderEvent[] = [];
  const content = Array.isArray(payload.content) ? payload.content : [];
  for (let index = 0; index < content.length; index += 1) {
    const block = content[index];
    if (!isRecord(block)) continue;
    if (block.type === "text" && typeof block.text === "string") {
      events.push({ type: "content.delta", text: block.text, index });
    } else if (block.type === "thinking" && typeof block.thinking === "string") {
      events.push({ type: "reasoning.delta", text: block.thinking, index });
    } else if (block.type === "tool_use") {
      const id = stringValue(block.id);
      const name = stringValue(block.name);
      events.push({
        type: "tool_call.start",
        index,
        ...(id === undefined ? {} : { id }),
        ...(name === undefined ? {} : { name }),
      });
      events.push({
        type: "tool_call.delta",
        index,
        ...(id === undefined ? {} : { id }),
        ...(name === undefined ? {} : { name }),
        argumentsDelta: serializeArguments((block.input ?? {}) as JsonValue),
      });
    }
  }
  const usage = usageFrom(payload.usage);
  if (usage !== undefined) events.push({ type: "usage", usage });
  const finishReason = stringValue(payload.stop_reason);
  events.push({ type: "response.completed", ...(finishReason === undefined ? {} : { finishReason }) });
  return events;
}

export const anthropicMessagesAdapter: ProtocolAdapter = {
  protocol: "anthropic-messages",
  defaultGeneratePath: "/v1/messages",
  defaultModelsPath: "/v1/models",
  protectedBodyFields: PROTECTED,

  compile(profile: ProviderProfile, request: CanonicalGenerationRequest) {
    const body = mergeExtraBody(PROTECTED, profile.extraBody, request.extraBody);
    const warnings: CompileWarning[] = [];
    body.model = request.model;
    body.messages = messages(request);
    body.stream = request.stream ?? true;
    body.max_tokens = request.maxOutputTokens ?? 4_096;
    if (request.maxOutputTokens === undefined) {
      warnings.push({
        code: "default-max-tokens",
        message: "Anthropic requires max_tokens; Lathe used 4096 because no value was configured.",
      });
    }
    if (request.systemPrompt !== undefined && request.systemPrompt !== "") body.system = request.systemPrompt;
    if (request.toolChoice === "none") {
      if (request.tools !== undefined && request.tools.length > 0) {
        warnings.push({
          code: "unsupported-tool-choice",
          message: "Anthropic has no tool_choice=none; tools were omitted for this request.",
        });
      }
    } else if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        name: tool.name,
        description: tool.description ?? "",
        input_schema: tool.inputSchema,
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      }));
      if (request.toolChoice !== undefined) {
        body.tool_choice =
          request.toolChoice === "required"
            ? { type: "any" }
            : request.toolChoice === "auto"
              ? { type: "auto" }
              : { type: "tool", name: request.toolChoice.name };
      }
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.stopSequences !== undefined) body.stop_sequences = [...request.stopSequences];
    return makeCompiledRequest(
      profile,
      this.protocol,
      this.defaultGeneratePath,
      request,
      body,
      warnings,
    );
  },

  normalizeSse(event: ServerSentEvent): readonly NormalizedProviderEvent[] {
    let payload: JsonValue;
    try {
      payload = JSON.parse(event.data) as JsonValue;
    } catch (cause) {
      return [errorEvent(classifyProviderError({ cause, payload: event.data, fallback: "parse-failure" }))];
    }
    if (!isRecord(payload)) return [{ type: "provider.unknown", ...(event.event === undefined ? {} : { providerType: event.event }) }];
    const type = stringValue(payload.type) ?? event.event;
    if (type === "error" || isRecord(payload.error)) {
      return [errorEvent(classifyProviderError({ payload }))];
    }
    if (type === "message_start" && isRecord(payload.message)) {
      const usage = usageFrom(payload.message.usage);
      const id = stringValue(payload.message.id);
      const model = stringValue(payload.message.model);
      return [
        {
          type: "response.start",
          ...(id === undefined ? {} : { responseId: id }),
          ...(model === undefined ? {} : { model }),
        },
        ...(usage === undefined ? [] : [{ type: "usage" as const, usage }]),
      ];
    }
    const index = numberValue(payload.index) ?? 0;
    if (type === "content_block_start" && isRecord(payload.content_block)) {
      const block = payload.content_block;
      if (block.type === "tool_use") {
        const id = stringValue(block.id);
        const name = stringValue(block.name);
        return [{
          type: "tool_call.start",
          index,
          ...(id === undefined ? {} : { id }),
          ...(name === undefined ? {} : { name }),
        }];
      }
      if (block.type === "text" && typeof block.text === "string" && block.text !== "") {
        return [{ type: "content.delta", text: block.text, index }];
      }
    }
    if (type === "content_block_delta" && isRecord(payload.delta)) {
      const delta = payload.delta;
      if (delta.type === "text_delta") {
        return [{ type: "content.delta", text: stringValue(delta.text) ?? "", index }];
      }
      if (delta.type === "thinking_delta") {
        return [{ type: "reasoning.delta", text: stringValue(delta.thinking) ?? "", index }];
      }
      if (delta.type === "input_json_delta") {
        return [{
          type: "tool_call.delta",
          index,
          argumentsDelta: stringValue(delta.partial_json) ?? "",
        }];
      }
    }
    if (type === "message_delta") {
      const delta = isRecord(payload.delta) ? payload.delta : undefined;
      const usage = usageFrom(payload.usage);
      return [
        ...(usage === undefined ? [] : [{ type: "usage" as const, usage }]),
        ...(
          delta === undefined || stringValue(delta.stop_reason) === undefined
            ? []
            : [{ type: "response.completed" as const, finishReason: stringValue(delta.stop_reason)! }]
        ),
      ];
    }
    if (type === "message_stop") return [{ type: "response.completed" }];
    return [{ type: "provider.unknown", ...(type === undefined ? {} : { providerType: type }) }];
  },

  normalizeJson(payload: JsonValue): readonly NormalizedProviderEvent[] {
    if (!isRecord(payload)) return [errorEvent(classifyProviderError({ payload, fallback: "parse-failure" }))];
    if (isRecord(payload.error) || payload.type === "error") {
      return [errorEvent(classifyProviderError({ payload }))];
    }
    const id = stringValue(payload.id);
    const model = stringValue(payload.model);
    return [
      {
        type: "response.start",
        ...(id === undefined ? {} : { responseId: id }),
        ...(model === undefined ? {} : { model }),
      },
      ...contentEvents(payload),
    ];
  },
};
