import type { JsonObject, JsonValue, RunClassification } from "@lathe/domain";
import {
  isPolicyStopReason,
  type NormalizedProviderEvent,
  type ProviderFailure,
  type ProviderStopDetails,
} from "@lathe/providers";

const INCOMPLETE_REASONS = new Set([
  "cancelled",
  "error",
  "incomplete",
  "length",
  "max_completion_tokens",
  "max_output_tokens",
  "max_tokens",
  "model_context_window_exceeded",
  "pause_turn",
  "token_limit",
]);

function stopDetailsJson(details: ProviderStopDetails): JsonObject {
  return {
    ...(details.type === undefined ? {} : { type: details.type }),
    ...(details.category === undefined ? {} : { category: details.category }),
    ...(details.explanation === undefined ? {} : { explanation: details.explanation }),
    ...(details.code === undefined ? {} : { code: details.code }),
    ...(details.providerData === undefined ? {} : { providerData: details.providerData }),
  };
}

function normalizedReason(value: string | undefined): string | undefined {
  return value?.trim().toLowerCase().replace(/[\s-]+/g, "_");
}

/**
 * Reduces the lossless normalized event sequence to a display/persistence summary.
 * A policy signal is not automatically terminal: gateways may continue on a
 * fallback model, or even emit more output after a provider-native stop signal.
 */
export class ProviderOutcomeTracker {
  private sequence = 0;
  private outputCharacters = 0;
  private lastOutputSequence = -1;
  private lastPolicySequence = -1;
  private lastPolicyStopSequence = -1;
  private lastFallbackSequence = -1;
  private lastNonPolicyStopSequence = -1;
  private readonly activeRefusals = new Map<number, string>();
  private readonly completedRefusals: JsonObject[] = [];
  private readonly fallbacks: JsonObject[] = [];
  private readonly stops: JsonObject[] = [];
  private readonly models: string[] = [];
  private lastStop: NormalizedProviderEvent & { type: "response.completed" } | undefined;
  private failure: ProviderFailure | undefined;

  consume(event: NormalizedProviderEvent): void {
    const sequence = this.sequence++;
    if (event.type === "response.start" && event.model && !this.models.includes(event.model)) {
      this.models.push(event.model);
    }
    if ((event.type === "content.delta" || event.type === "reasoning.delta") && event.text !== "") {
      this.outputCharacters += event.text.length;
      this.lastOutputSequence = sequence;
      return;
    }
    if (event.type === "refusal.delta") {
      this.activeRefusals.set(event.index, `${this.activeRefusals.get(event.index) ?? ""}${event.text}`);
      this.lastPolicySequence = sequence;
      return;
    }
    if (event.type === "refusal.done") {
      const existing = this.activeRefusals.get(event.index) ?? "";
      if (!existing || event.text.startsWith(existing)) this.activeRefusals.set(event.index, event.text);
      else if (!existing.includes(event.text)) this.activeRefusals.set(event.index, `${existing}${event.text}`);
      this.lastPolicySequence = sequence;
      return;
    }
    if (event.type === "response.fallback") {
      this.flushRefusals();
      this.fallbacks.push({
        sequence,
        index: event.index,
        ...(event.fromModel === undefined ? {} : { fromModel: event.fromModel }),
        ...(event.toModel === undefined ? {} : { toModel: event.toModel }),
      });
      if (event.toModel && !this.models.includes(event.toModel)) this.models.push(event.toModel);
      this.lastFallbackSequence = sequence;
      this.lastPolicySequence = sequence;
      return;
    }
    if (event.type === "response.completed") {
      const meaningful = event.finishReason !== undefined ||
        event.nativeFinishReason !== undefined ||
        event.incompleteReason !== undefined ||
        event.stopDetails !== undefined;
      if (!meaningful) return;
      this.lastStop = event;
      const policy = isPolicyStopReason(
        event.finishReason,
        event.nativeFinishReason,
        event.incompleteReason,
        event.stopDetails?.type,
        event.stopDetails?.code,
      );
      const stop: JsonObject = {
        sequence,
        policy,
        ...(event.finishReason === undefined ? {} : { finishReason: event.finishReason }),
        ...(event.nativeFinishReason === undefined ? {} : { nativeFinishReason: event.nativeFinishReason }),
        ...(event.incompleteReason === undefined ? {} : { incompleteReason: event.incompleteReason }),
        ...(event.stopDetails === undefined ? {} : { stopDetails: stopDetailsJson(event.stopDetails) }),
      };
      this.stops.push(stop);
      const explanation = event.stopDetails?.explanation;
      if (explanation) this.addCompletedRefusal(explanation, 0, sequence);
      if (policy) {
        this.lastPolicySequence = sequence;
        this.lastPolicyStopSequence = sequence;
      } else {
        this.lastNonPolicyStopSequence = sequence;
      }
      return;
    }
    if (event.type === "provider.error") {
      this.failure = event.error;
      if (event.error.classification === "content-policy") {
        this.lastPolicySequence = sequence;
        this.lastPolicyStopSequence = sequence;
      }
    }
  }

  classification(): RunClassification | null {
    return this.isTerminalPolicyBlock() ? "content-policy" : null;
  }

  toJson(): JsonObject {
    const refusals = this.refusalsSnapshot();
    const policyDetected = this.lastPolicySequence >= 0;
    const terminalPolicyBlock = this.isTerminalPolicyBlock();
    const recovered = policyDetected && !terminalPolicyBlock;
    const continuedAfterBlock = this.lastPolicyStopSequence >= 0 &&
      this.lastOutputSequence > this.lastPolicyStopSequence;
    const lastStop = this.lastStop;
    const incompleteReason = normalizedReason(lastStop?.incompleteReason ?? lastStop?.finishReason);
    const incomplete = !terminalPolicyBlock && incompleteReason !== undefined && INCOMPLETE_REASONS.has(incompleteReason);
    const status = terminalPolicyBlock
      ? "blocked"
      : this.failure !== undefined
        ? "error"
        : recovered
          ? "recovered"
          : incomplete
            ? "incomplete"
            : "completed";
    return {
      status,
      policyDetected,
      terminalPolicyBlock,
      recovered,
      continuedAfterBlock,
      partialOutput: terminalPolicyBlock && this.outputCharacters > 0,
      outputCharacters: this.outputCharacters,
      ...(lastStop?.finishReason === undefined ? {} : { finishReason: lastStop.finishReason }),
      ...(lastStop?.nativeFinishReason === undefined ? {} : { nativeFinishReason: lastStop.nativeFinishReason }),
      ...(lastStop?.incompleteReason === undefined ? {} : { incompleteReason: lastStop.incompleteReason }),
      ...(lastStop?.stopDetails === undefined ? {} : { stopDetails: stopDetailsJson(lastStop.stopDetails) }),
      ...(refusals.length === 0 ? {} : {
        refusalText: refusals.map((item) => String(item.text ?? "")).filter(Boolean).join("\n\n"),
        refusals,
      }),
      ...(this.fallbacks.length === 0 ? {} : { fallbacks: this.fallbacks as JsonValue[] }),
      ...(this.stops.length === 0 ? {} : { stops: this.stops as JsonValue[] }),
      ...(this.models.length === 0 ? {} : { models: this.models }),
      ...(this.failure === undefined ? {} : {
        errorClassification: this.failure.classification,
        errorMessage: this.failure.message,
      }),
    };
  }

  private isTerminalPolicyBlock(): boolean {
    if (this.failure?.classification === "content-policy") return true;
    if (this.lastPolicySequence < 0) return false;
    const outputContinued = this.lastOutputSequence > this.lastPolicySequence;
    const fallbackCompleted = this.lastFallbackSequence >= this.lastPolicySequence &&
      this.lastNonPolicyStopSequence > this.lastFallbackSequence;
    return !outputContinued && !fallbackCompleted;
  }

  private flushRefusals(): void {
    for (const [index, text] of this.activeRefusals) {
      if (text) this.addCompletedRefusal(text, index, this.sequence);
    }
    this.activeRefusals.clear();
  }

  private addCompletedRefusal(text: string, index: number, sequence: number): void {
    if (this.completedRefusals.some((item) => item.text === text && item.index === index)) return;
    this.completedRefusals.push({ text, index, sequence });
  }

  private refusalsSnapshot(): JsonObject[] {
    const result = [...this.completedRefusals];
    for (const [index, text] of this.activeRefusals) {
      if (text && !result.some((item) => item.text === text && item.index === index)) {
        result.push({ text, index, sequence: this.sequence });
      }
    }
    return result;
  }
}
