/**
 * STATIC FILES — the viewer's HTML/CSS/JS plus the studio mockup. Contract: docs/GUI-SPEC.md.
 */

import type { IncomingMessage, ServerResponse } from "node:http";
import { readFile } from "node:fs/promises";

import { requireMethod } from "./http-util.ts";

const viewerPath = new URL("../gui/viewer.html", import.meta.url);
const viewerCssPath = new URL("../gui/viewer.css", import.meta.url);
const viewerJsPath = new URL("../gui/viewer.js", import.meta.url);
const viewerModule = /^\/viewer\/([a-z0-9_-]+\.js)$/i;

async function serveFile(res: ServerResponse, url: URL, contentType: string) {
  try {
    res.writeHead(200, { "Content-Type": contentType, "Cache-Control": "no-cache" });
    res.end(await readFile(url, "utf8"));
  } catch {
    res.writeHead(404);
    res.end("not found");
  }
}

/** Serve a static file for `path`, or return false if `path` is not a static route. */
export async function serveStatic(
  req: IncomingMessage, res: ServerResponse, path: string,
): Promise<boolean> {
  const file =
    path === "/" || path === "/index.html" ? { url: viewerPath, type: "text/html; charset=utf-8" }
    : path === "/viewer.css" ? { url: viewerCssPath, type: "text/css; charset=utf-8" }
    : path === "/viewer.js" ? { url: viewerJsPath, type: "application/javascript; charset=utf-8" }
    : path === "/studio" || path === "/studio/" ? { url: new URL("../../mockups/studio/index.html", import.meta.url), type: "text/html; charset=utf-8" }
    : viewerModule.test(path)
      // viewer.js's own submodules — an allowlist regex (flat filenames only, no subfolders)
      // rather than a `..`-blacklist check, since that's the shape the folder actually has.
      ? { url: new URL(`../gui/viewer/${path.match(viewerModule)![1]}`, import.meta.url), type: "application/javascript; charset=utf-8" }
      : null;
  if (!file) return false;
  if (requireMethod(res, req, "GET")) return true;
  await serveFile(res, file.url, file.type);
  return true;
}
