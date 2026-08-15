import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { localSecurity } from "../src/security.js";

function securedApp() {
  const app = new Hono();
  app.use("*", localSecurity("secret-token"));
  app.get("/api/health", (context) => context.json({ ok: true }));
  app.post("/api/change", (context) => context.json({ ok: true }));
  return app;
}

describe("local origin security", () => {
  it("rejects non-loopback request URLs and Host headers before serving health or static content", async () => {
    const app = securedApp();
    expect((await app.request("http://attacker.example/api/health")).status).toBe(403);
    expect((await app.request("http://127.0.0.1/api/health", { headers: { host: "attacker.example" } })).status).toBe(403);
    expect((await app.request("http://127.42.0.9/api/health")).status).toBe(200);
  });

  it("requires exact browser origin and rejects cross-site mutation metadata", async () => {
    const app = securedApp();
    const authorization = "Bearer secret-token";
    expect((await app.request("http://127.0.0.1:4317/api/change", {
      method: "POST",
      headers: { authorization, origin: "http://127.0.0.1:9999" }
    })).status).toBe(403);
    expect((await app.request("http://127.0.0.1:4317/api/change", {
      method: "POST",
      headers: { authorization, origin: "http://127.0.0.1:4317", "sec-fetch-site": "cross-site" }
    })).status).toBe(403);
    expect((await app.request("http://127.0.0.1:4317/api/change", {
      method: "POST",
      headers: { authorization, origin: "http://127.0.0.1:4317", "sec-fetch-site": "same-origin" }
    })).status).toBe(200);
  });

  it("keeps bearer-authenticated CLI mutations working without browser headers", async () => {
    const response = await securedApp().request("http://localhost/api/change", {
      method: "POST",
      headers: { authorization: "Bearer secret-token" }
    });
    expect(response.status).toBe(200);
  });
});
