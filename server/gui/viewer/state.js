import { basename } from "./util.js";

// Shared runtime state. ESM can't share a writable `let` across modules — any module that
// imports a binding gets a read-only view of it — so everything that gets REASSIGNED from
// outside its own module lives as a field on one exported object, `APP`, the same trick
// live.ts's `LIVE`/`RUN` use engine-side. Values that are only ever mutated in place
// (`.field = x`, `.add()`/`.delete()`) don't need that: a plain `export const` already lets
// any importer reach in and change them.
//
const newStore = () => ({ events: [], seen: new Set(), meta: null, open: new Set(), source: "", isLive: false, label: "", dir: "", id: "" });

export const LIVEV = newStore();          // the running (or just-finished) scene
export const READV = newStore();          // a saved run, loaded read-only

export const APP = {
  view: "live",               // which page is showing: shelf | story | live | read
  live: false,                 // attached to a running engine, as opposed to a static/file:// load
  session: { running:false, stopping:false, where:"", picking:false, armed:false,
             paused:false, pausing:false, model:null, interactive:true },  // the process, not the story
  composing: null,             // ephemeral: {who, secs, chars} -- live only
  armed: 0,                    // timer id: the stop button is waiting for its confirming second click
  stories: null,                // story cards from /stories -- feeds the shelf and the story page
  picked: "",                  // a choice already sent; keeps a double-click from being two picks
  storyDir: "",                 // a shelf card was clicked; the story page is showing this dir
  storyModel: "",               // a model chosen on the story page, overriding the story's own default
  storyError: "",               // the last refusal of /select or /model, said out loud on the story page
  runError: "",                 // the engine failed to load or run the picked story, shown on the story page
  runEnded: null,                // the run just finished: {done, stopped, words, steps} -- the end-of-
                                  // run modal is up until "back to shelf" or "stay here" clears it
  charCard: null,               // a character pill was clicked: {name, dir, can, cannot} -- the
                                 // character card modal is up for them
  scaffold: { active:false },  // the interview, from /scaffold and its SSE frames
  ideaOpen: false,             // "new story…" clicked; no interview on the server yet
  ivHidden: false,             // the interview modal is closed WITHOUT abandoning it -- reopened
                                // by the same "new story…" card, which relabels itself while it is true
  personasFull: false,
  acceptArmed: 0,               // timer id: accepting over a complaint (or over unsent text) wants a second click
  abandonArmed: 0,              // timer id: so does throwing the whole interview away
  scaffoldError: "",            // the last refusal from /scaffold/*, said out loud in the modal
  modelIds: [],                 // what LM Studio has loaded; fetched once, used by both dropdowns
  modelDefault: "",             // the model an interview would use if you chose nothing
  expandAll: false,
  wantReaderView: false,        // a reader consult just arrived: scroll to it once the run page is showing
  awaitingReader: false,        // that consult is still unanswered -- the run is blocked on a human, not
                                 // just "in progress" (tabdot, tab label, document.title all read this).
                                 // Hand-tracked, not derived: render() runs on every SSE frame regardless
                                 // of which page is showing, so deriving it would mean rebuilding the
                                 // whole live event log on every frame just to read one boolean off it.
  readerError: null,            // the reader's own last refusal, shown beside its own card: {seq, text}
  render: () => {},             // set once, from viewer.js, to the real page-render function
};

/** A story's display name off the shelf list, falling back to its folder name. */
export const storyName = dir => (APP.stories || []).find(s => s.dir === dir)?.name || basename(dir || "");

// Re-render is whole, which would otherwise eat what you are typing mid-round. Drafts live out
// here and are written back in; focus is read off the document as the render begins, rather than
// tracked through focus/blur -- removing a focused node does not reliably fire blur, and a click on
// any button would clear a tracked value before the re-render it triggered.
export const draft = { idea:"", say:"", folder:"", model:"", length:"" };
export const FIELDS = /^f-(idea|say|folder|model|length)$/;

/** Which consults are expanded, by seq — shared across pages on purpose: it is a reading
 *  preference ("I like things opened up"), not a fact tied to one particular run. */
export const open = new Set();
