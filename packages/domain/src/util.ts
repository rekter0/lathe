import type { JsonObject, JsonValue, PromptBlockSnapshot, ResolvedConfig } from "./types.js";

export function nowIso(): string {
  return new Date().toISOString();
}

function randomEntropy(): Uint8Array {
  const bytes = new Uint8Array(10);
  globalThis.crypto.getRandomValues(bytes);
  return bytes;
}

export function uuidv7(timestamp = Date.now(), entropy = randomEntropy()): string {
  if (entropy.length < 10) throw new RangeError("UUIDv7 requires at least 10 bytes of entropy");
  const bytes = new Uint8Array(16);
  let value = BigInt(timestamp);
  for (let index = 5; index >= 0; index -= 1) {
    bytes[index] = Number(value & 0xffn);
    value >>= 8n;
  }
  bytes.set(entropy.slice(0, 10), 6);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x70;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function canonicalize(value: JsonValue): JsonValue {
  if (Array.isArray(value)) return value.map(canonicalize);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, item]) => [key, canonicalize(item)])
    );
  }
  return value;
}

export function canonicalJson(value: JsonValue): string {
  return JSON.stringify(canonicalize(value));
}

export function sha256Json(value: JsonValue): string {
  return sha256(canonicalJson(value));
}

// Compact SHA-256 implementation keeps the shared domain package browser-safe.
const SHA256_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2
]);

const rotateRight = (value: number, amount: number) => (value >>> amount) | (value << (32 - amount));

export function sha256(input: string): string {
  const source = new TextEncoder().encode(input);
  const bitLength = BigInt(source.length) * 8n;
  const paddedLength = Math.ceil((source.length + 9) / 64) * 64;
  const bytes = new Uint8Array(paddedLength);
  bytes.set(source);
  bytes[source.length] = 0x80;
  const view = new DataView(bytes.buffer);
  view.setUint32(paddedLength - 8, Number((bitLength >> 32n) & 0xffffffffn));
  view.setUint32(paddedLength - 4, Number(bitLength & 0xffffffffn));
  const state = new Uint32Array([0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19]);
  const words = new Uint32Array(64);
  for (let offset = 0; offset < paddedLength; offset += 64) {
    for (let index = 0; index < 16; index += 1) words[index] = view.getUint32(offset + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const left = words[index - 15] ?? 0;
      const right = words[index - 2] ?? 0;
      const sigma0 = rotateRight(left, 7) ^ rotateRight(left, 18) ^ (left >>> 3);
      const sigma1 = rotateRight(right, 17) ^ rotateRight(right, 19) ^ (right >>> 10);
      words[index] = (((words[index - 16] ?? 0) + sigma0 + (words[index - 7] ?? 0) + sigma1) >>> 0);
    }
    let [a, b, c, d, e, f, g, h] = state;
    for (let index = 0; index < 64; index += 1) {
      const valueE = e ?? 0;
      const valueA = a ?? 0;
      const sum1 = rotateRight(valueE, 6) ^ rotateRight(valueE, 11) ^ rotateRight(valueE, 25);
      const choose = (valueE & (f ?? 0)) ^ (~valueE & (g ?? 0));
      const temporary1 = (((h ?? 0) + sum1 + choose + (SHA256_CONSTANTS[index] ?? 0) + (words[index] ?? 0)) >>> 0);
      const sum0 = rotateRight(valueA, 2) ^ rotateRight(valueA, 13) ^ rotateRight(valueA, 22);
      const majority = (valueA & (b ?? 0)) ^ (valueA & (c ?? 0)) ^ ((b ?? 0) & (c ?? 0));
      const temporary2 = (sum0 + majority) >>> 0;
      h = g; g = f; f = e; e = (((d ?? 0) + temporary1) >>> 0); d = c; c = b; b = a; a = (temporary1 + temporary2) >>> 0;
    }
    for (const [index, value] of [a, b, c, d, e, f, g, h].entries()) state[index] = ((state[index] ?? 0) + (value ?? 0)) >>> 0;
  }
  return Array.from(state, (word) => word.toString(16).padStart(8, "0")).join("");
}

const DEFAULT_SECRET_KEYS = /authorization|api[-_]?key|token|secret|password|credential|cookie/i;

export function redactJson(value: JsonValue, secretKeys = DEFAULT_SECRET_KEYS): JsonValue {
  if (Array.isArray(value)) return value.map((item) => redactJson(item, secretKeys));
  if (value && typeof value === "object") {
    const output: JsonObject = {};
    for (const [key, item] of Object.entries(value)) {
      output[key] = secretKeys.test(key) ? "<redacted>" : redactJson(item, secretKeys);
    }
    return output;
  }
  return value;
}

export function compileSystemPrompt(blocks: PromptBlockSnapshot[]): string {
  return blocks
    .filter((block) => block.enabled)
    .toSorted((left, right) => left.order - right.order)
    .map((block) => block.content.trim())
    .filter(Boolean)
    .join("\n\n");
}

export function emptyResolvedConfig(): ResolvedConfig {
  return {
    promptBlocks: [],
    tools: [],
    toolApprovalMode: "manual",
    provider: null,
    temperature: null,
    maxOutputTokens: null,
    protocolOverrides: {},
    compileWarnings: []
  };
}
