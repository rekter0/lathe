import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createFixtureServer } from "./fixture-server.mjs";

const secret = process.env.FIXTURE_SECRET ?? "missing-fixture-secret";
const fixture = createFixtureServer(secret);
await fixture.server.connect(new StdioServerTransport());
process.stderr.write(`fixture ready with ${secret}\n`);

async function shutdown() {
  fixture.cleanup();
  await fixture.server.close().catch(() => undefined);
}

process.once("SIGTERM", () => {
  void shutdown().finally(() => process.exit(0));
});
process.once("SIGINT", () => {
  void shutdown().finally(() => process.exit(0));
});
