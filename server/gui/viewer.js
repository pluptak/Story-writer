// Composition root -- wires the pieces under ./viewer/ together and starts the app. Everything a
// page needs to trigger a re-render reaches it through `APP.render` rather than importing pages.js
// directly, which is what keeps that module graph a DAG instead of a `pages.js ⇄ ...` cycle: only
// this file assigns it, once.
import { APP } from "./viewer/state.js";
import { render } from "./viewer/pages.js";
import { boot } from "./viewer/boot.js";
import { initLocator } from "./viewer/locator.js";
import "./viewer/nav.js";
import "./viewer/session.js";
import "./viewer/interview.js";
import "./viewer/handoff.js";
import "./viewer/story-edit.js";
import "./viewer/sse.js";
import "./viewer/chrome.js";
import "./viewer/character-card.js";

APP.render = render;
initLocator();
boot();
