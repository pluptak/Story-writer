/** The capture run: the same in-process viewer the GUI tests drive (tests/gui/harness.ts), but the
 *  assertions are replaced by snapshots. It writes standalone HTML into mockups/current/ — the
 *  design reference for "what the app looks like today".
 *
 *  Deliberately NOT under tests/gui: `npm run test:gui` matches `**\/*.spec.ts`, and a capture is
 *  not a test — it asserts almost nothing and it writes into the repo. Run it with
  *  `npm run capture` (playwright test -c docs/mockups/capture/capture.config.ts).
 *
 *  mockups/ is eslint-ignored and outside tsconfig's `include`, so this file and its siblings add
 *  nothing to the checked surface. */
import { defineConfig, devices } from "@playwright/test";

export default defineConfig({
  testDir: ".",
  testMatch: "**/*.capture.ts",
  // The harness binds a real server and touches live.ts's module singletons — same reason
  // playwright.config.ts runs one worker in file order.
  fullyParallel: false,
  workers: 1,
  retries: 0,
  reporter: [["list"]],
  use: {
    testIdAttribute: "data-tid",
    colorScheme: "light",
  },
  // The viewport goes AFTER the device spread, not in the top-level `use`: a project's own `use`
  // wins, and Desktop Chrome's 1280×720 would otherwise silently take back the wider frame. The
  // viewer is a three-column layout and a capture is meant to show the rail and the sidenav beside
  // the page, not wrapped under it.
  projects: [{
    name: "chromium",
    use: { ...devices["Desktop Chrome"], viewport: { width: 1440, height: 960 } },
  }],
});
