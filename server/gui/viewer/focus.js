import { $ } from "./util.js";
import { APP } from "./state.js";

// ---- focus mode -----------------------------------------------------------
// A writer-first, distraction-free way to read the two prose views (live writing and the
// manuscript): navigation, run statistics, the cast rail, engine metadata and secondary
// controls hide behind one body class, while prose, scene identity, the author's decision
// controls (reader consults, budget prompt, stop/pause/consult-me) and the run itself stay
// exactly where they are. No new page and no data-model change: this is a class toggle plus
// two static buttons, so entering or leaving preserves scroll, drafts, expand-all, consult
// open/closed state and the run -- nothing re-renders, nothing refetches. Leaving either
// view exits the mode (nav.js), so a shelf or story page never inherits a hidden sidenav.

/** Focus mode only exists on the prose views: the live run and the manuscript. */
export const isFocusView = () => APP.view === "live" || APP.view === "readstory";
export const focusOn = () => APP.focus && isFocusView();

export function enterFocus() {
  if (!isFocusView() || focusOn()) return;
  APP.focus = true;
  paintFocus();
  // The topbar (with the button just clicked) hides with the mode, so keyboard users land on
  // the obvious way back out instead of losing focus into a hidden subtree.
  $("focusexit")?.focus();
}

export function exitFocus() {
  if (!APP.focus) return;
  APP.focus = false;
  paintFocus();
  // Return focus to the way back in, when it is on screen -- exiting otherwise strands the
  // caret on a hidden button.
  const btn = $("focusbtn");
  if (btn && !btn.hidden) btn.focus();
}

export function toggleFocus() { focusOn() ? exitFocus() : enterFocus(); }

/** Body class plus the two static buttons. Called from render() (pages.js) so every repaint --
 *  including SSE frames mid-run -- keeps the chrome in agreement with the flag. */
export function paintFocus() {
  const on = focusOn();
  document.body.classList.toggle("focus", on);
  const enter = $("focusbtn");
  if (enter) {
    enter.hidden = !isFocusView();
    enter.setAttribute("aria-pressed", on ? "true" : "false");
  }
  const exit = $("focusexit");
  if (exit) exit.hidden = !on;
}

$("focusbtn").onclick = () => toggleFocus();
$("focusexit").onclick = () => exitFocus();

// Keyboard: `f` toggles on the prose views, Escape leaves (after any modal -- chrome.js owns
// the topmost-backdrop close, and an open modal means the keystroke isn't ours). Typing the
// letter in an input, a reader answer box, the manuscript search or a select never toggles:
// those targets own their keystrokes.
addEventListener("keydown", e => {
  if (e.metaKey || e.ctrlKey || e.altKey) return;
  if (e.key === "Escape") {
    if (!focusOn() || document.querySelector(".modal-backdrop")) return;
    e.preventDefault();
    exitFocus();
    return;
  }
  if (e.key.toLowerCase() !== "f") return;
  if (!isFocusView() || document.querySelector(".modal-backdrop")) return;
  const t = e.target;
  if (t && (t.tagName === "INPUT" || t.tagName === "TEXTAREA" || t.tagName === "SELECT" || t.isContentEditable)) return;
  e.preventDefault();
  toggleFocus();
});
