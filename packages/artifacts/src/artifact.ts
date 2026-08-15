import { createHash } from "node:crypto";
import type { JsonValue } from "@lathe/domain";
import {
  ARTIFACT_SCHEMA,
  ArtifactError,
  DEFAULT_ARTIFACT_IMPORT_LIMITS,
  type ArtifactEntryManifest,
  type ArtifactFileInput,
  type ArtifactFileRole,
  type ArtifactImportLimits,
  type ArtifactKind,
  type ArtifactManifestV1,
  type ExportArtifactOptions,
  type ImportedArtifact,
} from "./types.js";
import { assertUniqueArtifactPaths, validateArtifactPath } from "./path.js";
import {
  containsKnownSecret,
  redactArtifactJson,
  redactArtifactText,
} from "./redaction.js";
import { extractZip, makeZip } from "./zip.js";

const MANIFEST_PATH = "manifest.json";
const SUMMARY_PATH = "summary.md";
const TEXT_EXTENSIONS = /\.(?:txt|md|json|jsonl|ndjson|yaml|yml|toml|xml|html|css|js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|py|rb|go|rs|java|kt|swift|sql)$/i;
const SCRIPT_EXTENSIONS = /\.(?:js|mjs|cjs|ts|tsx|jsx|sh|bash|zsh|py|rb|ps1)$/i;
const SHA256 = /^[a-f0-9]{64}$/;

function hash(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function utf8(value: string): Uint8Array {
  return new TextEncoder().encode(value);
}

function decodeUtf8(bytes: Uint8Array, path: string): string {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    throw new ArtifactError("invalid_manifest", `'${path}' is not valid UTF-8`, path);
  }
}

function inferMediaType(path: string): string {
  if (path.endsWith(".json")) return "application/json";
  if (path.endsWith(".md")) return "text/markdown";
  if (TEXT_EXTENSIONS.test(path)) return "text/plain";
  return "application/octet-stream";
}

function inferRole(path: string): ArtifactFileRole {
  if (path === SUMMARY_PATH) return "summary";
  if (path.startsWith("prompts/")) return "prompt";
  if (path.startsWith("tools/specs/")) return "tool-spec";
  if (path.startsWith("tools/scripts/")) return "tool-script";
  if (path.startsWith("config/")) return "config";
  if (path.startsWith("transcript/")) return "transcript";
  if (path.startsWith("traces/")) return "trace";
  if (path.startsWith("attachments/")) return "attachment";
  return "other";
}

function isTextFile(file: ArtifactFileInput, mediaType: string): boolean {
  return (
    typeof file.data === "string" ||
    mediaType.startsWith("text/") ||
    mediaType === "application/json" ||
    mediaType.endsWith("+json") ||
    TEXT_EXTENSIONS.test(file.path)
  );
}

function sanitizeFile(
  file: ArtifactFileInput,
  secretValues: readonly string[],
): { bytes: Uint8Array; redactions: number } {
  const mediaType = file.mediaType ?? inferMediaType(file.path);
  const original = typeof file.data === "string" ? utf8(file.data) : new Uint8Array(file.data);
  if (!isTextFile(file, mediaType)) {
    if (containsKnownSecret(original, secretValues)) {
      throw new ArtifactError(
        "credential_leak",
        `Binary entry '${file.path}' contains a known credential and cannot be safely redacted`,
        file.path,
      );
    }
    return { bytes: original, redactions: 0 };
  }

  const text = decodeUtf8(original, file.path);
  if (mediaType === "application/x-ndjson" || file.path.endsWith(".ndjson")) {
    try {
      let count = 0;
      const lines = text.split(/\r?\n/u).map((line) => {
        if (line.trim() === "") return "";
        const redacted = redactArtifactJson(JSON.parse(line) as JsonValue, secretValues);
        count += redacted.count;
        return JSON.stringify(redacted.value);
      });
      return { bytes: utf8(lines.join("\n")), redactions: count };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Some compatible providers record non-JSON diagnostic fragments. Fall
      // through to conservative text redaction for those legacy traces.
    }
  }
  if (mediaType === "application/json" || mediaType.endsWith("+json") || file.path.endsWith(".json")) {
    try {
      const parsed = JSON.parse(text) as JsonValue;
      const redacted = redactArtifactJson(parsed, secretValues);
      return { bytes: utf8(`${JSON.stringify(redacted.value, null, 2)}\n`), redactions: redacted.count };
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      // Provider traces may be JSON fragments; text redaction still applies.
    }
  }
  const redacted = redactArtifactText(text, secretValues);
  return { bytes: utf8(redacted.value), redactions: redacted.count };
}

function makeEntry(file: ArtifactFileInput, bytes: Uint8Array): ArtifactEntryManifest {
  const mediaType = file.mediaType ?? inferMediaType(file.path);
  const role = file.role ?? inferRole(file.path);
  const script = file.script ?? (role === "tool-script" || SCRIPT_EXTENSIONS.test(file.path));
  return {
    path: file.path,
    sha256: hash(bytes),
    size: bytes.byteLength,
    mediaType,
    role,
    script,
    enabledOnImport: !script,
  };
}

export function exportArtifact(options: ExportArtifactOptions): Uint8Array {
  if (!options.artifactId.trim()) throw new ArtifactError("invalid_manifest", "artifactId is required");
  if (!options.generatorVersion.trim()) {
    throw new ArtifactError("invalid_manifest", "generatorVersion is required");
  }
  const files: ArtifactFileInput[] = [
    {
      path: SUMMARY_PATH,
      data: options.summaryMarkdown,
      mediaType: "text/markdown",
      role: "summary",
    },
    ...(options.files ?? []),
  ];
  if (files.some((file) => file.path === MANIFEST_PATH)) {
    throw new ArtifactError("invalid_path", `'${MANIFEST_PATH}' is reserved`, MANIFEST_PATH);
  }
  for (const file of files) validateArtifactPath(file.path);
  assertUniqueArtifactPaths(files.map((file) => file.path));

  const archiveFiles = new Map<string, Uint8Array>();
  const entries: ArtifactEntryManifest[] = [];
  let redactionCount = 0;
  for (const file of files.sort((left, right) => left.path.localeCompare(right.path))) {
    const sanitized = sanitizeFile(file, options.secretValues ?? []);
    if (containsKnownSecret(sanitized.bytes, options.secretValues ?? [])) {
      throw new ArtifactError(
        "credential_leak",
        `Credential redaction failed for '${file.path}'`,
        file.path,
      );
    }
    archiveFiles.set(file.path, sanitized.bytes);
    entries.push(makeEntry(file, sanitized.bytes));
    redactionCount += sanitized.redactions;
  }

  const metadata = redactArtifactJson(options.metadata, options.secretValues ?? []);
  redactionCount += metadata.count;
  const manifest: ArtifactManifestV1 = {
    schema: ARTIFACT_SCHEMA,
    kind: options.kind,
    artifactId: options.artifactId,
    createdAt: (options.now ?? (() => new Date()))().toISOString(),
    generator: { name: "lathe", version: options.generatorVersion },
    metadata: metadata.value,
    security: {
      credentialsIncluded: false,
      importedScriptsEnabled: false,
      redactionCount,
    },
    entries,
  };
  const manifestBytes = utf8(`${JSON.stringify(manifest, null, 2)}\n`);
  if (containsKnownSecret(manifestBytes, options.secretValues ?? [])) {
    throw new ArtifactError("credential_leak", "Artifact manifest contains a known credential");
  }
  archiveFiles.set(MANIFEST_PATH, manifestBytes);
  return makeZip(archiveFiles);
}

export function exportHarnessArtifact(
  options: Omit<ExportArtifactOptions, "kind">,
): Uint8Array {
  return exportArtifact({ ...options, kind: "harness" });
}

export function exportFindingArtifact(
  options: Omit<ExportArtifactOptions, "kind">,
): Uint8Array {
  return exportArtifact({ ...options, kind: "finding" });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function parseEntry(value: unknown, maxPathBytes: number): ArtifactEntryManifest {
  if (!isRecord(value)) throw new ArtifactError("invalid_manifest", "Manifest entry is invalid");
  const { path, sha256, size, mediaType, role, script, enabledOnImport } = value;
  if (typeof path !== "string") throw new ArtifactError("invalid_manifest", "Entry path is invalid");
  validateArtifactPath(path, maxPathBytes);
  const validRoles: ArtifactFileRole[] = [
    "summary",
    "prompt",
    "tool-spec",
    "tool-script",
    "config",
    "transcript",
    "trace",
    "attachment",
    "other",
  ];
  if (
    typeof sha256 !== "string" ||
    !SHA256.test(sha256) ||
    typeof size !== "number" ||
    !Number.isSafeInteger(size) ||
    size < 0 ||
    typeof mediaType !== "string" ||
    typeof role !== "string" ||
    !validRoles.includes(role as ArtifactFileRole) ||
    typeof script !== "boolean" ||
    typeof enabledOnImport !== "boolean" ||
    enabledOnImport !== !script
  ) {
    throw new ArtifactError("invalid_manifest", `Manifest entry '${path}' is invalid`, path);
  }
  return {
    path,
    sha256,
    size,
    mediaType,
    role: role as ArtifactFileRole,
    script,
    enabledOnImport,
  };
}

function parseManifest(bytes: Uint8Array, limits: ArtifactImportLimits): ArtifactManifestV1 {
  if (bytes.byteLength > limits.maxManifestBytes) {
    throw new ArtifactError("size_limit", "Artifact manifest exceeds its size limit");
  }
  let input: unknown;
  try {
    input = JSON.parse(decodeUtf8(bytes, MANIFEST_PATH));
  } catch (error) {
    if (error instanceof ArtifactError) throw error;
    throw new ArtifactError("invalid_manifest", "Artifact manifest is not valid JSON");
  }
  if (!isRecord(input)) throw new ArtifactError("invalid_manifest", "Artifact manifest is invalid");
  if (input.schema !== ARTIFACT_SCHEMA) {
    throw new ArtifactError("invalid_manifest", `Unsupported artifact schema '${String(input.schema)}'`);
  }
  if (input.kind !== "harness" && input.kind !== "finding") {
    throw new ArtifactError("invalid_manifest", "Artifact kind is invalid");
  }
  if (
    typeof input.artifactId !== "string" ||
    !input.artifactId ||
    typeof input.createdAt !== "string" ||
    Number.isNaN(Date.parse(input.createdAt)) ||
    !isRecord(input.generator) ||
    input.generator.name !== "lathe" ||
    typeof input.generator.version !== "string" ||
    !isRecord(input.security) ||
    input.security.credentialsIncluded !== false ||
    input.security.importedScriptsEnabled !== false ||
    typeof input.security.redactionCount !== "number" ||
    !Array.isArray(input.entries)
  ) {
    throw new ArtifactError("invalid_manifest", "Artifact manifest fields are invalid");
  }
  const entries = input.entries.map((entry) => parseEntry(entry, limits.maxPathBytes));
  assertUniqueArtifactPaths(entries.map((entry) => entry.path));
  if (!entries.some((entry) => entry.path === SUMMARY_PATH && entry.role === "summary")) {
    throw new ArtifactError("invalid_manifest", "Artifact requires a summary.md entry");
  }
  return {
    schema: ARTIFACT_SCHEMA,
    kind: input.kind,
    artifactId: input.artifactId,
    createdAt: input.createdAt,
    generator: { name: "lathe", version: input.generator.version },
    metadata: input.metadata as JsonValue,
    security: {
      credentialsIncluded: false,
      importedScriptsEnabled: false,
      redactionCount: input.security.redactionCount,
    },
    entries,
  };
}

export function importArtifact(
  data: Uint8Array,
  overrides: Partial<ArtifactImportLimits> = {},
): ImportedArtifact {
  const limits = { ...DEFAULT_ARTIFACT_IMPORT_LIMITS, ...overrides };
  if (Object.values(limits).some((value) => !Number.isSafeInteger(value) || value <= 0)) {
    throw new ArtifactError("size_limit", "Artifact import limits must be positive integers");
  }
  const archive = extractZip(data, limits);
  const manifestBytes = archive.get(MANIFEST_PATH);
  if (!manifestBytes) throw new ArtifactError("invalid_manifest", "Artifact has no manifest.json");
  const manifest = parseManifest(manifestBytes, limits);
  if (manifest.entries.length + 1 !== archive.size) {
    throw new ArtifactError("unexpected_entry", "Artifact contains files not listed in its manifest");
  }

  const files = manifest.entries.map((entry) => {
    const bytes = archive.get(entry.path);
    if (!bytes) {
      throw new ArtifactError("missing_entry", `Artifact entry '${entry.path}' is missing`, entry.path);
    }
    if (bytes.byteLength !== entry.size) {
      throw new ArtifactError("hash_mismatch", `Size mismatch for '${entry.path}'`, entry.path);
    }
    if (hash(bytes) !== entry.sha256) {
      throw new ArtifactError("hash_mismatch", `SHA-256 mismatch for '${entry.path}'`, entry.path);
    }
    return {
      path: entry.path,
      data: new Uint8Array(bytes),
      mediaType: entry.mediaType,
      role: entry.role,
      script: entry.script,
      enabled: entry.enabledOnImport,
    };
  });
  return { manifest, files, trusted: false };
}

export function importHarnessArtifact(
  data: Uint8Array,
  limits?: Partial<ArtifactImportLimits>,
): ImportedArtifact {
  const artifact = importArtifact(data, limits);
  if (artifact.manifest.kind !== "harness") {
    throw new ArtifactError("invalid_manifest", "Expected a harness artifact");
  }
  return artifact;
}

export function importFindingArtifact(
  data: Uint8Array,
  limits?: Partial<ArtifactImportLimits>,
): ImportedArtifact {
  const artifact = importArtifact(data, limits);
  if (artifact.manifest.kind !== "finding") {
    throw new ArtifactError("invalid_manifest", "Expected a finding artifact");
  }
  return artifact;
}
