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
        cur.attempts.push({ n:e.attempt, situation:e.situation, question:e.question, wants:e.wants, qa:[], flags:[] });
        break;
      }
      case "clarify":   last(cur)?.qa.push({ q:e.question, a:e.answer }); break;
      case "forced":    last(cur)?.flags.push("answered without the detail it asked for"); break;
      case "repair":    last(cur)?.flags.push("re-asked: " + e.why); break;
      case "skill_flag":last(cur)?.flags.push("used what it cannot do: " + (e.unknown||[]).join(", ")); break;
      case "answer":    if (last(cur)) last(cur).answer = e; break;
      case "judge":     if (last(cur)) last(cur).judge = e; break;
      case "accept":    if (cur) { cur.accepted = e; cur = null; } break;
      case "budget":    blocks.push({ kind:"note", seq:e.seq, text:`+${e.added} steps (budget now ${e.budget})` }); break;
      case "reader_ask": blocks.push({ kind:"reader", seq:e.seq, framing:e.framing, options:e.options||[], answer:null }); break;
      case "reader_answer": {
        const rb = [...blocks].reverse().find(b => b.kind === "reader" && b.answer === null);
        if (rb) rb.answer = e.answer;
        break;
      }
      case "bad_consult": blocks.push({ kind:"note", seq:e.seq, text:`consult to ${e.character} not sent — ${e.why}` }); break;
      case "model_changed": blocks.push({ kind:"note", seq:e.seq, text:`model switched to ${e.model}` }); break;
      case "scene_end": blocks.push({ kind:"end", seq:e.seq, ...e }); break;
    }
  }
  return blocks;
}
const last = c => c && c.attempts[c.attempts.length - 1];

/** Turn a saved or dropped `writing-log.jsonl` into a store's `events`, then re-render. */
export function ingest(text, store) {
  store.events = text.split("\n").filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  store.seen = new Set(store.events.map(e => e.seq).filter(s => s !== undefined));
  store.meta = null; store.open = new Set();
  APP.render();
}
