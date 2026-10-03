import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: /.*\.spec\.mjs$/,
  timeout: 180_000,
  retries: 0, // a flaky editor test should be seen, not hidden
  workers: 1, // the editor test edits one shared page
  reporter: [["list"], ["html", { outputFolder: "out/report", open: "never" }]],
  outputDir: "out/results",
  use: {
    ...devices["Desktop Chrome"],
    // Traces record request headers (the Bearer token). Never keep them in CI,
    // where out/ is uploaded as an artifact.
    trace: process.env.CI ? "off" : "retain-on-failure",
    screenshot: "only-on-failure",
  },
});
