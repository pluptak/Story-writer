import { basename } from "./util.js";

// Shared runtime state. ESM can't share a writable `let` across modules — any module that
// imports a binding gets a read-only view of it — so everything that gets REASSIGNED from
// outside its own module lives as a field on one exported object, `APP`, the same trick
// live.ts's `LIVE`/`RUN` use engine-side. Values that are only ever mutated in place
// (`.field = x`, `.add()`/`.delete()`) don't need that: a plain `export const` already lets
// any importer reach in and change them.
//
export const newStore = () => ({ events: [], seen: new Set(), meta: null, source: "", isLive: false, label: "", dir: "", id: "", agentStats: {}, loadReq: 0 });
export const newAgentState = () => ({ agents: null, agentsError: "", transcript: null, transcriptError: "", callOpen: -1 });

export const LIVEV = newStore();          // the running (or just-finished) scene
export const READV = newStore();          // a saved run, loaded read-only
export const COMPAREV = { a: newStore(), b: newStore(), loading: false, error: "", key: "" };
export const COMPARE_AGENTS = { a: newAgentState(), b: newAgentState() };
export const READER = {                  // the story reader view: accepted prose by chapter
  dir: "", chapters: [], loading: false, error: "", query: "",
};

export const APP = {
  view: "live",               // which page is showing: shelf | story | live | read | readstory | compare | handoff | edit | scaffold
  live: false,                 // attached to a running engine, as opposed to a static/file:// load
  session: { running:false, stopping:false, where:"", picking:false, loading:false, armed:false,
             paused:false, pausing:false, model:null, interactive:true },  // the process, not the story
  composing: null,             // ephemeral: {who, secs, chars} -- live only
  armed: 0,                    // timer id: the stop button is waiting for its confirming second click
  stories: null,                // story cards from /stories -- feeds the shelf and the story page
  picked: "",                  // a choice already sent; keeps a double-click from being two picks
  storyDir: "",                 // a shelf card was clicked; the story page is showing this dir
  storyModel: "",               // a model chosen on the story page, overriding the story's own default
  storyError: "",               // the last refusal of /select or /model, said out loud on the story page
  compareDir: "",               // story whose retained runs are being compared
  compareA: "",                 // first retained run selected for comparison
  compareB: "",                 // second retained run selected for comparison
  compareError: "",             // invalid or incomplete comparison selection
  chapter: null,                // {dir, n, text}: a written chapter opened inline on the story page.
                                 // It carries its own dir because reaching the shelf by the tab does
                                 // not clear it -- chapter 1 of one story must never render under
                                 // chapter 1 of another.
  chapterError: "",             // that chapter would not load
  agents: null,                 // {dir, id, logs[]}: /runs/llm for the run being read. Carries its
                                 // own dir+id for the same reason `chapter` does -- one run's agents
                                 // must never render under another's
  agentsError: "",              // /runs/llm refused or did not answer
  transcript: null,             // {dir, id, file, calls[]}: one agent's transcript, opened on demand
  transcriptError: "",          // that transcript would not load
  callOpen: -1,                 // index of the one call expanded in the open transcript, or -1
  runError: "",                 // the engine failed to load or run the picked story, shown on the story page
  runEnded: null,                // the run just finished: {done, stopped, words, steps} -- the end-of-
                                  // run modal is up until "back to shelf" or "stay here" clears it
  charCard: null,               // a character pill was clicked: {name, dir, can, cannot} -- the
                                 // character card modal is up for them
  modalWant: "",                // deep link pending: "character-card:<name>" from &modal= -- resolved
                                 // against rendered chips once one for that name is on screen
  focusSeq: null,               // deep link / timeline jump target: the seq of the consult block to
                                 // scroll to and open on live or read (&block=)
  focusScrolled: false,         // settleFocus scrolls once per focusSeq change, not every frame
  scaffold: { active:false },  // the interview, from /scaffold and its SSE frames
  scaffoldAccepting: false,    // an accept is in flight. The server publishes {active:false} BEFORE
                                // the run starts, so without this the scaffold page would fall back to
                                // the idea modal in the window between the two.
  folderOpen: false,           // the sidebar's accept opened the folder step locally — the server only
                                // forces it open through needsFolder
  ideaOpen: false,             // kept for compatibility; the scaffold page now owns the idea step
  ivHidden: false,             // kept for compatibility; the scaffold page is a route, not an overlay
  personasFull: false,
  acceptArmed: 0,               // timer id: accepting over a complaint (or over unsent text) wants a second click
  abandonArmed: 0,              // timer id: so does throwing the whole interview away
  scaffoldError: "",            // the last refusal from /scaffold/*, said out loud in the modal
  handoff: { active:false },   // the between-chapters handoff, from /next-chapter and its SSE frames
  handoffDir: "",              // which story the handoff page is showing
  handoffModel: "",             // a model chosen on the handoff start screen, overriding the
                                 // architect default -- seeded to the story's own default model
                                 // (when it's loaded) the moment the handoff page is opened
  handoffError: "",            // the last refusal from /next-chapter/*, said on the handoff page
  handoffDone: null,           // accepted: {dir, chapter, warnings[]} -- the server drops its session
                                // on accept, so the "chapter N is prepared" state has to live here
  handoffAccepting: false,     // an accept is in flight. The server publishes {active:false} BEFORE it
                                // answers the POST, so without this the page falls back to the start
                                // screen -- with a live start button -- between the two.
  handoffChapters: null,       // {dir, chapter, loading, items:[{n, place, words, error}]}: the word
                                // counts for the "chapters written" list, one /chapter fetch each.
                                // Keyed by dir+prepared-chapter so it refetches when either changes.
  hAcceptArmed: 0,             // timer id: accepting a handoff wants a second click
  hAbandonArmed: 0,            // so does throwing it away
  // Story editor state
  editDir: "",                 // which story is being edited
  editNew: false,               // the in-memory scaffold draft, not a story on disk
  editFor: "",                 // which story editStory/editDraft were loaded FOR -- the load trigger
                                // keys on this, not on editStory being null, or story A's draft
                                // survives into story B's editor and can be saved over B
  editStory: null,             // the loaded story.json (Zod-parsed)
  editLoading: false,          // a /story/edit fetch is in flight. The editor starts its own load
                                // from its wiring, which runs on every render -- without this, the
                                // render that load schedules starts another one, forever.
  editWarnings: [],            // warnings from load
  editError: "",               // load/validation error
  editDraft: null,             // modified version (=== editStory initially)
  editIssues: [],              // live validation issues [{path, message}]
  editDirty: false,            // true if draft differs from loaded
  editSaving: false,           // save in flight
  editCheckTimer: null,        // debounce timer for /story/check
  editSuggestOpen: false,      // architect suggestion panel expanded
  editSuggestText: "",         // draft text in the suggestion textarea
  editSuggestBusy: false,      // suggestion in flight
  editSuggestResult: null,     // {ok, kind, applied, ignored, problems, note} from /story/suggest
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
  cast: null,                   // {dir, characters, loading, error}: the live screen's read-only
                                 // character sheet, fetched from /cast for LIVEV.meta.story. dir-keyed
                                 // so a new story's run refetches instead of showing the last cast.
  render: () => {},             // set once, from viewer.js, to the real page-render function
};

/** A story's display name off the shelf list, falling back to its folder name. */
export const storyName = dir => (APP.stories || []).find(s => s.dir === dir)?.name || basename(dir || "");

/** Why a control that touches story.json or starts a run is disabled while the session is busy —
 *  the story and handoff pages both explain themselves this way rather than round-tripping to find
 *  out. Empty string when nothing is in the way (the loading window after a pick counts). */
export const runningReason = () => APP.session.running ? "a scene is being written — stop it first"
  : APP.session.loading ? "a story is loading — try again in a moment" : "";

/** The server keeps one handoff session at a time, but the handoff PAGE is about one story
 *  (`handoffDir`, from the URL). A session left open on story A must not render under story B when
 *  B's page is opened by URL/reload — treat it as "nothing open" when the dirs disagree, the same
 *  guard the story page uses (`APP.handoff.dir === s.dir`). */
export const handoffForPage = () =>
  APP.handoff.active && APP.handoff.dir === APP.handoffDir ? APP.handoff : { active: false };

// Re-render is whole, which would otherwise eat what you are typing mid-round. Drafts live out
// here and are written back in; focus is read off the document as the render begins, rather than
// tracked through focus/blur -- removing a focused node does not reliably fire blur, and a click on
// any button would clear a tracked value before the re-render it triggered.
export const draft = { idea:"", say:"", folder:"", model:"", mode:"", length:"" };
export const hdraft = { say:"" };

export const FIELDS = /^[fh]-(idea|say|folder|model|mode|length)$|^r-say-\d+$/;
// r-say-N is the live reader consult's own-answer box (blocks.js) -- it holds half-typed text too,
// and the SSE frames that arrive while the run waits on you re-render just as eagerly.

/** Which consults are expanded, by seq — shared across pages on purpose: it is a reading
 *  preference ("I like things opened up"), not a fact tied to one particular run. */
export const open = new Set();
