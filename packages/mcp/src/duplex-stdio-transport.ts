import { PassThrough, type Readable, type Writable } from "node:stream";
import { ReadBuffer, serializeMessage } from "@modelcontextprotocol/sdk/shared/stdio.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";
import type { ResolvedStdioMcpTransport } from "./types.js";

export interface McpDuplexProcess {
  readonly stdin: Writable;
  readonly stdout: Readable;
  readonly stderr: Readable;
  readonly exited: Promise<unknown>;
  terminate(): Promise<unknown>;
}

export type McpStdioSpawner = (request: ResolvedStdioMcpTransport) => Promise<McpDuplexProcess>;

/**
 * Standard newline-delimited MCP stdio framing over an injected duplex process.
 * Lathe uses this adapter when stdio is bound to a container or SSH execution
 * target; parsing and serialization come from the official MCP SDK.
 */
export class DuplexStdioClientTransport {
  onclose: Transport["onclose"] | undefined;
  onerror: Transport["onerror"] | undefined;
  onmessage: Transport["onmessage"] | undefined;

  readonly #buffer = new ReadBuffer();
  readonly #stderr = new PassThrough();
  readonly #request: ResolvedStdioMcpTransport;
  readonly #spawn: McpStdioSpawner;
  #process: McpDuplexProcess | undefined;
  #closed = false;

  constructor(request: ResolvedStdioMcpTransport, spawn: McpStdioSpawner) {
    this.#request = request;
    this.#spawn = spawn;
  }

  get stderr(): Readable {
    return this.#stderr;
  }

  async start(): Promise<void> {
    if (this.#process) throw new Error("Duplex stdio transport is already started");
    this.#closed = false;
    const process = await this.#spawn(this.#request);
    this.#process = process;
    process.stdin.on("error", (error) => this.onerror?.(error));
    process.stdout.on("data", (chunk: Buffer | Uint8Array | string) => {
      this.#buffer.append(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk));
      this.#drain();
    });
    process.stdout.on("error", (error) => this.onerror?.(error));
    process.stderr.pipe(this.#stderr, { end: false });
    process.exited.then(
      () => this.#didClose(),
      (error: unknown) => {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
        this.#didClose();
      },
    );
  }

  async send(message: JSONRPCMessage): Promise<void> {
    const process = this.#process;
    if (!process || this.#closed) throw new Error("MCP stdio transport is not connected");
    const serialized = serializeMessage(message);
    await new Promise<void>((resolve, reject) => {
      const onError = (error: Error) => {
        process.stdin.removeListener("drain", onDrain);
        reject(error);
      };
      const onDrain = () => {
        process.stdin.removeListener("error", onError);
        resolve();
      };
      process.stdin.once("error", onError);
      if (process.stdin.write(serialized)) {
        process.stdin.removeListener("error", onError);
        resolve();
      } else {
        process.stdin.once("drain", onDrain);
      }
    });
  }

  async close(): Promise<void> {
    if (this.#closed) return;
    this.#closed = true;
    const process = this.#process;
    this.#process = undefined;
    this.#buffer.clear();
    if (process) {
      try {
        process.stdin.end();
      } catch {
        // Termination below remains authoritative.
      }
      await process.terminate();
    }
    this.onclose?.();
  }

  #drain(): void {
    while (true) {
      try {
        const message = this.#buffer.readMessage();
        if (message === null) return;
        this.onmessage?.(message);
      } catch (error) {
        this.onerror?.(error instanceof Error ? error : new Error(String(error)));
      }
    }
  }

  #didClose(): void {
    if (this.#closed) return;
    this.#closed = true;
    this.#process = undefined;
    this.#buffer.clear();
    this.onclose?.();
  }
}
