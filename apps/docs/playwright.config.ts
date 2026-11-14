import { defineConfig } from "@playwright/test";

export default defineConfig({
  testDir: "./test",
  testMatch: "**/*.pw.ts",
  outputDir: "./test-results",
  workers: 1,
  use: {
    userAgent:
      "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/145.0.0.0 Safari/537.36",
    trace: "retain-on-failure",
    baseURL: "http://127.0.0.1:48973",
    launchOptions: { executablePath: process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH },
  },
  webServer: {
    command: "bun run build && bun run preview --host 127.0.0.1 --port 48973 --ignore-lock",
    url: "http://127.0.0.1:48973/docs/",
    reuseExistingServer: false,
    env: {
      PUBLIC_POSTHOG_KEY: "phc_browser_test",
      PUBLIC_POSTHOG_HOST: "https://posthog.test",
    },
  },
});
