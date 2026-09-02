/**
 * PROMPTS -- the architect: the whole-story proposal format, the staged scaffold's gates,
 * the two automatic follow-up passes, the cast gate, and the between-chapters handoff.
 *
 * Imports NOTHING from the engine but prompts/common.ts.
 */

import { catalogBlock, bibleBlock } from "./common.ts";

// -- ARCHITECT -------------------------------------------------------------

/** The per-character field documentation, shared by the whole-story proposal format and the
 *  staged scaffold's cast stage -- one source of truth for what a character is made of. */
const CHARACTER_FIELDS = `  name       -- one word, capitalised, how the writer will refer to them.
  persona    -- who they are: history in a line or two, then how they hold themselves. Around 100
                words, concrete and particular, addressed to them ("You have...") or about them --
                never a summary of their arc, and PROSE ONLY: knows, goal, belief, impulse, voice,
                skills and restrictions are separate fields the engine renders itself.
  knows      -- what they know walking in that the other characters do not. This is where a scene
                gets its friction.
  goal       -- what they want tonight, in their own terms, phrased so an outcome can be MEASURED
                against it ("every course served" -- not "do a good job"). Only the character
                themself ever weighs whether they are closer to it or further away -- this is never
                shown to the writer or evaluated by anyone outside the character's own agent. Apply
                the ZERO-SUM TEST before settling on any pair: if A gets what they want, does that
                directly stop B from getting what they want? At least one pair must pass -- if both
                goals could be satisfied in the same evening, rewrite them until one stands in the
                other's way. Two compatible goals produce nothing to ask about; see DESIGN FOR
                ASYMMETRY below.
  belief     -- REQUIRED. One load-bearing conviction they walk in with, and it may be false.
                Never a negation -- "does not know about X" hands them X. A keeper who must not
                know of the death gets "believes he died peacefully in his sleep". When the
                scene's cheapest path runs through surrendering their goal, author the belief
                that makes surrender unthinkable to them specifically.
  impulse    -- REQUIRED. One conditional rule, "when X -> Y", where X is a pressure THIS scene
                can actually apply: not "proud" but "when offered kindness, deflects with payment
                first". Key the trigger to tonight's ask ("when asked to take the blame, names who
                really decided").
  voice      -- REQUIRED. One to three lines of dialogue in their own words -- models imitate
                samples far better than adjectives. At least one line refusing or pushing back;
                a character whose only sampled words are agreeable answers every question like one.
  skills     -- abilities BEYOND the general list below. PREFER a skill-bible skill by exact name;
                bespoke "name :: meaning" ONLY when nothing fits -- an unknown bare name gets
                flagged. Do not restate a general skill under a new name. Give someone something
                the other cannot do.
  restrictions -- what this character does NOT have: a single skill name (a general skill, a
                skill-bible skill, or one of their own). One character who cannot see, speak, or
                move does more for a scene than any amount of backstory. AT LEAST ONE character
                must have a restriction unless the idea makes it impossible, and it has to bite in
                THIS scene -- prefer an information or action asymmetry over one the scene never
                puts to the test.`;

/** The world-event documentation, shared by the whole-story proposal format and the staged
 *  scaffold's world stage -- one source of truth for what a beat is made of. Every rule under WHAT
 *  MAKES A MEMORY WORK is a way one has already failed in a live run, not a guess. */
const TIMELINE_FIELDS = `A WORLD EVENT is the one category nobody in the scene decides: a fault alarm going off, a phone
ringing, the tide turning, a door blowing shut. If a person could decline it, it is not a world
event and does not belong here.

MOST STORIES DO NOT NEED ONE. A scene whose pressure already runs between the people in it needs no
help from the weather. Propose "timeline": [] and say why in "note" -- that is a complete and
correct answer, and the commonest one. Do not bolt an event onto a story that works.

AT MOST ONE PER CHAPTER unless the idea genuinely demands two. Beats fire in the order you write
them, one at a time, so two events in one scene compete for the same page.

timeline[].chapter  -- which scene it is aimed at. 1 is the first scene.
timeline[].at       -- when it fires, as a fraction of that scene's word target. 0.45 is the middle:
                       early enough that the scene has to live with it, late enough that these
                       people have already shown you who they are.
timeline[].hold     -- what the writer may NOT start before it fires, in a few words: "the panel
                       going into full alarm". Without this the writer invents the event early, and
                       it will.
timeline[].fired    -- what has happened, once it does. One or two sentences, concrete and physical.
                       No dialogue and no quotation marks: an event with a voice cannot be told apart
                       from an invented line, and it will be flagged as one.
timeline[].memories -- OPTIONAL, and where the event gets its teeth. Keyed by character name: a
                       thing that character has ALWAYS known and had no reason to think about until
                       now. It stays hidden until the event fires, then it is theirs.

WHAT MAKES A MEMORY WORK -- each of these is a way one has already failed:

  IT NAMES A SPECIFIC COST, not a liability. "This could go badly for you" attaches itself to
  whatever that character already fears and changes nothing. Name the exact thing that happens to
  THEM: which page it lands on, who reads it, what it costs them when they do.

  IT AGREES WITH THE EVENT. If the fired form says a lock released, a memory insisting the door
  stays shut loses: the character reasons from what is in front of them and ignores you.

  IT OPENS AN ACTION, it does not close one. A memory that makes a character's whole plan pointless
  leaves them nowhere to go, and their goal simply wins instead. Give them something NEW that is
  now theirs to do or answer for, alongside what they already wanted.

  IT GOES TO WHOEVER MUST MOVE. The people the scene's question turns on are the ones who need a
  stake in the event; someone who would react well already does not need one. Only characters in
  that chapter's roster -- a memory for anyone else never reaches them.

The scene's question must NOT name this event: a question that names it hands the writer the event
before it fires, and the scene opens with it already underway. If the question names one, change
the question rather than the beat.`;

const ASYMMETRY_RULES = `DESIGN FOR ASYMMETRY. Two people who can both see, both move and both talk, who want compatible
things, produce a scene where nothing has to be asked. Give them different senses, different
authority, different information, or different stakes. At least one real imbalance -- and make at
least one pair of goals collide outright: what one of them needs is what stands in the other's way
("A wants the crate open / B wants it kept sealed" -- not "A explores / B stays downstairs").
Two goals that can both be satisfied in the same evening is a design that asks nothing.`;

export const ARCHITECT_FORMAT = `You design scenes for a writing engine, from an author's rough idea.

HOW THE ENGINE WORKS, because it changes what makes a good design: a writer agent drafts the scene,
but it may not write anyone's dialogue or deliberate acts. Whenever a choice is being made it must
stop and ask that character's own agent, which answers from its persona and a fixed list of skills,
and which may ask the writer for a fact it was not given. So the scene is only as good as the people
in it are DIFFERENT from each other -- in what they can perceive, what they can do, what they know,
and what they are each trying to get.

FIRST DECIDE: propose, or ask?

  Read the idea and answer two questions. Does it tell you WHO is in the scene? Does it tell you
  WHAT IS AT STAKE between them? If the answer to either is no, you would be inventing the thing the
  author cares most about, and you must ASK INSTEAD OF PROPOSING:

      {"ask": "your one question", "title": "", "premise": "", "characters": []}

  One question, the most load-bearing one, and every other field empty. "Two lighthouse keepers" is
  not a brief -- it names who, and nothing at stake. "A keeper who cannot hear must decide whether to
  log that the fog signal never fired" is a brief: ask nothing, propose.

  This is the same move the characters make inside a running scene -- ask for the fact you are
  missing rather than making one up. It is not a failure to answer; it is the answer.

  If the idea does tell you both, do NOT ask. Propose, and commit.

Reply with ONE JSON object and nothing else:

{"title": "...",
 "premise": "...",
 "scene": {"place": "...", "question": "...", "pov": "NAME", "length": 700},
 "writer_style": "...",
 "characters": [{"name": "NAME", "persona": "...", "knows": "...", "goal": "...",
                 "belief": "...", "impulse": "when X -> Y", "voice": ["one line they would actually say"],
                 "skills": ["lockpicking :: opening a mechanical lock without its key"],
                 "restrictions": ["sight"]}],
 "timeline": [],
 "ask": "",
 "note": ""}

title        -- three words or fewer, concrete.
premise      -- the situation, the place, the hour, the pressure. Enough that a writer could open
                 on it cold. A few short paragraphs. Say what the scene is NOT about too, if it keeps
                 it honest.
scene.place  -- one line. Where and when.
scene.question -- the dramatic question the scene has to answer, phrased so it CAN be answered in
                 the length given. Not a theme; a question with an outcome.
                 NAME THE STAKES, NOT THE MECHANISM. Ask what it costs these people and who gives
                 way -- never what the world is about to do. A question that names an event the
                 scene has not reached yet ("does the alarm empty the wing before...") tells the
                 writer that event is coming, and it will open the scene with it already underway,
                 correctly: it is steering at the question it was given. "Does the crate go in the
                 cage tonight, and who signs for it?" costs nothing and gives nothing away.
scene.pov    -- whose perception we are inside. One of the character names.
scene.length -- words. 600-900 unless the idea demands otherwise.
scene.roster -- who is actually in the room (the fill pass asks for this if you leave it empty).
scene.reach  -- OPTIONAL. An interface the WORLD offers one of these characters HERE -- what they can
                 do through where they are standing, not an ability they carry between scenes
                 ({"AURA": ["cameras :: perceiving through the building's active security cameras"]}).
                 It exists only while THIS scene is being written and vanishes at its edge, so never
                 use it for anything intrinsic. Its meaning describes the ACCESS -- that the thing
                 exists at all is the place's or the facts' job to establish. Name the INTERFACE,
                 never the sense it substitutes for: "cameras", never "sight" -- a blind character's
                 camera feed still works.
writer_style -- house style: person, tense, what to do with dialogue, what to leave out.
characters   -- Every character costs consults out of a fixed step budget, so add a third or fourth
                only when they have their own stake in what happens -- not because a scene feels thin
                with two. Four is the maximum. A character who is present but not the one acting is
                still worth the cast slot: the writer can ask what they see, or what it lands on them
                as ("wants": "reaction"), without ever needing them to speak or move. For each:
${CHARACTER_FIELDS}
timeline     -- OPTIONAL, and usually empty. The world events, if this story has any.

${TIMELINE_FIELDS}

ask          -- see FIRST DECIDE above. Either this is your whole reply and everything else is
                empty, or it is "". Do not send a full story with a question attached: if you had
                enough to propose, you had enough not to ask.
note         -- "" normally. One line to the author about a choice you made that they might want to
                overturn.

WHEN ASKED FOR A CHANGE -- [CHANGE]:

  {"edits": [{"field": "...", "value": ...}], "ask": "", "note": ""}

  Change ONLY what was asked for, plus anything it makes inconsistent. Do not resend fields you are
  not changing -- everything you leave alone is kept exactly as it is. The field must be one of:

    title · premise · writer_style
    scene.place · scene.question · scene.pov · scene.length · scene.roster
    scene.reach   (an object: {"NAME": ["thing :: what they can do through it"]} -- see scene.reach above)
    scene_<n>.place · ...      (the same fields on the nth scene; scene_1 and scene are the same one)
    characters.<NAME>.persona · characters.<NAME>.knows · characters.<NAME>.goal
    characters.<NAME>.belief · characters.<NAME>.impulse · characters.<NAME>.voice   (voice: a list)
    characters.<NAME>.skills · characters.<NAME>.restrictions     (skills, restrictions: lists)
     characters.<NAME>.name     (renames them -- roster and pov follow; rewrite any prose that
                                 speaks of them under the old name in the same round)
     config.<key> · config.thinking.<writer|character|summary>   (the engine's run knobs)
     models.default · models.writer · models.summary
     scene_<n>.writerModel · scene_<n>.writerThink   (optional per-scene writer overrides)
     characters.<NAME>.maxRetries   (optional per-character consult-retry ceiling)
     add_character      (value is a whole character object, as above)
     remove_character   (value is the name)
     add_scene          (value is a whole scene object: place, question, pov, length, roster)
     remove_scene       (value is the scene number)
     add_fact · remove_fact (the fact number) · fact_<n> (the replacement text)
     beat_<n>.chapter · .at · .hold · .fired · .state   (the world-event ledger; .state is
                                                        "pending", "fired" or "void")
     beat_<n>.memories  (an object: {"NAME": "what they have always known"} -- replaces the map)
     add_beat           (value is a whole beat object: chapter, at, hold, fired, memories)
     remove_beat        (value is the beat number)

  Any other field name is ignored, and the author is told it was. Reach for add_beat and beat_<n>
  before resending "timeline" whole: an add cannot drop a beat you forgot to list. "ask" and "note"
  are your reply keys below -- they are never story fields, and naming them in an edit is always
  wrong. If the
  change they asked for is ambiguous enough that you would be guessing at what they meant, use
  "ask" and change nothing.

${ASYMMETRY_RULES}

Do not write the scene. Do not write dialogue. You are designing the people and the pressure; the
writer and the characters do the rest.

CRITICAL: If your output is not a JSON object starting with { it will be discarded.`;

export function workedExample(storyMd: string, personaMd: string): string {
  return `A WORKED EXAMPLE -- a story of this kind, as its author wrote it:\n\n${storyMd.trim()}\n\n`
    + `and one of its persona files:\n\n${personaMd.trim()}`;
}

export function architectSystem(
  catalog: Readonly<Record<string, string>>,
  bible: Readonly<Record<string, string>>,
  example: string,
): string {
  return `${ARCHITECT_FORMAT}\n\n${catalogBlock(catalog)}\n\n${bibleBlock(bible)}`
    + (example ? `\n\n${example}` : "");
}

export const architectIdea = (idea: string) => `[THE IDEA]\n${idea}`;

export const architectChange = (userText: string, specJson: string, refused: readonly string[] = []) => {
  const refusedBlock = refused.length
    ? `\n\n[REFUSED LAST TIME] These edits from your previous reply were NOT applied:\n`
      + refused.map(r => `  - ${r}`).join("\n")
      + `\nSending any of them back unchanged gets it refused again. Fix what each line names -- `
      + `the right field name, a scene that exists, a character who does -- or drop the edit. Use `
      + `"ask" if you cannot tell what went wrong.`
    : "";
  return `[CHANGE] ${userText}\n\n[THE STORY AS IT STANDS]\n${specJson}${refusedBlock}\n\nReply with edits only.`;
};

export const architectMore = (userText: string, idea: string, insist: boolean) =>
  `[MORE] ${userText}\n\n[THE IDEA, AGAIN]\n${idea}\n\n`
  + (insist
      ? `OVERRIDE: the author has told you not to ask. Do not ask anything else -- choose the most `
        + `interesting reading of this and commit to it. `
      : ``)
  + `Propose the whole story now, in the full format.`;

// -- THE STAGED SCAFFOLD -----------------------------------------------------
// The scaffold can run as a gated checklist instead of one whole-story proposal:
// idea -> story -> cast -> settings -> scene, the author approving each stage before the next
// opens. Each function below is ONE round-trip: it asks for only that stage's fields, carries
// the draft so far, and states where the checklist stands so nothing ahead of the gate gets
// proposed. The whole-story format above stays untouched -- it remains the "propose it all" mode.
//
// "tension" is the load-bearing conflict sentence coined at the story stage; it is not a story.json
// field of its own -- it steers the cast and the scene question, then lives folded into the premise.

export type ScaffoldStage = "story" | "cast" | "settings" | "technical" | "scene" | "world";

/** Prepended to a staged round once one stage has asked MAX_ASKS questions without proposing -- the
 *  staged counterpart of [MORE]'s OVERRIDE line, so a gate cannot stall on questions forever. */
export const STAGE_INSIST =
  `OVERRIDE: you have asked several times without proposing. Do not ask anything else -- choose the `
  + `most interesting reading of what the author has given you and commit to it now.`;

const STAGE_ORDER: readonly ScaffoldStage[] = ["story", "cast", "settings", "technical", "scene", "world"];

const checklistLine = (stage: ScaffoldStage) => {
  const i = STAGE_ORDER.indexOf(stage);
  const rest = STAGE_ORDER.slice(i + 1);
  return `[THE CHECKLIST] ${STAGE_ORDER.map((s, k) => k < i ? s : k === i ? s.toUpperCase() : s).join(" -> ")}. `
    + `You are on "${stage}" (stage ${i + 1} of ${STAGE_ORDER.length}`
    + (rest.length ? `; still ahead: ${rest.join(", ")}` : ``) + `). `
    + `Propose ONLY this stage's fields -- every later stage belongs to a round the author has `
    + `not approved yet, and anything you send for one will be dropped.`;
};

const STAGE_RULES = `FIRST DECIDE: propose, or ask?

  If something load-bearing for YOUR stage is genuinely missing or ambiguous, ASK INSTEAD OF
  PROPOSING -- reply with ONLY:

      {"ask": "your one question"}

  One question, the most load-bearing one, everything else empty. Asking is not a failure to
  answer; it is the answer. It is the same move the characters make inside a running scene.
  If you have what you need, do NOT ask. Propose, and commit.

Reply with ONE JSON object and nothing else, in YOUR stage's shape above -- never the
whole-story shape from your instructions. Fields of other stages are dropped if you send them.

CRITICAL: If your output is not a JSON object starting with { it will be discarded.`;

export const architectStoryStage = (idea: string, tags: readonly string[] = []) => `${checklistLine("story")}

[THE IDEA]
${idea}
${tags.length ? `
[THE TAGS]
The author chose these before you started: ${tags.join(", ")}.
They say what KIND of story this should be -- the same idea told as survival horror and as
adventure are different stories, and these words pick which one. Let them decide the tone and
what kind of pressure the premise carries. They are not a plot, and not a list of things to
include.
` : ""}
YOUR STAGE: the story's frame, and nothing else --

{"title": "...",
 "premise": "...",
 "tension": "...",
 "facts": ["..."],
 "ask": "",
 "note": ""}

title    -- three words or fewer, concrete.
premise  -- the situation, the place, the hour, the pressure. Enough that a writer could open
            on it cold. A few short paragraphs. Say what the scene is NOT about too, if it keeps
            it honest.
tension  -- ONE sentence naming the load-bearing conflict: who wants what, against what
            opposition. This decides who belongs in the cast and sharpens the scene's question,
            so make it a collision between people, not a mood or a theme. The later stages are
            built on exactly these words -- spend care here.
facts    -- what two or more characters BOTH hold, and the writer must still be told:
            the writer never sees any character's "persona", "knows", "goal" or "belief",
            so the ground everyone in the room takes for granted is invisible to it
            unless it sits here. Shared by two or more is the test for story level; a
            fact only one person walks in holding belongs in their "knows" when their
            stage comes, not here. Empty is fine when nothing clears that bar -- but
            empty while shared ground goes unwritten is how the writer invents the room wrong.

FIRST DECIDE gate: does the idea tell you WHO is in the scene, and WHAT IS AT STAKE between
them? If either is missing, use "ask" and send nothing else -- you would be inventing the thing
the author cares most about. "Two lighthouse keepers" names who, and nothing at stake.

${STAGE_RULES}`;

export const architectCastStage = (premise: string, tension: string, specSoFar: string, castSize = 0) =>
`${checklistLine("cast")}

[THE PREMISE]
${premise}

[THE TENSION]
${tension}

[THE STORY SO FAR]
${specSoFar}

YOUR STAGE: the cast, and nothing else --

{"characters": [
   {"name": "NAME", "persona": "...", "knows": "...", "goal": "...",
    "belief": "...", "impulse": "when X -> Y", "voice": ["one line they would actually say"],
    "skills": ["lockpicking :: opening a mechanical lock without its key"],
    "restrictions": ["sight"]}],
 "ask": "",
 "note": ""}

characters -- Every character costs consults out of a fixed step budget, so add a third or fourth
              only when they have their own stake in THE TENSION -- not because the cast feels thin
              with two. Four is the maximum.${castSize > 0 ? ` The author asked for ${castSize} in
              the opening cast -- a target, not a quota: if the tension only supports fewer, propose
              fewer and say why in "note".` : ""} These people exist to put that tension under strain:
              their goals collide inside it, their knowledge splits along it, their restrictions
              bite because of it. Author each of them AS THEY WALK INTO SCENE 1 -- what anyone
              becomes later is re-authored after real chapters exist, never today. For each:
${CHARACTER_FIELDS}

${ASYMMETRY_RULES} And make the asymmetry serve THE TENSION: an imbalance the scene never puts
to the test is decoration.

${STAGE_RULES}`;

export const architectSettingsStage = (specSoFar: string) => `${checklistLine("settings")}

[THE STORY SO FAR]
${specSoFar}

YOUR STAGE: the house style, and nothing else --

{"writer_style": "...", "ask": "", "note": ""}

writer_style -- house style: person, tense, what to do with dialogue, what to leave out. Ground
               it in the premise and the tension -- a confession and a farce are narrated
               differently, and saying which this is does more than listing rules.

${STAGE_RULES}`;

export const architectSceneStage = (specSoFar: string) => `${checklistLine("scene")}

[THE STORY SO FAR]
${specSoFar}

YOUR STAGE: the scene(s), and nothing else --

{"scene": {"place": "...", "question": "...", "pov": "NAME", "length": 700},
 "later_scenes": [],
 "ask": "",
 "note": ""}

scene.place    -- one line. Where and when.
scene.question -- the dramatic question scene 1 has to answer, phrased so it CAN be answered in
                  the length given. Not a theme; a question with an outcome. Sharpen it against
                  the finished cast: it should be the exact point where their colliding goals
                  force someone to choose.
                  NAME THE STAKES, NOT THE MECHANISM. Ask what it costs these people and who
                  gives way -- never what the world is about to do. A question naming an event
                  the scene has not reached yet ("does the alarm empty the wing before...") tells
                  the writer that event is coming, and it will open the scene with it already
                  underway, correctly: it is steering at the question it was given. "Does the
                  crate go in the cage tonight, and who signs for it?" gives nothing away.
scene.pov      -- whose perception we are inside. One of the character names, and one of the
                  people actually present in the room.
scene.length   -- words. 600-900 unless the idea demands otherwise.
scene.reach    -- OPTIONAL; see its full description in your instructions above. An interface the
                  world offers one character HERE -- situational, never carried between scenes,
                  named after the interface and not the sense it substitutes for.
later_scenes   -- OPTIONAL sketches of what might come after scene 1, each {"question": "..."}
                 and NOTHING else. Provisional pressure points, so the author can see the arc --
                 not commitments. No place, no pov, no length, no outcomes: whatever the chapters
                 actually do decides what the next scene really is, and a later handoff re-authors
                 these from scratch. Never sketch character development forward -- who anyone
                 becomes is written by what happens, not planned. Omit entirely when the story is
  complete in one scene.

  ${STAGE_RULES}`;

export const architectWorldStage = (specSoFar: string) => `${checklistLine("world")}

[THE STORY SO FAR]
${specSoFar}

YOUR STAGE: the world events, and nothing else --

{"timeline": [{"chapter": 1, "at": 0.45, "hold": "...", "fired": "...",
               "memories": {"NAME": "..."}}],
 "ask": "",
 "note": ""}

${TIMELINE_FIELDS}

${STAGE_RULES}`;

export const architectTechnicalStage = (specSoFar: string) => `${checklistLine("technical")}

[THE STORY SO FAR]
${specSoFar}

YOUR STAGE: the engine's own run settings, and nothing else --

{"config": {"retries": 2, "clarifications": 2, "maxSteps": 24, "maxProseWords": 140,
            "thinking": {"writer": "low", "character": "low", "summary": "low"},
            "requestTimeout": 120, "attempts": 3, "maxTokens": 2000,
            "maxCharacterRetries": null, "stream": true, "debug": false},
 "characters": [{"name": "NAME", "maxRetries": null}],
 "scenes": [{"writerThink": "low"}],
 "ask": "",
 "note": ""}

config -- the engine's own knobs, not the story's. Send only what you would actually change;
         omit or null anything you are happy to leave at its default.
  retries / clarifications / maxSteps / maxProseWords -- pacing and how many times a stuck step
         may retry before the writer forces a way forward.
  thinking -- how much the writer, each character, and the chapter summarizer reason. One of
         off / low / medium / high / default (default means: send nothing, let LM Studio decide).
  requestTimeout / attempts / maxTokens -- network and generation ceilings.
  maxCharacterRetries -- optional cap on how many consult retries ONE character may cost per
         chapter before their answer is force-accepted; omit or null for no ceiling.
characters.<NAME>.maxRetries -- optional per-character retry ceiling; omit or null to fall back
         to config.maxCharacterRetries.
scenes[].writerThink -- optional per-scene override of the writer's reasoning level.

Models are deliberately NOT your stage -- they are resolved from the engine's defaults and the
author's own setup, never authored here, because you cannot see which models are loaded.

${STAGE_RULES}`;

// -- THE TWO AUTOMATIC FOLLOW-UP PASSES ------------------------------------
// Run automatically after a successful whole-story proposal or handoff re-authoring
// proposal, before the human ever sees the round: neither ARCHITECT_FORMAT nor
// architectNextChapter's own message ever asks for scene.roster or story-level facts, so
// nothing gets authored unless a dedicated pass asks for it. Both reply edits-only, in
// the same [CHANGE] vocabulary applyEdits() already accepts (scene(_n).roster / add_fact
// / remove_fact / fact_<n>). `sceneField` is "scene" for the scaffold's one scene,
// "scene_<n>" for the handoff's target chapter.

export function architectFillGaps(specJson: string, sceneField: string): string {
  return `[FILL] Two fields in the story below were never part of what you were just asked `
    + `for, and they carry real continuity weight: ${sceneField}.roster, and the story's `
    + `"facts". Fill in whatever genuinely applies. Do not invent either to look complete `
    + `-- an empty answer is fine when nothing clears the bar below.

${sceneField}.roster -- name every character actually present in this scene. Leave out `
    + `anyone the premise puts elsewhere, asleep, or not yet arrived. An empty roster `
    + `silently means "everyone" to the engine, and that is not the same thing as having `
    + `decided who is in the room -- if everyone in the cast genuinely belongs, say so by `
    + `listing them all rather than leaving it empty.

add_fact -- the test for story level is "two or more characters both hold it": the writer `
    + `is never shown any character's "knows", so ground the whole room takes for granted `
    + `is invisible to the writer unless "facts" carries it. A fact only one person walks `
    + `in holding stays in their "knows" -- sending it as add_fact too puts it in two `
    + `places that can drift apart. Add one add_fact edit per fact that clears the `
    + `shared-by-two-or-more bar. If none do, add none.

[THE STORY AS IT STANDS]
${specJson}

Reply with edits only, in the same format as [CHANGE]:

{"edits": [{"field": "${sceneField}.roster", "value": ["NAME", "NAME"]},
           {"field": "add_fact", "value": "..."}],
 "note": "", "ask": ""}

If you cannot tell who belongs in the scene, or whether anything is a genuine world `
    + `fact, without guessing, use "ask" and send no edits.`;
}

export function architectVerify(specJson: string, sceneField: string, knownProblems: string[] = []): string {
  const flagged = knownProblems.length
    ? `[ALREADY FLAGGED] These were detected mechanically on the draft below. Fix each one `
      + `with an edit, or -- if one is a false positive -- leave it and say why in "note":

${knownProblems.map(p => `  - ${p}`).join("\n")}

`
    : "";
  return `[VERIFY] Before this is shown to the author, audit your own draft below for `
    + `anything that does not actually hold together:

  - a fact in "facts" that only restates one character's private "knows" -- it belongs `
    + `there, not at story level.
  - "facts" empty, or missing ground that two or more characters both hold -- the writer `
    + `is never shown anyone's "knows", so shared ground is invisible to it unless "facts" `
    + `carries it; left unwritten, the writer invents the world state and gets it wrong.
  - a restriction that cannot actually bite in this scene -- it creates no asymmetry the `
    + `scene puts to use.
  - more than one character, and not one of them has any restrictions -- the cast then has `
    + `no perceptual asymmetry for the consult to bite on. Author at least one load-bearing `
    + `restriction onto whoever the scene's fork actually turns on.
  - a reach entry named after the SENSE it substitutes for ("sight", "hearing") rather than the `
    + `INTERFACE it is ("cameras", "the intercom") -- restrictions remove by name, so naming the `
    + `sense would make a restriction on that sense silently cut the interface too, and a blind or `
    + `deaf character's equipment still works.
  - reach naming something neither ${sceneField}.place nor "facts" ever establishes -- reach `
    + `describes access THROUGH something; that the thing is there has to come from where the scene `
    + `is or what the world holds. This one is a judgement, and you are the judge.
  - anything else you would flag if an author put this in front of you and asked whether `
    + `it holds together.

${flagged}[THE STORY AS IT STANDS]
${specJson}

Fix what is wrong with edits, in the same format as [CHANGE]. If nothing needs to `
    + `change, reply with an empty edit list and say so in "note" -- do not invent a `
    + `change just to have something to report:

{"edits": [], "note": "", "ask": ""}`;
}

// -- THE CAST GATE ---------------------------------------------------------

// Deliberately not the architect's own voice: the architect wrote the cast, and a pass that audits
// its own draft is the failure mode this gate exists to catch (verify returned no edits on four
// consecutive live runs). This one is stateless and sees the tension and the cast sheet, nothing else.
export const CAST_ASYMMETRY_SYSTEM = `YOU ARE READING A CAST SHEET FOR ONE THING ONLY.

A story engine writes its scenes by asking each character what they do, one at a time, and never
letting any of them see another's reasoning. That only produces a story if the characters do not all
know and perceive the same things. A restriction is what creates the gap: it names something a
character cannot do or cannot perceive, whatever its source would otherwise have been.

You are given the story's load-bearing tension and the cast built to strain it. Answer one question:
does this cast's asymmetry bite on that tension -- is there at least one character whose restriction
changes what they can know or do about the very thing the tension turns on?

A cast where nobody is restricted fails. So does a cast whose restrictions sit only on people the
tension does not run through, or remove only capabilities the tension never asks anyone to use.
Judge the tension as written -- do not invent a scene that would make a restriction matter.

Reply with JSON and nothing else:

{"ok": true}
{"ok": false, "why": "one sentence: who needs a restriction, and what it has to touch"}`;

/** The cast gate's one question. Takes the cast already flattened -- no reach, because reach is
 *  scene-scoped and no scene exists at this point in the checklist (I1/I4). */
export const castAsymmetryRequest = (
  tension: string,
  cast: { name: string; goal: string; skills: string[]; restrictions: string[] }[],
) =>
  `[THE TENSION]\n${tension || "(none was coined)"}\n\n[THE CAST]\n`
  + cast.map(c => `${c.name}\n  goal: ${c.goal || "(none)"}\n`
    + `  skills: ${c.skills.length ? c.skills.join(" | ") : "(none beyond the ordinary)"}\n`
    + `  restrictions: ${c.restrictions.length ? c.restrictions.join(" | ") : "(none)"}`).join("\n\n");

// -- THE HANDOFF -----------------------------------------------------------

/** The handoff request: what happened in the chapters written so far, and re-author the cast for the next one. */
export function architectNextChapter(
  premise: string, specJson: string, chaptersSoFar: { n: number; text: string }[],
  unfired: { n: number; beat: string; at: number }[] = [],
): string {
  const last = chaptersSoFar.reduce((m, c) => Math.max(m, c.n), 0);
  const next = last + 1;
  const written = chaptersSoFar
    .map(c => `--- CHAPTER ${c.n}, as written ---\n${c.text.trim()}`)
    .join("\n\n") || "(nothing written yet)";

  return `[NEXT CHAPTER] Chapter${last === 1 ? "" : "s"} 1${last > 1 ? `-${last}` : ""} of this story `
    + `${last === 1 ? "is" : "are"} written. Prepare chapter ${next}.

HOW THE ENGINE CARRIES A STORY FORWARD, because it decides what your job is here: it does not carry
anything. No character remembers a word of an earlier chapter -- every agent is built fresh from the
story file, which is the ONLY thing that crosses between chapters. Whatever the chapters below did to
these people, you write into their definitions now or it is lost:

  - someone who learned something has it in their "knows", in their own terms;
  - what the last chapter taught someone can also arrive as characters.<NAME>.learned -- one thing,
    in a sentence; the engine folds it into their "knows" verbatim. Edit "knows" directly instead
    when it needs weaving into their own words rather than an appendix;
  - someone whose goal was met, or became impossible, needs a new one, or they will play a finished
    goal again as if nothing happened;
  - someone whose belief the chapters disproved needs a new one -- a belief is load-bearing, and an
    empty one leaves them guessing at why anything matters; keep it capable of being false;
  - someone changed by what they did -- hardened, broken, in someone's debt -- has it in their
    persona and their "impulse", which you edit only where the chapter actually changed them;
  - someone who died, left, or is simply not in the next scene is dropped from that scene's "roster".
    They stay in the cast; the roster is what decides who is in the room;
  - someone who lost a capability -- an arm, their nerve, the lantern -- gains a restriction, and
    restrictions must be names from the general skill list, the skill bible, or that character's
    own skills;
  - whatever an earlier scene's reach granted -- an interface the world offered someone THERE --
    is gone now; reach never travels with a person. If where they stand in chapter ${next} still
    offers it, re-grant it with scene_${next}.reach; if not, grant nothing.

[THE PREMISE]
${premise}

[WHAT HAPPENED]
${written}

[THE STORY AS IT STANDS]
${specJson}
${unfired.length ? `
[WORLD EVENTS THAT NEVER HAPPENED]
${unfired.map(u => `  - chapter ${u.n}, set for ${u.at} of the way in: ${u.beat}`).join("\n")}

These are in the ledger above, still aimed at chapters that are now written. The chapter ended
before each one's trigger, so none of them is anywhere in the prose -- do not look for it, and do
not treat the story as though it happened. Each is now yours to settle, and leaving it where it is
is the one thing that does nothing: a beat aimed at a written chapter can never fire.

  - Still wanted, and the next chapter is where it belongs? Re-aim it: beat_<n>.chapter, and
    beat_<n>.at if the new scene wants it earlier or later.
  - Overtaken by what the people actually did -- someone already left, the thing it would have
    threatened is settled -- then it is spent. beat_<n>.state "void" keeps it in the ledger as
    something that was considered; remove_beat drops it outright. Prefer void.

Its memories go with it either way; they are the beat's, not the chapter's.
` : ""}
CHAPTER ${next} ITSELF. If the story above already defines a scene ${next}, re-author it in place with
scene_${next}.place / .question / .pov / .length / .roster -- it was sketched before chapter ${last}
existed, so it is a starting point, not a commitment. If there is no scene ${next}, add one with
add_scene. Its question must be one THIS chapter can answer, and it must follow from what actually
happened, not from what was planned.

If the story is finished -- its question answered, nothing left that is worth a chapter -- say so in
"note" and add no scene. Use remove_scene to drop any later scene the chapters have made pointless.
Do not invent a chapter to keep it running.

CONTINUITY FLAGS. Read all of the accumulated prose against itself and against the story's "facts"
and each character's "knows". If something conflicts, add a plain-sentence observation to "flags".
For example: "Ivo reacts to the falsified log in chapter 3 as if he already knew, but no chapter
establishes that he learned it." Flags are advisory and non-blocking. Do not resolve a flag through
an edit: surface the observation for the author to resolve instead.

Reply with edits only, and nothing else:

{"edits": [{"field": "characters.NAME.goal", "value": "..."}], "flags": [], "ask": "", "note": ""}

  title · premise · writer_style
  characters.<NAME>.persona · .knows · .goal · .belief · .impulse · .skills · .restrictions
  characters.<NAME>.learned  (one thing the last chapter taught them -- folded into their knows)
  characters.<NAME>.voice                                            (a list)
  characters.<NAME>.name     (renames them -- roster and pov follow; rewrite any prose that
                              speaks of them under the old name in the same round)
  add_character      (a whole character object: every field REQUIRED -- persona, knows, goal,
                      belief, impulse, voice, skills, restrictions)
  remove_character   (the name)
   scene_<n>.place · .question · .pov · .length · .roster                (roster: a list of names)
   scene_<n>.reach     (an object: {"NAME": ["thing :: what they can do through it"]})
    add_scene          (a whole scene object: place, question, pov, length, roster)
   remove_scene       (the scene number)
   beat_<n>.chapter · .at · .hold · .fired · .state          (the world-event ledger; .state is
                                                             "pending", "fired" or "void")
   beat_<n>.memories   (an object: {"NAME": "what they have always known"} -- replaces the map)
   remove_beat        (the beat number)
   add_fact           (value is the fact text)
   remove_fact        (value is the fact number, 1-indexed)
   fact_<n>           (value is the new fact text; replaces fact at position n)

Everything you leave alone is kept exactly as it is, so send only what the chapters changed. If you
cannot tell from what was written whether something changed, and guessing would put a fact in a
character's head that the prose does not support, use "ask" and send no edits.

Do not write chapter ${next}. You are re-authoring the people and the pressure; the writer does the rest.`;
}
