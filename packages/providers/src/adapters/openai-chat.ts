import {
  assertExclusiveLocation,
  classifyProviderError,
  errorEvent,
  isRecord,
  makeCompiledRequest,
  mergeExtraBody,
  numberValue,
  serializeArguments,
  stopDetailsFrom,
  stringValue,
  textFromContent,
  usageFrom,
} from "../shared.js";
import { ProviderCompileError } from "../types.js";
import type {
  CanonicalContent,
  CanonicalGenerationRequest,
  JsonObject,
  JsonValue,
  NormalizedProviderEvent,
  ProtocolAdapter,
  ProviderProfile,
  ServerSentEvent,
} from "../types.js";

const PROTECTED = new Set(["model", "messages", "tools", "tool_choice", "stream"]);

function chatContent(content: CanonicalContent): JsonValue {
  if (typeof content === "string") return content;
  return content.map((part): JsonValue => {
    if (part.type === "text") return { type: "text", text: part.text };
    const location = assertExclusiveLocation(part);
    if (part.type === "image") {
      const url = location === "url" ? part.url! : `data:${part.mediaType};base64,${part.data!}`;
      return { type: "image_url", image_url: { url, detail: "auto" } };
    }
    if (location === "url") {
      throw new ProviderCompileError(
        "unsupported-content",
        "Chat Completions file parts require file data; URL file attachments are not portable.",
      );
    }
    return { type: "file", file: { filename: part.name, file_data: part.data! } };
  });
}

function messages(request: CanonicalGenerationRequest): JsonValue[] {
  const result: JsonValue[] = [];
  if (request.systemPrompt !== undefined && request.systemPrompt !== "") {
    result.push({ role: "system", content: request.systemPrompt });
  }
  for (const message of request.messages) {
    if (message.role === "tool") {
      if (message.toolCallId === undefined) {
        throw new ProviderCompileError("unsupported-content", "A tool result message requires toolCallId.");
      }
      result.push({ role: "tool", tool_call_id: message.toolCallId, content: textFromContent(message.content) });
      continue;
    }
    const item: JsonObject = { role: message.role, content: chatContent(message.content) };
    if (message.role === "assistant" && message.toolCalls !== undefined && message.toolCalls.length > 0) {
      item.tool_calls = message.toolCalls.map((call) => ({
        id: call.id,
        type: "function",
        function: { name: call.name, arguments: serializeArguments(call.arguments) },
      }));
    }
    result.push(item);
  }
  return result;
}

function contentAndRefusalEvents(
  value: unknown,
  index: number,
): NormalizedProviderEvent[] {
  if (typeof value === "string") {
    return value === "" ? [] : [{ type: "content.delta", text: value, index }];
  }
  if (!Array.isArray(value)) return [];
  const events: NormalizedProviderEvent[] = [];
  for (const part of value) {
    if (!isRecord(part)) continue;
    if ((part.type === "text" || part.type === "output_text") && typeof part.text === "string" && part.text !== "") {
      events.push({ type: "content.delta", text: part.text, index });
    }
    if (part.type === "refusal") {
      const refusal = stringValue(part.refusal) ?? stringValue(part.text);
      if (refusal) events.push({ type: "refusal.done", text: refusal, index });
    }
  }
  return events;
}

function reasoningEvents(delta: Record<string, unknown>, index: number): NormalizedProviderEvent[] {
  const direct = stringValue(delta.reasoning) ?? stringValue(delta.reasoning_content);
  if (direct) return [{ type: "reasoning.delta", text: direct, index }];
  if (!Array.isArray(delta.reasoning_details)) return [];
  const events: NormalizedProviderEvent[] = [];
  for (const detail of delta.reasoning_details) {
    if (!isRecord(detail)) continue;
    const text = detail.type === "reasoning.summary"
      ? stringValue(detail.summary)
      : detail.type === "reasoning.text"
        ? stringValue(detail.text)
        : undefined;
    if (text) events.push({ type: "reasoning.delta", text, index });
  }
  return events;
}

function choiceEvents(payload: Record<string, unknown>): NormalizedProviderEvent[] {
  const events: NormalizedProviderEvent[] = [];
  const choices = Array.isArray(payload.choices) ? payload.choices : [];
  for (const choice of choices) {
    if (!isRecord(choice)) continue;
    const index = numberValue(choice.index) ?? 0;
    const delta = isRecord(choice.delta) ? choice.delta : isRecord(choice.message) ? choice.message : undefined;
    if (delta !== undefined) {
      events.push(...contentAndRefusalEvents(delta.content, index));
      events.push(...reasoningEvents(delta, index));
      const refusal = stringValue(delta.refusal);
      if (refusal) events.push({ type: "refusal.delta", text: refusal, index });
      if (Array.isArray(delta.tool_calls)) {
        for (const tool of delta.tool_calls) {
          if (!isRecord(tool)) continue;
          const toolIndex = numberValue(tool.index) ?? 0;
          const fn = isRecord(tool.function) ? tool.function : undefined;
          const id = stringValue(tool.id);
          const name = fn === undefined ? undefined : stringValue(fn.name);
          if (id !== undefined || name !== undefined) {
            events.push({
              type: "tool_call.start",
              index: toolIndex,
              ...(id === undefined ? {} : { id }),
              ...(name === undefined ? {} : { name }),
            });
          }
          const argumentsDelta = fn === undefined ? undefined : stringValue(fn.arguments);
          if (argumentsDelta !== undefined) {
            events.push({
              type: "tool_call.delta",
              index: toolIndex,
              ...(id === undefined ? {} : { id }),
              ...(name === undefined ? {} : { name }),
              argumentsDelta,
            });
          }
        }
      }
    }
    if (isRecord(choice.error)) {
      events.push(errorEvent(classifyProviderError({ payload: { error: choice.error } })));
    }
    const finishReason = stringValue(choice.finish_reason);
    const nativeFinishReason = stringValue(choice.native_finish_reason);
    const stopDetails = stopDetailsFrom(choice.stop_details);
    if (finishReason !== undefined || nativeFinishReason !== undefined || stopDetails !== undefined) {
      events.push({
        type: "response.completed",
        ...(finishReason === undefined ? {} : { finishReason }),
        ...(nativeFinishReason === undefined ? {} : { nativeFinishReason }),
        ...(stopDetails === undefined ? {} : { stopDetails }),
      });
    }
  }
  const usage = usageFrom(payload.usage);
  if (usage !== undefined) events.push({ type: "usage", usage });
  return events;
}

export const openAiChatAdapter: ProtocolAdapter = {
  protocol: "openai-chat",
  defaultGeneratePath: "/v1/chat/completions",
  defaultModelsPath: "/v1/models",
  protectedBodyFields: PROTECTED,

  compile(profile: ProviderProfile, request: CanonicalGenerationRequest) {
    const body = mergeExtraBody(PROTECTED, profile.extraBody, request.extraBody);
    body.model = request.model;
    body.messages = messages(request);
    body.stream = request.stream ?? true;
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        function: {
          name: tool.name,
          description: tool.description ?? "",
          parameters: tool.inputSchema,
          ...(tool.strict === undefined ? {} : { strict: tool.strict }),
        },
      }));
    }
    if (request.toolChoice !== undefined) {
      body.tool_choice =
        typeof request.toolChoice === "string"
          ? request.toolChoice
          : { type: "function", function: { name: request.toolChoice.name } };
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.maxOutputTokens !== undefined) body.max_completion_tokens = request.maxOutputTokens;
    if (request.stopSequences !== undefined) body.stop = [...request.stopSequences];
    return makeCompiledRequest(profile, this.protocol, this.defaultGeneratePath, request, body);
  },

  normalizeSse(event: ServerSentEvent): readonly NormalizedProviderEvent[] {
    if (event.data === "[DONE]") return [{ type: "response.completed" }];
    let payload: JsonValue;
    try {
      payload = JSON.parse(event.data) as JsonValue;
    } catch (cause) {
      return [errorEvent(classifyProviderError({ cause, payload: event.data, fallback: "parse-failure" }))];
    }
    if (!isRecord(payload)) return [{ type: "provider.unknown", ...(event.event === undefined ? {} : { providerType: event.event }) }];
    if (isRecord(payload.error)) return [errorEvent(classifyProviderError({ payload })), ...choiceEvents(payload)];
    const events = choiceEvents(payload);
    if (events.length > 0) return events;
    const id = stringValue(payload.id);
    const model = stringValue(payload.model);
    if (id !== undefined || model !== undefined) {
      return [{
        type: "response.start",
        ...(id === undefined ? {} : { responseId: id }),
        ...(model === undefined ? {} : { model }),
      }];
    }
    return [{ type: "provider.unknown", ...(event.event === undefined ? {} : { providerType: event.event }) }];
  },

  normalizeJson(payload: JsonValue): readonly NormalizedProviderEvent[] {
    if (!isRecord(payload)) return [errorEvent(classifyProviderError({ payload, fallback: "parse-failure" }))];
    if (isRecord(payload.error)) return [errorEvent(classifyProviderError({ payload })), ...choiceEvents(payload)];
    const id = stringValue(payload.id);
    const model = stringValue(payload.model);
    return [
      {
        type: "response.start",
        ...(id === undefined ? {} : { responseId: id }),
        ...(model === undefined ? {} : { model }),
      },
      ...choiceEvents(payload),
    ];
  },
};
