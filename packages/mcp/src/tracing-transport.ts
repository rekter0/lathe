import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import type { McpServerProfile, McpTraceSink } from "./types.js";
import { redactJson } from "./redaction.js";

interface TracingTransportOptions {
  profile: McpServerProfile;
  secrets: readonly string[];
  redactionEnabled: boolean;
  sink?: McpTraceSink;
}

async function safelyRecord(
  sink: McpTraceSink | undefined,
  event: Parameters<McpTraceSink["record"]>[0],
): Promise<void> {
  if (!sink) return;
  try {
    await sink.record(event);
  } catch {
    // A broken audit sink must not break or alter MCP protocol behavior.
  }
}

/** Captures decoded JSON-RPC traffic while delegating framing to the official SDK. */
export class TracingTransport implements Transport {
  onclose?: NonNullable<Transport["onclose"]>;
  onerror?: NonNullable<Transport["onerror"]>;
  onmessage?: NonNullable<Transport["onmessage"]>;
  sessionId?: string;

  readonly #inner: Transport;
  readonly #options: TracingTransportOptions;
  #protocolVersion?: string;

  constructor(inner: Transport, options: TracingTransportOptions) {
    this.#inner = inner;
    this.#options = options;

    inner.onclose = () => {
      void this.#record("internal", "info", "transport.closed");
      this.onclose?.();
    };
    inner.onerror = (error) => {
      void this.#record("internal", "error", "transport.error", undefined, {
        name: error.name,
        message: error.message,
      });
      this.onerror?.(error);
    };
    inner.onmessage = (message, extra) => {
      void this.#record("inbound", "debug", "transport.message", undefined, message);
      this.onmessage?.(message, extra);
    };
  }

  get protocolVersion(): string | undefined {
    return this.#protocolVersion;
  }

  async start(): Promise<void> {
    await this.#inner.start();
    if (this.#inner.sessionId !== undefined) this.sessionId = this.#inner.sessionId;
  }

  async close(): Promise<void> {
    await this.#inner.close();
  }

  async send(...args: Parameters<Transport["send"]>): Promise<void> {
    await this.#record("outbound", "debug", "transport.message", undefined, args[0]);
    await this.#inner.send(...args);
  }

  setProtocolVersion(version: string): void {
    this.#protocolVersion = version;
    this.#inner.setProtocolVersion?.(version);
  }

  async #record(
    direction: "inbound" | "outbound" | "internal",
    level: "debug" | "info" | "warning" | "error",
    event: Parameters<McpTraceSink["record"]>[0]["event"],
    method?: string,
    payload?: unknown,
  ): Promise<void> {
    await safelyRecord(this.#options.sink, {
      at: new Date().toISOString(),
      profileId: this.#options.profile.id,
      profileRevision: this.#options.profile.revision,
      transport: this.#options.profile.transport.kind,
      direction,
      level,
      event,
      ...(method === undefined ? {} : { method }),
      ...(payload === undefined ? {} : { payload: redactJson(payload, this.#options.secrets, this.#options.redactionEnabled) }),
    });
  }
}
