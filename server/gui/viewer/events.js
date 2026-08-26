import { APP } from "./state.js";

// ---- grouping -----------------------------------------------------------
export function build(store) {
  const blocks = []; let cur = null;
  for (const e of store.events) {
    switch (e.t) {
      case "scene_start": if (!store.meta) store.meta = { story:e.story, target:e.target, characters:(e.characters||[]).map(n=>({name:n,skills:[],restrictions:[]})) }; break;
      case "draft":
        if (e.prose) { blocks.push({ kind:"prose", seq:e.seq, text:e.prose, salvaged:!!e.salvaged }); }
        break;
      case "consult": {
        if (!cur || e.attempt === 1) { cur = { kind:"consult", seq:e.seq, who:e.character, attempts:[] }; blocks.push(cur); }
        cur.attempts.push({ n:e.attempt, situation:e.situation, question:e.question, qa:[], flags:[] });
        break;
      }
      case "clarify":   last(cur)?.qa.push({ q:e.question, a:e.answer }); break;
      case "clarify_failed": last(cur)?.flags.push("asked the author for \"" + e.question + "\" and got nothing back — treated as done answering"); break;
      case "prose_reply": {
        // A consult's prose reply flags that block; the writer's draft reply (no consult open) is its own note.
        if (cur && cur.who === e.character) last(cur)?.flags.push("answered in labelled prose, not JSON");
        else blocks.push({ kind:"note", seq:e.seq,
          text:`${e.character} replied in labelled prose rather than JSON — fields were read from it` });
        break;
      }
      case "context_risk": blocks.push({ kind:"note", seq:e.seq,
        text:`${e.model} is loaded with ${e.has} tokens of context and a call needed about ${e.needs} — empty completions or truncation may follow` }); break;
      case "forced":    last(cur)?.flags.push("answered without the detail it asked for"); break;
      case "repair":    last(cur)?.flags.push("re-asked: " + e.why); break;
      case "answer":    if (last(cur)) last(cur).answer = e; break;
      case "judge":     if (last(cur)) last(cur).judge = e; break;
      case "retry_capped": if (cur) cur.capped = true; break;
      case "accept":    cur = null; break;   // the consult is over; nothing renders from the accept event itself
      case "budget":    blocks.push({ kind:"note", seq:e.seq, text:`+${e.added} steps (budget now ${e.budget})` }); break;
      case "reader_ask": blocks.push({ kind:"reader", seq:e.seq, framing:e.framing, options:e.options||[], answer:null }); break;
      case "reader_answer": {
        const rb = [...blocks].reverse().find(b => b.kind === "reader" && b.answer === null);
        if (rb) rb.answer = e.answer;
        break;
      }
      case "reaction_fanout":
        cur = null;  // a group reaction is its own block, never folded into an open consult
        blocks.push({ kind:"reaction", seq:e.seq, situation:e.situation, reactors:e.reactors||[], reacted:[], promoted:null });
        break;
      case "reaction": {
        const rb = lastOf(blocks, "reaction");
        if (rb) rb.reacted.push({ name:e.character, thought:e.thought, speech:e.speech, action:e.action });
        break;
      }
      case "promote": {
        const rb = lastOf(blocks, "reaction");
        if (rb) rb.promoted = { character:e.character, action:e.action };
        break;
      }
      case "exit": blocks.push({ kind:"exit", seq:e.seq, character:e.character, pov:!!e.pov }); break;
      case "exit_refused": blocks.push({ kind:"note", seq:e.seq, text:`${e.character} was declared gone in a reply that wrote nothing — nobody has left, the cast is unchanged` }); break;
      case "bad_consult": blocks.push({ kind:"note", seq:e.seq, text:`consult to ${e.character} not sent — ${e.why}` }); break;
      case "schema_mismatch": blocks.push({ kind:"note", seq:e.seq,
        text: e.call === "lint" ? `the narration lint came back with no verdict in it — asked again`
                                : `the ${e.call} call for ${e.character} came back in the wrong shape — asked again`, }); break;
      case "judge_failed": blocks.push({ kind:"note", seq:e.seq, text:`the judge call for ${e.character} never came back (${e.why}) — accepted with no judgement made` }); break;
      case "lint_failed": blocks.push({ kind:"note", seq:e.seq, text:`the narration lint call never came back (${e.why}) — this piece was accepted unchecked` }); break;
      case "batch_judge_failed": blocks.push({ kind:"note", seq:e.seq, text:`the reaction judge call never came back (${e.why}) — no volunteered deed from this beat was promoted` }); break;
      case "fanout_skip": blocks.push({ kind:"note", seq:e.seq, text:`${e.character} was skipped in the group reaction — ${e.why}` }); break;
      case "model_changed": blocks.push({ kind:"note", seq:e.seq, text:`model switched to ${e.model}` }); break;
      case "forced_end": blocks.push({ kind:"note", seq:e.seq, text:`scene forced to a close — ${e.words} words against a ${e.target}-word target` }); break;
      case "done_deferred": blocks.push({ kind:"note", seq:e.seq, text:`the scene was about to end with an answer still owed the page — held open one more turn to write it in` }); break;
      case "answer_unwritten": blocks.push({ kind:"note", seq:e.seq,
        text:`${(e.characters||[]).join(", ")} answered, and the scene ended before that answer reached the page`
             + (e.stopped ? " — the run was stopped" : ""), }); break;
      case "narration_flag": blocks.push({ kind:"note", seq:e.seq,
        text: e.retried ? `narration flagged again after a redraft — ${e.why} — kept anyway`
                        : `narration flagged — ${e.why} — redrafting`, }); break;
      case "scene_end": blocks.push({ kind:"end", seq:e.seq, ...e }); break;
    }
  }
  return blocks;
}
const last = c => c && c.attempts[c.attempts.length - 1];
const lastOf = (blocks, kind) => { for (let i = blocks.length - 1; i >= 0; i--) if (blocks[i].kind === kind) return blocks[i]; return null; };

/** Turn a saved or dropped `writing-log.jsonl` into a store's `events`, then re-render. */
export function ingest(text, store, repaint = true) {
  store.events = text.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  store.seen = new Set(store.events.map(e => e.seq).filter(s => s !== undefined));
  store.meta = null;   // (store.open is dead: consult open/closed state lives on state.js's `open`)
  if (repaint) APP.render();
}
