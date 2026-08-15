import { unzipSync, zipSync, type Zippable } from "fflate";
import { ArtifactError, type ArtifactImportLimits } from "./types.js";
import { assertUniqueArtifactPaths, validateArtifactPath } from "./path.js";

const CENTRAL_FILE_HEADER = 0x02014b50;
const END_OF_CENTRAL_DIRECTORY = 0x06054b50;
const ZIP64_SENTINEL_16 = 0xffff;
const ZIP64_SENTINEL_32 = 0xffffffff;

interface CentralEntry {
  path: string;
  compressedSize: number;
  uncompressedSize: number;
}

function readU16(data: Uint8Array, offset: number): number {
  return data[offset]! | (data[offset + 1]! << 8);
}

function readU32(data: Uint8Array, offset: number): number {
  return (
    (data[offset]! |
      (data[offset + 1]! << 8) |
      (data[offset + 2]! << 16) |
      (data[offset + 3]! << 24)) >>>
    0
  );
}

function findEndOfCentralDirectory(data: Uint8Array): number {
  const minimum = Math.max(0, data.length - 65_557);
  for (let offset = data.length - 22; offset >= minimum; offset -= 1) {
    if (readU32(data, offset) === END_OF_CENTRAL_DIRECTORY) return offset;
  }
  throw new ArtifactError("invalid_zip", "ZIP end-of-central-directory record was not found");
}

export function inspectZip(
  data: Uint8Array,
  limits: ArtifactImportLimits,
): CentralEntry[] {
  if (data.byteLength > limits.maxCompressedBytes) {
    throw new ArtifactError("size_limit", "Artifact exceeds the compressed-size limit");
  }
  if (data.byteLength < 22) throw new ArtifactError("invalid_zip", "Artifact is not a ZIP file");

  const endOffset = findEndOfCentralDirectory(data);
  const disk = readU16(data, endOffset + 4);
  const centralDisk = readU16(data, endOffset + 6);
  const entriesOnDisk = readU16(data, endOffset + 8);
  const entryCount = readU16(data, endOffset + 10);
  const centralSize = readU32(data, endOffset + 12);
  const centralOffset = readU32(data, endOffset + 16);
  if (
    disk !== 0 ||
    centralDisk !== 0 ||
    entriesOnDisk !== entryCount ||
    entryCount === ZIP64_SENTINEL_16 ||
    centralSize === ZIP64_SENTINEL_32 ||
    centralOffset === ZIP64_SENTINEL_32
  ) {
    throw new ArtifactError("unsupported_zip", "Multi-disk and ZIP64 artifacts are not supported");
  }
  if (entryCount > limits.maxEntries) {
    throw new ArtifactError("size_limit", "Artifact contains too many files");
  }
  if (centralOffset + centralSize > endOffset || centralOffset > data.length) {
    throw new ArtifactError("invalid_zip", "ZIP central directory is out of bounds");
  }

  const decoder = new TextDecoder("utf-8", { fatal: true });
  const entries: CentralEntry[] = [];
  let offset = centralOffset;
  let total = 0;
  for (let index = 0; index < entryCount; index += 1) {
    if (offset + 46 > data.length || readU32(data, offset) !== CENTRAL_FILE_HEADER) {
      throw new ArtifactError("invalid_zip", "ZIP central directory entry is malformed");
    }
    const flags = readU16(data, offset + 8);
    const method = readU16(data, offset + 10);
    const compressedSize = readU32(data, offset + 20);
    const uncompressedSize = readU32(data, offset + 24);
    const nameLength = readU16(data, offset + 28);
    const extraLength = readU16(data, offset + 30);
    const commentLength = readU16(data, offset + 32);
    const end = offset + 46 + nameLength + extraLength + commentLength;
    if (end > data.length) throw new ArtifactError("invalid_zip", "ZIP entry is truncated");
    if ((flags & 1) !== 0) throw new ArtifactError("unsupported_zip", "Encrypted ZIP entries are forbidden");
    if (method !== 0 && method !== 8) {
      throw new ArtifactError("unsupported_zip", `ZIP compression method ${method} is unsupported`);
    }
    if (compressedSize === ZIP64_SENTINEL_32 || uncompressedSize === ZIP64_SENTINEL_32) {
      throw new ArtifactError("unsupported_zip", "ZIP64 entries are not supported");
    }
    let path: string;
    try {
      path = decoder.decode(data.subarray(offset + 46, offset + 46 + nameLength));
    } catch {
      throw new ArtifactError("invalid_zip", "ZIP paths must be valid UTF-8");
    }
    validateArtifactPath(path, limits.maxPathBytes);
    if (uncompressedSize > limits.maxEntryBytes) {
      throw new ArtifactError("size_limit", `Artifact entry '${path}' exceeds the file limit`, path);
    }
    total += uncompressedSize;
    if (total > limits.maxTotalUncompressedBytes) {
      throw new ArtifactError("size_limit", "Artifact exceeds the uncompressed-size limit");
    }
    entries.push({ path, compressedSize, uncompressedSize });
    offset = end;
  }
  if (offset !== centralOffset + centralSize) {
    throw new ArtifactError("invalid_zip", "ZIP central directory size does not match its contents");
  }
  assertUniqueArtifactPaths(entries.map((entry) => entry.path));
  return entries;
}

export function makeZip(files: ReadonlyMap<string, Uint8Array>): Uint8Array {
  const epoch = new Date("1980-01-01T00:00:00.000Z");
  const input: Zippable = {};
  for (const [path, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
    input[path] = [bytes, { mtime: epoch, level: 6 }];
  }
  return zipSync(input);
}

export function extractZip(
  data: Uint8Array,
  limits: ArtifactImportLimits,
): Map<string, Uint8Array> {
  const inspected = inspectZip(data, limits);
  let files: Record<string, Uint8Array>;
  try {
    files = unzipSync(data);
  } catch (error) {
    throw new ArtifactError(
      "invalid_zip",
      `ZIP extraction failed: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const output = new Map<string, Uint8Array>();
  let actualTotal = 0;
  for (const entry of inspected) {
    const bytes = files[entry.path];
    if (!bytes) throw new ArtifactError("missing_entry", `ZIP entry '${entry.path}' is missing`, entry.path);
    if (bytes.byteLength !== entry.uncompressedSize) {
      throw new ArtifactError("invalid_zip", `ZIP entry '${entry.path}' has a false size`, entry.path);
    }
    actualTotal += bytes.byteLength;
    if (bytes.byteLength > limits.maxEntryBytes || actualTotal > limits.maxTotalUncompressedBytes) {
      throw new ArtifactError("size_limit", `Extracted artifact exceeds size limits`, entry.path);
    }
    output.set(entry.path, bytes);
  }
  if (Object.keys(files).length !== inspected.length) {
    throw new ArtifactError("invalid_zip", "ZIP extraction produced an unexpected file count");
  }
  return output;
}
