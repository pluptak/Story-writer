// ESLint, flat config.
//
// What this covers and why: `npx tsc` already reads every TypeScript file in tsconfig's `include`,
// so the engine and the server are checked. Nothing read the viewer's browser-loaded ES modules
// under server/gui/ — they are not in that `include`. This replaced `npm run checkgui`, which ran
// `node --check` over each of those files one at a time and so could only ever catch outright
// syntax errors; linting them together also resolves names across modules, which is what caught
// `story-page.js` calling an unimported `loadStories()`.
//
// TypeScript is NOT linted here yet. typescript-eslint refuses to load against TypeScript 7 (it
// peer-caps at <6.1.0), and the only way to satisfy it under npm is to pull the ROOT typescript
// down to 6.x, which would quietly downgrade `npx tsc` too. Upstream tracks TS 7 support in
// typescript-eslint#10940; when it lands, add a `**/*.ts` block extending
// `tseslint.configs.recommended` and nothing else here has to change.
import js from "@eslint/js";
import globals from "globals";

export default [
  {
    ignores: [
      "node_modules/**",
      "stories/**",      // the user's own content, gitignored
      "**/out/**",       // run artifacts
      "mockups/**",      // static design mockups, not shipped code
      ".continue/**",
    ],
  },

  // The viewer's browser modules: `viewer.js` and everything it wires together under viewer/.
  {
    files: ["server/gui/**/*.js"],
    ...js.configs.recommended,
    languageOptions: {
      globals: globals.browser,
      ecmaVersion: 2022,
      sourceType: "module",
    },
    rules: {
      ...js.configs.recommended.rules,
      // An unused function argument is often documentation of a signature; an unused LOCAL is dead
      // code. `_`-prefixed names opt out, and a caught error nobody reads is idiomatic here.
      "no-unused-vars": ["error", { args: "none", varsIgnorePattern: "^_", caughtErrors: "none" }],
      // `try { localStorage.setItem(...) } catch {}` is the house idiom for a best-effort call whose
      // failure is genuinely nothing: a private-mode storage write, a setSelectionRange on an input
      // that does not support it. An empty block anywhere ELSE is still an error.
      "no-empty": ["error", { allowEmptyCatch: true }],
    },
  },

  // Build/check helpers.
  {
    files: ["scripts/**/*.mjs"],
    ...js.configs.recommended,
    languageOptions: { globals: globals.node, sourceType: "module", ecmaVersion: 2022 },
    rules: { ...js.configs.recommended.rules },
  },
];
