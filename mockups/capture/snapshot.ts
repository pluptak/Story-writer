/** Freeze the running viewer into one standalone HTML file.
 *
 *  What comes out is the live DOM, not a re-drawing of it: the app's own markup, with viewer.css
 *  inlined and every <script> dropped so the file opens from disk with no server, no modules and
 *  no fetches. Form state that lives only in the DOM property (an input's value, a select's
 *  choice, a checkbox) is written back onto the attributes first — otherwise a captured editor
 *  would show empty fields.
 *
 *  The theme is pinned on <html> because the live page leaves it to prefers-color-scheme, and a
 *  capture that changes colour with the reader's OS is not a reference. */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Page } from "@playwright/test";

const ROOT = fileURLToPath(new URL("../../", import.meta.url));
export const OUT_DIR = join(ROOT, "mockups", "current");

let cssCache: string | null = null;
const viewerCss = async () =>
  (cssCache ??= await readFile(join(ROOT, "server", "gui", "viewer.css"), "utf8"));

export type Shot = {
  /** File stem, also the anchor the index links to. */
  name: string;
  group: string;
  title: string;
  /** What the screen is showing, and what state the app is in to show it. */
  blurb: string;
  /** Also written as `<name>-dark.html` — the same DOM under the dark palette. */
  dark?: boolean;
};

/** Every capture taken this run, in order — the index is built from it. */
export const taken: Shot[] = [];

/** Reflect DOM-property-only state onto attributes, then hand back the whole document. */
const freeze = (theme: string) => {
  document.documentElement.setAttribute("data-theme", theme);
  for (const el of document.querySelectorAll("input")) {
    if (el.type === "checkbox" || el.type === "radio") {
      if (el.checked) el.setAttribute("checked", ""); else el.removeAttribute("checked");
    } else el.setAttribute("value", el.value);
  }
  for (const el of document.querySelectorAll("textarea")) el.textContent = el.value;
  for (const el of document.querySelectorAll("select"))
    for (const opt of el.options) {
      if (opt.selected) opt.setAttribute("selected", ""); else opt.removeAttribute("selected");
    }
  return document.documentElement.outerHTML;
};

const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** Capture the page as it stands. Nothing is clicked or waited for here — the caller has already
 *  driven the app into the state worth looking at. */
export async function snapshot(page: Page, shot: Shot) {
  const css = await viewerCss();
  await mkdir(OUT_DIR, { recursive: true });
  taken.push(shot);

  const write = async (theme: "light" | "dark", file: string) => {
    const dom = await page.evaluate(freeze, theme);
    const html = dom
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, "")
      .replace(/<link\b[^>]*viewer\.css[^>]*>/i, `<style>\n${css}\n</style>`)
      .replace(/<title>[\s\S]*?<\/title>/i, `<title>${esc(shot.title)} · story-writer as it is</title>`);
    await writeFile(join(OUT_DIR, file),
      `<!doctype html>\n<!-- ${shot.group} · ${shot.title}\n     ${shot.blurb}\n`
      + `     Captured from the running viewer by mockups/capture — do not hand-edit. -->\n${html}\n`);
  };

  await write("light", `${shot.name}.html`);
  if (shot.dark) await write("dark", `${shot.name}-dark.html`);
}

/** The gallery. Written by the last capture in the run, from whatever actually got taken. */
export async function writeIndex() {
  const groups = [...new Set(taken.map(s => s.group))];
  const card = (s: Shot) => `
        <a class="shot" href="${s.name}.html">
          <b>${esc(s.title)}</b>
          <p>${esc(s.blurb)}</p>
          <span class="file">${s.name}.html${s.dark ? ` · <em>${s.name}-dark.html</em>` : ""}</span>
        </a>`;
  const section = (g: string) => `
      <section>
        <h2>${esc(g)}</h2>
        <div class="grid">${taken.filter(s => s.group === g).map(card).join("")}
        </div>
      </section>`;

  const html = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>story-writer as it is · captured screens</title>
<style>
  :root { color-scheme: light; --bg:#f3f1ec; --panel:#fffdfa; --ink:#22221f; --muted:#6f6b62;
          --line:#ddd8cf; --accent:#5d5a7d; }
  @media (prefers-color-scheme: dark) {
    :root { color-scheme: dark; --bg:#211e1a; --panel:#2a2723; --ink:#eae6dd; --muted:#a59e92;
            --line:#3d382f; --accent:#a9a3d6; }
  }
  body { margin:0; background:var(--bg); color:var(--ink); font:15px/1.55 ui-sans-serif,system-ui,-apple-system,Segoe UI,sans-serif; }
  .wrap { max-width:1080px; margin:0 auto; padding:48px 24px 96px; }
  h1 { font-size:28px; margin:0 0 6px; letter-spacing:-.01em; }
  .lede { color:var(--muted); max-width:62ch; margin:0 0 8px; }
  h2 { font-size:13px; text-transform:uppercase; letter-spacing:.09em; color:var(--muted);
       border-bottom:1px solid var(--line); padding-bottom:8px; margin:44px 0 18px; font-weight:600; }
  .grid { display:grid; gap:14px; grid-template-columns:repeat(auto-fill,minmax(300px,1fr)); }
  .shot { display:block; padding:16px 18px; background:var(--panel); border:1px solid var(--line);
          border-radius:10px; text-decoration:none; color:inherit; }
  .shot:hover { border-color:var(--accent); }
  .shot b { display:block; font-size:16px; margin-bottom:4px; }
  .shot p { margin:0 0 10px; color:var(--muted); font-size:13.5px; }
  .file { font:12px ui-monospace,SFMono-Regular,Menlo,monospace; color:var(--accent); }
  .file em { font-style:normal; opacity:.75; }
  code { font:12.5px ui-monospace,SFMono-Regular,Menlo,monospace; background:var(--panel);
         border:1px solid var(--line); border-radius:4px; padding:1px 5px; }
</style>
<div class="wrap">
  <h1>story-writer, as it is</h1>
  <p class="lede">Every screen below is the running viewer, frozen: the app's own DOM with
    <code>viewer.css</code> inlined and the scripts dropped. Nothing is redrawn by hand, so what you
    see is what the app renders today — the baseline a redesign argues against. Interactions are
    dead; a few screens ship a <em>-dark.html</em> twin.</p>
  <p class="lede">Retake them all with <code>npm run capture</code>.</p>
${groups.map(section).join("")}
</div>
</html>
`;
  await writeFile(join(OUT_DIR, "index.html"), html);
}
