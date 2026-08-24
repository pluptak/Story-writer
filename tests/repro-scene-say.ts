/** TEMP reproduction: drive a staged scaffold to the scene gate, then press send. */
import { ScaffoldSession } from "../engine/architect.ts";
import type { Defaults } from "../engine/story-format.ts";
import { LIVE, resetLive } from "../live.ts";
import { handleScaffoldRoutes } from "../server/scaffold-routes.ts";
import type { ServerHost } from "../server/server.ts";
import { callRoute, quiet, ScriptedAgent } from "./helpers.ts";

const DEFAULTS: Defaults = {
  models: { default: "none", architect: "none" },
  thinking: { architect: "low" },
  requestTimeout: 120, attempts: 3, maxTokens: 2000, stream: false, debug: false,
};

const STORY_STAGE = {
  title: "The Fog Signal",
  premise: "Two keepers, one lamp.",
  tension: "Aster wants the log kept honest; Brae wants the night buried.",
};
const CAST_STAGE = {
  characters: [
    { name: "ASTER", persona: "Keeps the log.", knows: "It did not fire.", goal: "An honest log",
      belief: "Logs are sacred.", impulse: "when doubted, quotes the book", voice: ["The log is the log."],
      skills: [], restrictions: [] },
  ],
};
const SETTINGS_STAGE = { writer_style: "Lean coastal prose." };
const SCENE_STAGE = {
  scene: { place: "the lamp room", question: "Does Aster falsify the log?", pov: "ASTER", length: 800 },
};
const VERIFY_OK = { note: "checked" };
const EDITS_REPLY = { edits: [{ field: "scene.question", value: "Will Aster burn the log?" }] };

const script = [
  JSON.stringify(STORY_STAGE),
  JSON.stringify(CAST_STAGE),
  JSON.stringify(SETTINGS_STAGE),
  JSON.stringify({}),                       // technical: optional, may come back empty
  JSON.stringify(SCENE_STAGE),
  JSON.stringify(VERIFY_OK),                // the verify pass after the scene lands
  JSON.stringify(EDITS_REPLY),              // the send at the scene gate
];

const host = {
  loadedModelIds: async () => null,
  specView: (s: unknown) => s,
  newScaffoldSession: async () =>
    new ScaffoldSession(new ScriptedAgent(script), DEFAULTS, "two keepers", undefined, "staged"),
} as unknown as ServerHost;

const post = (path: string, body: unknown = {}) =>
  quiet(() => callRoute(handleScaffoldRoutes, path, body, host));

resetLive();
LIVE.awaitingPick = true;

const opened = await post("/scaffold/start", { idea: "two lighthouse keepers" });
console.log("start gate:", opened.body.gate);

const a1 = await post("/scaffold/approve");
console.log("approve 1 gate:", a1.body.gate);
const a2 = await post("/scaffold/approve");
console.log("approve 2 gate:", a2.body.gate);
const a3 = await post("/scaffold/approve");
console.log("approve 3 gate:", a3.body.gate);
const a4 = await post("/scaffold/approve");
console.log("approve 4 (to scene) gate:", a4.body.gate, "last:", JSON.stringify(a4.body.last));
console.log("pendingAsk:", JSON.stringify(a4.body.pendingAsk), "busy:", a4.body.busy);

const said = await post("/scaffold/say", { text: "sharpen the dramatic question" });
console.log("say -> code:", said.code, "handled:", said.handled);
console.log("say -> last:", JSON.stringify(said.body?.last));
console.log("say -> gate:", said.body?.gate, "busy:", said.body?.busy, "active:", said.body?.active);
