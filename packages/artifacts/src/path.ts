import { ArtifactError } from "./types.js";

const DRIVE_PATH = /^[A-Za-z]:/;

export function validateArtifactPath(path: string, maxPathBytes = 1024): string {
  if (!path || path.includes("\0") || path.includes("\\")) {
    throw new ArtifactError("invalid_path", `Unsafe artifact path '${path}'`, path);
  }
  if (path.startsWith("/") || path.startsWith("//") || DRIVE_PATH.test(path)) {
    throw new ArtifactError("invalid_path", `Absolute artifact path '${path}' is forbidden`, path);
  }
  if (Buffer.byteLength(path, "utf8") > maxPathBytes) {
    throw new ArtifactError("size_limit", `Artifact path '${path}' exceeds the path limit`, path);
  }
  const segments = path.split("/");
  if (segments.some((segment) => segment === "" || segment === "." || segment === "..")) {
    throw new ArtifactError("invalid_path", `Artifact path '${path}' traverses a directory`, path);
  }
  return path;
}

export function assertUniqueArtifactPaths(paths: readonly string[]): void {
  const seen = new Set<string>();
  for (const path of paths) {
    // Case folding avoids collisions when a validated import is later materialized
    // on the default case-insensitive macOS filesystem.
    const key = path.normalize("NFC").toLocaleLowerCase("en-US");
    if (seen.has(key)) {
      throw new ArtifactError("duplicate_path", `Duplicate artifact path '${path}'`, path);
    }
    seen.add(key);
  }
}
