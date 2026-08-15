import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { DuplexStdioClientTransport, type McpDuplexProcess } from "../src/index.js";

describe("execution-target-backed MCP stdio", () => {
  it("frames JSON-RPC over an injected duplex process and terminates it", async () => {
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const stderr = new PassThrough();
    let resolveExit: (() => void) | undefined;
    const exited = new Promise<void>((resolve) => { resolveExit = resolve; });
    let terminated = 0;
    const process: McpDuplexProcess = {
      stdin,
      stdout,
      stderr,
      exited,
      async terminate() {
        terminated += 1;
        resolveExit?.();
      },
    };
    const transport = new DuplexStdioClientTransport({
      kind: "stdio",
      command: "server",
      args: [],
      env: {},
      secretValues: [],
      executionTargetId: "container-r1",
    }, async () => process);
    const sent: Buffer[] = [];
    stdin.on("data", (chunk: Buffer) => sent.push(chunk));
    const received: unknown[] = [];
    transport.onmessage = (message) => received.push(message);

    await transport.start();
    await transport.send({ jsonrpc: "2.0", id: 1, method: "ping" });
    stdout.write('{"jsonrpc":"2.0","id":1,"result":{}}\n');
    await new Promise((resolve) => setImmediate(resolve));

    expect(Buffer.concat(sent).toString()).toBe('{"jsonrpc":"2.0","id":1,"method":"ping"}\n');
    expect(received).toEqual([{ jsonrpc: "2.0", id: 1, result: {} }]);
    await transport.close();
    expect(terminated).toBe(1);
  });
});
