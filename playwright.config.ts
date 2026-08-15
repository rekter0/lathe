import { tmpdir } from "node:os";
import { join } from "node:path";
import { defineConfig, devices } from "@playwright/test";

export const E2E_PORT = 4318;
export const E2E_PROVIDER_PORT = 4319;
export const E2E_TOKEN = "lathe-playwright-local-token";

const dataDirectory = join(tmpdir(), "lathe-playwright-e2e");

export default defineConfig({
  testDir: "./e2e",
  fullyParallel: false,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  workers: 1,
  timeout: 30_000,
  expect: { timeout: 8_000 },
  reporter: process.env.CI ? [["line"], ["html", { open: "never" }]] : "list",
  use: {
    baseURL: `http://127.0.0.1:${E2E_PORT}`,
    trace: "retain-on-failure",
    screenshot: "only-on-failure",
    video: "retain-on-failure"
  },
  webServer: [
    {
      command: "pnpm start",
      url: `http://127.0.0.1:${E2E_PORT}/api/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 180_000,
      env: {
        LATHE_HOST: "127.0.0.1",
        LATHE_PORT: String(E2E_PORT),
        LATHE_API_TOKEN: E2E_TOKEN,
        LATHE_DATA_DIR: dataDirectory,
        LATHE_DATABASE_URL: join(dataDirectory, "lathe.sqlite")
      }
    },
    {
      command: "node e2e/fixtures/provider-server.mjs",
      url: `http://127.0.0.1:${E2E_PROVIDER_PORT}/health`,
      reuseExistingServer: !process.env.CI,
      timeout: 30_000,
      env: { LATHE_E2E_PROVIDER_PORT: String(E2E_PROVIDER_PORT) }
    }
  ],
  projects: [
    {
      name: "chromium",
      use: { ...devices["Desktop Chrome"] }
    }
  ]
});
