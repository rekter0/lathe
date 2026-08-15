import type { JsonValue } from "@lathe/domain";

export type { JsonValue } from "@lathe/domain";

export const ARTIFACT_SCHEMA = "dev.lathe.artifact/v1" as const;
export const HARNESS_ARTIFACT_EXTENSION = ".lathe-harness" as const;
export const FINDING_ARTIFACT_EXTENSION = ".lathe-finding" as const;

export type ArtifactKind = "harness" | "finding";
export type ArtifactFileRole =
  | "summary"
  | "prompt"
  | "tool-spec"
  | "tool-script"
  | "config"
  | "transcript"
  | "trace"
  | "attachment"
  | "other";

export interface ArtifactFileInput {
  path: string;
  data: Uint8Array | string;
  mediaType?: string;
  role?: ArtifactFileRole;
  /** Explicitly marks code that must be disabled when imported. */
  script?: boolean;
}

export interface ArtifactEntryManifest {
  path: string;
  sha256: string;
  size: number;
  mediaType: string;
  role: ArtifactFileRole;
  script: boolean;
  enabledOnImport: boolean;
}

export interface ArtifactSecurityManifest {
  credentialsIncluded: false;
  importedScriptsEnabled: false;
  redactionCount: number;
}

export interface ArtifactManifestV1 {
  schema: typeof ARTIFACT_SCHEMA;
  kind: ArtifactKind;
  artifactId: string;
  createdAt: string;
  generator: { name: "lathe"; version: string };
  metadata: JsonValue;
  security: ArtifactSecurityManifest;
  entries: ArtifactEntryManifest[];
}

export interface ExportArtifactOptions {
  kind: ArtifactKind;
  artifactId: string;
  generatorVersion: string;
  metadata: JsonValue;
  summaryMarkdown: string;
  files?: ArtifactFileInput[];
  /** Known resolved credentials to scrub from every text/JSON payload. */
  secretValues?: readonly string[];
  now?: () => Date;
}

export interface ImportedArtifactFile {
  path: string;
  data: Uint8Array;
  mediaType: string;
  role: ArtifactFileRole;
  script: boolean;
  /** Scripts are always false; non-script data is inert and true. */
  enabled: boolean;
}

export interface ImportedArtifact {
  manifest: ArtifactManifestV1;
  files: ImportedArtifactFile[];
  trusted: false;
}

export interface ArtifactImportLimits {
  maxCompressedBytes: number;
  maxEntries: number;
  maxEntryBytes: number;
  maxTotalUncompressedBytes: number;
  maxManifestBytes: number;
  maxPathBytes: number;
}

export const DEFAULT_ARTIFACT_IMPORT_LIMITS: Readonly<ArtifactImportLimits> = Object.freeze({
  maxCompressedBytes: 256 * 1024 * 1024,
  maxEntries: 4_096,
  maxEntryBytes: 128 * 1024 * 1024,
  maxTotalUncompressedBytes: 512 * 1024 * 1024,
  maxManifestBytes: 1024 * 1024,
  maxPathBytes: 1024,
});

export type ArtifactErrorCode =
  | "invalid_path"
  | "duplicate_path"
  | "invalid_zip"
  | "unsupported_zip"
  | "size_limit"
  | "invalid_manifest"
  | "missing_entry"
  | "unexpected_entry"
  | "hash_mismatch"
  | "credential_leak";

export class ArtifactError extends Error {
  readonly code: ArtifactErrorCode;
  readonly path?: string;

  constructor(code: ArtifactErrorCode, message: string, path?: string) {
    super(message);
    this.name = "ArtifactError";
    this.code = code;
    if (path !== undefined) this.path = path;
  }
}
