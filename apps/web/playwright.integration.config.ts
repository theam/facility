import { defineConfig } from "@playwright/test";
import base from "./playwright.config";

export default defineConfig({
  ...base,
  testMatch: "**/workspace-real-api.spec.ts",
  testIgnore: [],
  use: { ...base.use, baseURL: "http://127.0.0.1:3492" },
  webServer: [
    {
      command:
        "node ../../services/api/node_modules/tsx/dist/cli.mjs ../../services/api/test/fixtures/browser-api.ts",
      url: "http://127.0.0.1:4492/health",
      reuseExistingServer: false,
      timeout: 120_000,
    },
    {
      ...(base.webServer as Array<object>)[1],
      command:
        "node node_modules/next/dist/bin/next dev --webpack --hostname 127.0.0.1 --port 3492",
      url: "http://127.0.0.1:3492/login",
      env: {
        ...(base.webServer as Array<{ env?: Record<string, string> }>)[1]?.env,
        FACILITY_API_URL: "http://127.0.0.1:4492",
      },
    },
  ],
});
