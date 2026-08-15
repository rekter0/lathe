import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, open, readFile, rename, stat, unlink } from "node:fs/promises";
import { dirname, join } from "node:path";
import type { JsonValue, TraceEvent } from "@lathe/domain";

export interface StoredBlob {
  sha256: string;
  size: number;
  path: string;
}

export class ContentStore {
  readonly blobsDirectory: string;
  readonly stagingDirectory: string;

  constructor(readonly dataDirectory: string) {
    this.blobsDirectory = join(dataDirectory, "blobs");
    this.stagingDirectory = join(dataDirectory, "staging");
  }

  async initialize(): Promise<void> {
    await mkdir(this.blobsDirectory, { recursive: true, mode: 0o700 });
    await mkdir(this.stagingDirectory, { recursive: true, mode: 0o700 });
    await chmod(this.dataDirectory, 0o700).catch(() => undefined);
    await chmod(this.blobsDirectory, 0o700).catch(() => undefined);
    await chmod(this.stagingDirectory, 0o700).catch(() => undefined);
  }

  pathFor(hash: string): string {
    if (!/^[a-f0-9]{64}$/.test(hash)) throw new Error("Invalid SHA-256 blob identifier");
    return join(this.blobsDirectory, hash.slice(0, 2), hash.slice(2, 4), hash);
  }

  async put(bytes: Uint8Array): Promise<StoredBlob> {
    const sha256 = createHash("sha256").update(bytes).digest("hex");
    const target = this.pathFor(sha256);
    await mkdir(dirname(target), { recursive: true, mode: 0o700 });
    try {
      await stat(target);
    } catch {
      const staging = join(this.stagingDirectory, `${randomUUID()}.blob`);
      const handle = await open(staging, "wx", 0o600);
      try {
        await handle.writeFile(bytes);
        await handle.sync();
      } finally {
        await handle.close();
      }
      await rename(staging, target).catch(async (error: unknown) => {
        await unlink(staging).catch(() => undefined);
        try {
          await stat(target);
        } catch {
          throw error;
        }
      });
      await chmod(target, 0o600).catch(() => undefined);
    }
    return { sha256, size: bytes.byteLength, path: target };
  }

  async get(hash: string): Promise<Buffer> {
    return readFile(this.pathFor(hash));
  }

  async createTraceWriter(): Promise<TraceWriter> {
    const path = join(this.stagingDirectory, `${randomUUID()}.trace.ndjson`);
    const handle = await open(path, "wx", 0o600);
    return new TraceWriter(this, path, handle);
  }
}

export class TraceWriter {
  private sequence = 0;
  private closed = false;

  constructor(
    private readonly store: ContentStore,
    private readonly stagingPath: string,
    private readonly handle: Awaited<ReturnType<typeof open>>
  ) {}

  async append(input: Omit<TraceEvent, "sequence" | "timestamp"> & { timestamp?: string }): Promise<TraceEvent> {
    if (this.closed) throw new Error("Trace writer is closed");
    const event: TraceEvent = {
      ...input,
      sequence: this.sequence,
      timestamp: input.timestamp ?? new Date().toISOString()
    };
    this.sequence += 1;
    await this.handle.appendFile(`${JSON.stringify(event)}\n`, "utf8");
    return event;
  }

  async finalize(): Promise<StoredBlob> {
    if (this.closed) throw new Error("Trace writer is closed");
    this.closed = true;
    await this.handle.sync();
    await this.handle.close();
    const bytes = await readFile(this.stagingPath);
    const stored = await this.store.put(bytes);
    await unlink(this.stagingPath).catch(() => undefined);
    return stored;
  }

  async abort(reason?: JsonValue): Promise<void> {
    if (this.closed) return;
    if (reason !== undefined) {
      await this.append({ direction: "internal", kind: "error", data: reason });
    }
    this.closed = true;
    await this.handle.close();
    await unlink(this.stagingPath).catch(() => undefined);
  }
}
