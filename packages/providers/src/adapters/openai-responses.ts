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
  CanonicalMessage,
  JsonObject,
  JsonValue,
  NormalizedProviderEvent,
  ProtocolAdapter,
  ProviderProfile,
  ServerSentEvent,
} from "../types.js";

const PROTECTED = new Set(["model", "input", "instructions", "tools", "tool_choice", "stream"]);

function contentParts(content: CanonicalContent, role: CanonicalMessage["role"]): JsonValue[] {
  if (typeof content === "string") {
    return content === "" ? [] : [{ type: role === "assistant" ? "output_text" : "input_text", text: content }];
  }

  return content.map((part): JsonValue => {
    if (part.type === "text") {
      return { type: role === "assistant" ? "output_text" : "input_text", text: part.text };
    }
    if (role === "assistant") {
      throw new ProviderCompileError(
        "unsupported-content",
        "OpenAI Responses does not accept assistant image/file history parts.",
      );
    }
    const location = assertExclusiveLocation(part);
    if (part.type === "image") {
      const imageUrl =
        location === "url" ? part.url! : `data:${part.mediaType};base64,${part.data!}`;
      return { type: "input_image", image_url: imageUrl, detail: "auto" };
    }
    return location === "url"
      ? { type: "input_file", file_url: part.url!, filename: part.name }
      : { type: "input_file", file_data: part.data!, filename: part.name };
  });
}

function inputItems(messages: readonly CanonicalMessage[]): JsonValue[] {
  const input: JsonValue[] = [];
  for (const message of messages) {
    if (message.role === "tool") {
      if (message.toolCallId === undefined) {
        throw new ProviderCompileError("unsupported-content", "A tool result message requires toolCallId.");
      }
      input.push({
        type: "function_call_output",
        call_id: message.toolCallId,
        output: textFromContent(message.content),
      });
      continue;
    }

    const content = contentParts(message.content, message.role);
    if (content.length > 0) input.push({ type: "message", role: message.role, content });
    for (const call of message.toolCalls ?? []) {
      input.push({
        type: "function_call",
        call_id: call.id,
        name: call.name,
        arguments: serializeArguments(call.arguments),
      });
    }
  }
  return input;
}

function parsePayload(event: ServerSentEvent): JsonValue | undefined {
  if (event.data === "[DONE]") return undefined;
  return JSON.parse(event.data) as JsonValue;
}

function completionEvents(
  response: Record<string, unknown>,
  includeOutput = true,
): NormalizedProviderEvent[] {
  const events: NormalizedProviderEvent[] = [];
  const output = includeOutput && Array.isArray(response.output) ? response.output : [];
  for (let outputIndex = 0; outputIndex < output.length; outputIndex += 1) {
    const item = output[outputIndex];
    if (!isRecord(item)) continue;
    if (item.type === "message" && Array.isArray(item.content)) {
      for (const part of item.content) {
        if (!isRecord(part)) continue;
        if (part.type === "output_text" && typeof part.text === "string") {
          events.push({ type: "content.delta", text: part.text, index: outputIndex });
        } else if (part.type === "refusal") {
          const refusal = stringValue(part.refusal) ?? stringValue(part.text);
          if (refusal) events.push({ type: "refusal.done", text: refusal, index: outputIndex });
        } else if (part.type === "reasoning_text" && typeof part.text === "string") {
          events.push({ type: "reasoning.delta", text: part.text, index: outputIndex });
        }
      }
    } else if (item.type === "reasoning") {
      for (const summary of Array.isArray(item.summary) ? item.summary : []) {
        if (isRecord(summary) && typeof summary.text === "string") {
          events.push({ type: "reasoning.delta", text: summary.text, index: outputIndex });
        }
      }
      for (const part of Array.isArray(item.content) ? item.content : []) {
        if (isRecord(part) && part.type === "reasoning_text" && typeof part.text === "string") {
          events.push({ type: "reasoning.delta", text: part.text, index: outputIndex });
        }
      }
    } else if (item.type === "function_call") {
      const id = stringValue(item.call_id) ?? stringValue(item.id);
      const name = stringValue(item.name);
      events.push({
        type: "tool_call.start",
        index: outputIndex,
        ...(id === undefined ? {} : { id }),
        ...(name === undefined ? {} : { name }),
      });
      events.push({
        type: "tool_call.delta",
        index: outputIndex,
        ...(id === undefined ? {} : { id }),
        ...(name === undefined ? {} : { name }),
        argumentsDelta: stringValue(item.arguments) ?? "",
      });
    }
  }
  const usage = usageFrom(response.usage);
  if (usage !== undefined) events.push({ type: "usage", usage });
  const finishReason = stringValue(response.status);
  const incompleteDetails = isRecord(response.incomplete_details) ? response.incomplete_details : undefined;
  const incompleteReason = incompleteDetails === undefined ? undefined : stringValue(incompleteDetails.reason);
  const stopDetails = stopDetailsFrom(response.stop_details);
  events.push({
    type: "response.completed",
    ...(finishReason === undefined ? {} : { finishReason }),
    ...(incompleteReason === undefined ? {} : { incompleteReason }),
    ...(stopDetails === undefined ? {} : { stopDetails }),
  });
  return events;
}

export const openAiResponsesAdapter: ProtocolAdapter = {
  protocol: "openai-responses",
  defaultGeneratePath: "/v1/responses",
  defaultModelsPath: "/v1/models",
  protectedBodyFields: PROTECTED,

  compile(profile: ProviderProfile, request: CanonicalGenerationRequest) {
    const body = mergeExtraBody(PROTECTED, profile.extraBody, request.extraBody);
    body.model = request.model;
    body.input = inputItems(request.messages);
    body.stream = request.stream ?? true;
    if (request.systemPrompt !== undefined && request.systemPrompt !== "") {
      body.instructions = request.systemPrompt;
    }
    if (request.tools !== undefined && request.tools.length > 0) {
      body.tools = request.tools.map((tool) => ({
        type: "function",
        name: tool.name,
        description: tool.description ?? "",
        parameters: tool.inputSchema,
        ...(tool.strict === undefined ? {} : { strict: tool.strict }),
      }));
    }
    if (request.toolChoice !== undefined) {
      body.tool_choice =
        typeof request.toolChoice === "string"
          ? request.toolChoice
          : { type: "function", name: request.toolChoice.name };
    }
    if (request.temperature !== undefined) body.temperature = request.temperature;
    if (request.topP !== undefined) body.top_p = request.topP;
    if (request.maxOutputTokens !== undefined) body.max_output_tokens = request.maxOutputTokens;
    const warnings = request.stopSequences === undefined
      ? []
      : [{
          code: "unsupported-setting" as const,
          message: "OpenAI Responses does not expose a portable stop-sequences field; it was not sent.",
        }];
    return makeCompiledRequest(profile, this.protocol, this.defaultGeneratePath, request, body, warnings);
  },

  normalizeSse(event: ServerSentEvent): readonly NormalizedProviderEvent[] {
    if (event.data === "[DONE]") return [{ type: "response.completed" }];
    let payload: JsonValue;
    try {
      payload = parsePayload(event)!;
    } catch (cause) {
      return [errorEvent(classifyProviderError({ cause, payload: event.data, fallback: "parse-failure" }))];
    }
    if (!isRecord(payload)) return [{ type: "provider.unknown", ...(event.event === undefined ? {} : { providerType: event.event }) }];
    if (isRecord(payload.error)) {
      return [errorEvent(classifyProviderError({ payload }))];
    }
    const type = stringValue(payload.type) ?? event.event;
    const response = isRecord(payload.response) ? payload.response : undefined;
    if (type === "response.created" || type === "response.in_progress") {
      const responseId = response === undefined ? undefined : stringValue(response.id);
      const model = response === undefined ? undefined : stringValue(response.model);
      return [{
        type: "response.start",
        ...(responseId === undefined ? {} : { responseId }),
        ...(model === undefined ? {} : { model }),
      }];
    }
    if (type === "response.output_text.delta") {
      return [{
        type: "content.delta",
        text: stringValue(payload.delta) ?? "",
        index: numberValue(payload.output_index) ?? 0,
      }];
    }
    if (type === "response.refusal.delta") {
      return [{
        type: "refusal.delta",
        text: stringValue(payload.delta) ?? "",
        index: numberValue(payload.output_index) ?? 0,
      }];
    }
    if (type === "response.refusal.done") {
      return [{
        type: "refusal.done",
        text: stringValue(payload.refusal) ?? "",
        index: numberValue(payload.output_index) ?? 0,
      }];
    }
    if (type === "response.content_part.done" && isRecord(payload.part) && payload.part.type === "refusal") {
      const refusal = stringValue(payload.part.refusal) ?? stringValue(payload.part.text);
      return refusal
        ? [{ type: "refusal.done", text: refusal, index: numberValue(payload.output_index) ?? 0 }]
        : [];
    }
    if (type === "response.reasoning_summary_text.delta" || type === "response.reasoning_text.delta") {
      return [{
        type: "reasoning.delta",
        text: stringValue(payload.delta) ?? "",
        index: numberValue(payload.output_index) ?? 0,
      }];
    }
    if (type === "response.output_item.added" && isRecord(payload.item) && payload.item.type === "function_call") {
      const id = stringValue(payload.item.call_id) ?? stringValue(payload.item.id);
      const name = stringValue(payload.item.name);
      return [{
        type: "tool_call.start",
        index: numberValue(payload.output_index) ?? 0,
        ...(id === undefined ? {} : { id }),
        ...(name === undefined ? {} : { name }),
      }];
    }
    if (type === "response.function_call_arguments.delta") {
      const id = stringValue(payload.call_id) ?? stringValue(payload.item_id);
      return [{
        type: "tool_call.delta",
        index: numberValue(payload.output_index) ?? 0,
        ...(id === undefined ? {} : { id }),
        argumentsDelta: stringValue(payload.delta) ?? "",
      }];
    }
    if ((type === "response.completed" || type === "response.incomplete") && response !== undefined) {
      return completionEvents(response, false);
    }
    if (type === "response.failed" || type === "error") {
      return [errorEvent(classifyProviderError({ payload }))];
    }
    return [{ type: "provider.unknown", ...(type === undefined ? {} : { providerType: type }) }];
  },

  normalizeJson(payload: JsonValue): readonly NormalizedProviderEvent[] {
    if (!isRecord(payload)) {
      return [errorEvent(classifyProviderError({ payload, fallback: "parse-failure" }))];
    }
    if (isRecord(payload.error)) {
      return [
        ...completionEvents(payload).filter((event) => event.type !== "response.completed"),
        errorEvent(classifyProviderError({ payload })),
      ];
    }
    const id = stringValue(payload.id);
    const model = stringValue(payload.model);
    return [
      {
        type: "response.start",
        ...(id === undefined ? {} : { responseId: id }),
        ...(model === undefined ? {} : { model }),
      },
      ...completionEvents(payload),
    ];
  },
};
