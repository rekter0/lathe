import { describe, expect, it } from "vitest";
import { EventHub } from "../src/events.js";

describe("SSE event hub", () => {
  it("cancels only the requesting subscriber on a shared channel", async () => {
    const hub = new EventHub();
    const first = hub.stream("session:one").getReader();
    const secondAbort = new AbortController();
    const second = hub.stream("session:one", 0, secondAbort.signal).getReader();

    await first.cancel();
    hub.publish("session:one", "node.created", { id: "node-1" });
    const frame = await second.read();
    expect(new TextDecoder().decode(frame.value)).toContain("node.created");
    secondAbort.abort();
  });
});
