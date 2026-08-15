import { randomBytes } from "node:crypto";
import { access } from "node:fs/promises";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createPersistence } from "@lathe/db";
import { builtInAssets } from "@lathe/harness";
import { createApp } from "./app.js";
import { CodexAppServerPayloadGenerator } from "./codex-payload-generator.js";
import { EventHub } from "./events.js";
import { PayloadGenerationCoordinator } from "./payload-generation-coordinator.js";
import { ProviderRunCoordinator } from "./provider-run-coordinator.js";
import { JobCoordinator } from "./job-coordinator.js";

const host = process.env.LATHE_HOST ?? "127.0.0.1";
if (!["127.0.0.1", "localhost", "::1"].includes(host)) {
  throw new Error("Lathe v1 only binds to a loopback host. Set LATHE_HOST to 127.0.0.1, localhost, or ::1.");
}
const port = Number(process.env.LATHE_PORT ?? 4317);
if (!Number.isSafeInteger(port) || port < 1 || port > 65_535) throw new Error("LATHE_PORT must be a valid TCP port");

const persistence = await createPersistence();
for (const asset of builtInAssets) await persistence.repository.saveAssetRevision(asset);

const events = new EventHub();
const token = process.env.LATHE_API_TOKEN ?? randomBytes(32).toString("base64url");
const coordinator = new ProviderRunCoordinator(persistence.repository, persistence.contentStore, events);
const payloadCoordinator = new PayloadGenerationCoordinator(
  persistence.repository,
  persistence.contentStore,
  events,
  globalThis.fetch,
  new CodexAppServerPayloadGenerator(persistence.contentStore)
);
const jobCoordinator = new JobCoordinator(persistence.repository, coordinator, events);
const app = createApp({
  repository: persistence.repository,
  contentStore: persistence.contentStore,
  events,
  runCoordinator: coordinator,
  apiToken: token,
  dataDirectory: persistence.dataDirectory,
  jobCoordinator,
  payloadCoordinator
});

const webRoot = resolve(import.meta.dirname, "../../web/dist");
const hasWebBuild = await access(webRoot).then(() => true).catch(() => false);
if (hasWebBuild) {
  app.use("/*", serveStatic({ root: webRoot }));
  app.get("*", serveStatic({ path: resolve(webRoot, "index.html") }));
}

const server = serve({ fetch: app.fetch, hostname: host, port });
const displayHost = host === "::1" ? "[::1]" : host;
const appUrl = hasWebBuild
  ? `http://${displayHost}:${port}/?token=${encodeURIComponent(token)}`
  : `${process.env.LATHE_WEB_URL ?? "http://127.0.0.1:5173"}/?token=${encodeURIComponent(token)}`;

console.log(`Lathe is ready: ${appUrl}`);
console.log(`Data directory: ${persistence.dataDirectory} (${persistence.repository.dialect})`);
console.warn("Security notice: provider and static MCP credentials are stored plaintext. Lathe redacts ordinary API responses and exports.");

let closing = false;
const shutdown = async () => {
  if (closing) return;
  closing = true;
  server.close();
  await persistence.repository.close();
};
process.once("SIGINT", () => void shutdown());
process.once("SIGTERM", () => void shutdown());
