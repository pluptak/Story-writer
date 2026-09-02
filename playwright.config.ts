/** Playwright GUI tests — the viewer driven in-process: tests/gui/harness.ts binds the real
 *  server/server.ts with a fixture ServerHost (no LM Studio, no child process) and hands each
 *  test a page already pointed at it. Run with `npm run test:gui`. No webServer here on purpose:
 *  the harness owns the bind, so the config only shapes the runner. */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: "./tests/gui",
  testMatch: "**/*.spec.ts",
  // The server and live.ts hold module singletons (the started server, LIVE, liveHistory) in this
  // same process — parallel workers would clobber each other, so one worker, files in order.
  fullyParallel: false,
  workers: 1,
  reporter: [["list"]],
  use: {
    // The viewer's stable-locator attribute (util.js tid()); every getByTestId below reads it.
    testIdAttribute: "data-tid",
    trace: "retain-on-failure",
  },
  projects: [{ name: "chromium", use: { ...devices["Desktop Chrome"] } }],
});
