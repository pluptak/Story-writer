import { READV } from "./state.js";
import { ingest } from "./events.js";
import { setSrc } from "./hud.js";
import { go } from "./nav.js";
import { tryHttp, loadDeepLinkedRun } from "./sse.js";

// ---- boot ---------------------------------------------------------------
export async function boot() {
  const src = new URLSearchParams(location.search).get("src");
  if (src) {
    try {
      const r = await fetch(src);
      setSrc(READV, src, false);
      ingest(await r.text(), READV);
      go("read");
      return;
    } catch {}
  }
  if (location.protocol.startsWith("http")) {
    if (await tryHttp()) return;
    try {
      const r = await fetch("/log.jsonl");
      if (r.ok) {
        setSrc(READV, "/log.jsonl", false);
        ingest(await r.text(), READV);
        go("read");
        return;
      }
    } catch {}
  }
  // No engine, nothing at ?src=, no /log.jsonl -- a static or file:// load. Only the read page
  // means anything without a server behind it; honour a #/read?dir=&id= deep link if there is one,
  // read BEFORE go("read") can touch the hash.
  await loadDeepLinkedRun();
  go("read");
}
