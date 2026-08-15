import type { JsonObject, JsonValue, MessagePart } from "@lathe/domain";

export interface ReplayStep {
  kind: "user" | "tool-result";
  parts: MessagePart[];
}

export interface ReplayPlan extends JsonObject {
  steps: Array<ReplayStep & JsonObject>;
  sourceBranchId: string;
  destinationBranchId: string;
}

export interface PayloadFanoutPlan extends JsonObject {
  payload: string;
  branchIds: string[];
}

export interface BatchVaryPlan extends JsonObject {
  pointer: string;
  values: JsonValue[];
  template: JsonObject;
}

export interface JobItem {
  id: string;
  index: number;
  input: JsonObject;
}

export function parseJsonPointer(pointer: string): string[] {
  if (pointer === "") return [];
  if (!pointer.startsWith("/")) throw new Error("JSON Pointer must be empty or begin with '/'");
  if (/(?:~(?![01]))/.test(pointer)) throw new Error("JSON Pointer '~' escapes must be ~0 or ~1");
  return pointer
    .slice(1)
    .split("/")
    .map((part) => part.replaceAll("~1", "/").replaceAll("~0", "~"));
}

export function setJsonPointer(document: JsonObject, pointer: string, value: JsonValue): JsonObject {
  const path = parseJsonPointer(pointer);
  if (path.length === 0) {
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Root replacement must be an object");
    return structuredClone(value) as JsonObject;
  }
  const output = structuredClone(document);
  let cursor: JsonObject | JsonValue[] = output;
  for (const [index, segment] of path.entries()) {
    const last = index === path.length - 1;
    if (last) {
      if (Array.isArray(cursor)) {
        const itemIndex = segment === "-" ? cursor.length : Number(segment);
        if (!Number.isSafeInteger(itemIndex) || itemIndex < 0 || itemIndex > cursor.length) throw new Error(`Invalid array index ${segment}`);
        cursor[itemIndex] = structuredClone(value);
      } else {
        cursor[segment] = structuredClone(value);
      }
      continue;
    }
    const current: JsonValue | undefined = Array.isArray(cursor) ? cursor[Number(segment)] : cursor[segment];
    if (!current || typeof current !== "object") throw new Error(`Pointer segment ${segment} does not resolve to a container`);
    cursor = current as JsonObject | JsonValue[];
  }
  return output;
}

export function previewBatchVariation(plan: BatchVaryPlan): JobItem[] {
  if (plan.values.length === 0) throw new Error("Batch variation requires at least one value");
  return plan.values.map((value, index) => ({
    id: `variation-${index + 1}`,
    index,
    input: setJsonPointer(plan.template, plan.pointer, value)
  }));
}

export function previewPayloadFanout(plan: PayloadFanoutPlan): JobItem[] {
  return plan.branchIds.map((branchId, index) => ({
    id: `branch-${branchId}`,
    index,
    input: { branchId, payload: plan.payload }
  }));
}

export interface PoolProgress<T> {
  completed: Array<{ item: JobItem; value: T }>;
  failed: Array<{ item: JobItem; error: string }>;
}

export async function runBoundedPool<T>(
  items: JobItem[],
  concurrency: number,
  worker: (item: JobItem, signal: AbortSignal) => Promise<T>,
  options: { signal?: AbortSignal; stopOnError?: boolean; onProgress?: (progress: PoolProgress<T>) => void } = {}
): Promise<PoolProgress<T>> {
  if (!Number.isInteger(concurrency) || concurrency < 1 || concurrency > 10) throw new RangeError("Concurrency must be from 1 to 10");
  const progress: PoolProgress<T> = { completed: [], failed: [] };
  const controller = new AbortController();
  const relayAbort = () => controller.abort(options.signal?.reason);
  if (options.signal?.aborted) relayAbort();
  else options.signal?.addEventListener("abort", relayAbort, { once: true });
  let cursor = 0;

  const consume = async () => {
    while (!controller.signal.aborted) {
      const index = cursor;
      cursor += 1;
      const item = items[index];
      if (!item) return;
      try {
        const value = await worker(item, controller.signal);
        progress.completed.push({ item, value });
      } catch (error) {
        progress.failed.push({ item, error: error instanceof Error ? error.message : String(error) });
        if (options.stopOnError ?? true) controller.abort(error);
      }
      options.onProgress?.(structuredClone(progress));
    }
  };

  try {
    await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, consume));
  } finally {
    options.signal?.removeEventListener("abort", relayAbort);
  }
  return progress;
}
