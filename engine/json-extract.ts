/** JSON EXTRACTION — pulling structured replies (or a prose fallback) out of raw model output. */

/**
 * Debug lines from the fallback/failure paths. Null by default so this leaf module keeps no
 * engine dependencies; the composition root wires it to `ENGINE.debug`.
 */
export let debugWrite: ((msg: string) => void) | null = null;
/** The composition root's hook: give extractJson its debug sink. */
export function setDebugWrite(fn: (msg: string) => void) { debugWrite = fn; }

/** Index just past the closing brace of the object that opens at `start`, or -1 if it never closes. */
export function balancedObjectEnd(s: string, start: number): number {
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < s.length; i++) {
    const c = s[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}" && --depth === 0) return i + 1;
  }
  return -1;
}

/** Every complete, parseable top-level object in `s`, in order — nested ones are skipped. */
export function topLevelObjects(s: string): Record<string, any>[] {
  const found: Record<string, any>[] = [];
  for (let i = 0; i < s.length; i++) {
    if (s[i] !== "{") continue;
    const end = balancedObjectEnd(s, i);
    if (end === -1) continue;
    try {
      const o = JSON.parse(s.slice(i, end));
      if (o && typeof o === "object") { found.push(o); i = end - 1; }
    } catch { }
  }
  return found;
}

const PROSE_KEYS = ["prose", "question", "situation", "need", "speech", "action", "thought",
                    "verdict", "note", "answer", "skills_used", "character"] as const;
const PROSE_ALT = PROSE_KEYS.join("|");

/** The structured reply in raw model output: the last top-level JSON object, else a labelled-prose fallback, else {}. */
export function extractJson(raw: string): Record<string, any> {
  const stripped = raw.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  const afterThink = stripped.includes("</think>")
    ? stripped.slice(stripped.lastIndexOf("</think>") + 8).trim()
    : stripped;

  const found = topLevelObjects(afterThink);
  if (found.length) return found[found.length - 1];

  // Prose fallback: model wrote labelled lines instead of JSON.
  const prose: Record<string, string> = {};
  const labelRe = new RegExp(
    `(?:^|\\n)\\s*\\*{0,2}(${PROSE_ALT})\\*{0,2}\\s*[:：]\\s*["“]?(.+?)["”]?\\s*` +
    `(?=\\n\\s*\\*{0,2}(?:${PROSE_ALT})\\*{0,2}\\s*[:：]|$)`, "gis");
  let m: RegExpExecArray | null;
  while ((m = labelRe.exec(afterThink)) !== null) prose[m[1].toLowerCase()] = m[2].trim();
  if (Object.keys(prose).length > 0) {
    debugWrite?.(`[extractJson prose fallback] keys=${Object.keys(prose).join(",")}\n`);
    return prose;
  }

  debugWrite?.(`[extractJson failed] stripped=${JSON.stringify(afterThink.slice(0, 200))}\n`);
  return {};
}

/** Recover a draft that the model cut off mid-JSON: everything up to the last finished sentence in its prose. */
export function salvageProse(raw: string): string {
  const m = raw.match(/"?prose"?\s*:\s*"/);
  if (!m) return "";
  let out = "", esc = false;
  for (let i = m.index! + m[0].length; i < raw.length; i++) {
    const c = raw[i];
    if (esc) { out += c === "n" ? "\n" : c === "t" ? "\t" : c; esc = false; continue; }
    if (c === "\\") { esc = true; continue; }
    if (c === '"') break;
    out += c;
  }
  const end = Math.max(out.lastIndexOf("."), out.lastIndexOf("?"), out.lastIndexOf("!"));
  return end < 0 ? "" : out.slice(0, end + 1).trim();
}
