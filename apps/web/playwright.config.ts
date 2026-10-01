import { resolve } from "node:path";
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./e2e",
  testIgnore: "**/workspace-real-api.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 60_000,
  expect: { timeout: 15_000 },
  use: { baseURL: "http://127.0.0.1:3491", trace: "retain-on-failure" },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
  webServer: [
    {
      command: "node e2e/api-fixture.mjs",
      url: "http://127.0.0.1:4491/health",
      reuseExistingServer: false,
    },
    {
      command:
        "node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3491",
      url: "http://127.0.0.1:3491/login",
      reuseExistingServer: false,
      timeout: 120_000,
      env: {
        FACILITY_API_URL: "http://127.0.0.1:4491",
        NEXT_TELEMETRY_DISABLED: "1",
        NEXT_FONT_GOOGLE_MOCKED_RESPONSES: resolve(import.meta.dirname, "e2e/fonts.cjs"),
      },
    },
  ],
});
