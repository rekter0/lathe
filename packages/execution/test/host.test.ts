import { describe, expect, it } from "vitest";

import { HostExecutionAdapter } from "../src/targets/host.js";
import type { HostExecutionTarget } from "../src/types.js";

const target: HostExecutionTarget = {
  id: "local",
  label: "Local host",
  kind: "host",
};

describe("HostExecutionAdapter", () => {
  it("passes metacharacters as literal argv rather than invoking a shell", async () => {
    const adapter = new HostExecutionAdapter();
    const dangerous = "hello; printf injected && $(uname)";
    const result = await adapter.execute(target, {
      program: process.execPath,
      args: [
        "-e",
        "process.stdout.write(JSON.stringify(process.argv.slice(1)))",
        dangerous,
      ],
    });

    expect(result.status).toBe("completed");
    expect(result.stdout.text).toContain(dangerous);
    expect(result.cancellation).toBe("not_requested");
  });

  it("terminates a process after its timeout", async () => {
    const adapter = new HostExecutionAdapter();
    const result = await adapter.execute(target, {
      program: process.execPath,
      args: ["-e", "setInterval(() => {}, 1000)"],
      timeoutMs: 50,
    });

    expect(result.status).toBe("timed_out");
    expect(result.cancellation).toBe("confirmed");
  });

  it("stops and marks output when the combined byte cap is exceeded", async () => {
    const adapter = new HostExecutionAdapter();
    const result = await adapter.execute(target, {
      program: process.execPath,
      args: ["-e", "process.stdout.write('x'.repeat(20_000))"],
      maxOutputBytes: 1024,
    });

    expect(result.status).toBe("output_limited");
    expect(Buffer.from(result.stdout.base64, "base64")).toHaveLength(1024);
    expect(result.stdout.truncated).toBe(true);
    expect(result.stdout.totalBytes).toBeGreaterThan(1024);
  });

  it("honors AbortSignal cancellation", async () => {
    const adapter = new HostExecutionAdapter();
    const controller = new AbortController();
    const executing = adapter.execute(
      target,
      {
        program: process.execPath,
        args: ["-e", "setInterval(() => {}, 1000)"],
      },
      { signal: controller.signal },
    );
    controller.abort();

    await expect(executing).resolves.toMatchObject({
      status: "cancelled",
      cancellation: "confirmed",
    });
  });
});
