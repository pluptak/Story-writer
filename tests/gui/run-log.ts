/** A retained run's `writing-log.jsonl`, built from a compact description of what happened in it.
 *
 *  The real file is one `JSON.stringify(publish(e))` per line (`run-and-save.ts`), so every event
 *  carries the `seq` the viewer keys blocks — and therefore timeline markers, `&block=` deep links
 *  and consult toggles — on. A fixture without `seq` renders blocks that cannot be addressed, which
 *  is why this builder assigns them the way `publish()` does rather than leaving them out.
 *
 *  It lives here, next to the specs, rather than as a `.jsonl` under `tests/fixtures/`: the runs a
 *  GUI test wants differ by a field or two each, and three near-identical logs on disk would hide
 *  the one line that matters in each. */

/** One consult block: who was asked, how many times, and whether it hit the chapter-wide ceiling. */
export type ConsultRun = { who: string; attempts: number; capped?: boolean };

export type RunShape = {
  characters: string[];
  /** One prose piece is written before each consult, so the page is taller than the viewport. */
  consults: ConsultRun[];
  chapter?: number;
  target?: number;
};

const PROSE = [
  "The corridor holds its cold the way brick does, giving it back slowly. Riven sets the satchel "
  + "down out of the lamp's reach and listens past the compressor for the thing that is closer than "
  + "the compressor, and finds it: someone breathing, unhurried, who has not moved since they arrived.",
  "The lock is the old mechanical kind, which is the one good thing about tonight. Riven turns it "
  + "over with a thumb the way you test fruit, and the tumblers say what they always say, which is "
  + "that they will take as long as they take and not a minute less.",
  "Somewhere over the flat roof a gull argues with another gull. The sodium lamp buzzes. Between "
  + "them the corridor keeps a silence that is not empty — it is the silence of a room with two "
  + "people in it, both waiting to see which one speaks first, both certain it should not be them.",
  "The crate creaks. It is a small sound and it carries the whole length of the brick, and Riven "
  + "understands, a beat too late, that it was meant to.",
];

/** The lines a run of this shape would have written, newline-terminated. */
export function writingLog(shape: RunShape): string {
  const chapter = shape.chapter ?? 1;
  const target = shape.target ?? 700;
  let seq = 0;
  const lines: string[] = [];
  const put = (e: Record<string, unknown>) => lines.push(JSON.stringify({ seq: ++seq, ...e }));

  put({ t: "scene_start", story: "temporary", characters: shape.characters, target, chapter });

  let step = 0, words = 0;
  for (const [i, c] of shape.consults.entries()) {
    const prose = PROSE[i % PROSE.length];
    words += prose.split(/\s+/).length;
    put({ t: "draft", step: ++step, consulting: "", salvaged: false, chapter, words, prose });

    for (let n = 1; n <= c.attempts; n++) {
      const last = n === c.attempts;
      put({ t: "consult", character: c.who, attempt: n,
            question: `What does ${c.who} do about the door?`,
            wants: "a line, and whether they move",
            situation: "The courier is two steps nearer the service door than when they arrived." });
      put({ t: "answer", character: c.who, thought: "The lock has been sticking for a month.",
            action: last ? "Stays where they are." : "Stands, blocking the line to the door.",
            note: "", speech: `You're standing nearer the door than when you started, ${c.who}.` });
      put({ t: "judge", character: c.who, verdict: last && !c.capped ? "accept" : "reject",
            note: last && !c.capped ? "answers in character" : "walks over the restriction",
            attempt: n, chapter });
    }
    // The ceiling is announced before the answer is taken anyway — an `accept` closes the block,
    // so a `retry_capped` after it would land on nothing.
    if (c.capped) put({ t: "retry_capped", character: c.who, chapter });
    put({ t: "accept", character: c.who, attempt: c.attempts, chapter,
          speech: "You're standing nearer the door than when you started.", action: "Stays where they are." });
  }

  put({ t: "scene_end", steps: step, words, done: true, stopped: false, chapter, retries: {} });
  return lines.join("\n") + "\n";
}
