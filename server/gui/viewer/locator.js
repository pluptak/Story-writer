import { APP } from "./state.js";

// ---- locator mode ----------------------------------------------------------
// The "point at it" affordance for GUI bug reports (GUI-CHECKLIST "Locators"). Toggled with
// ctrl/⌘+shift+L, or by opening any page with ?locators=1 on its hash. While on: hovering outlines
// the nearest data-tid-bearing ancestor and badges its locator; clicking copies the full locator --
// `#/route?params :: area.component[key=value] > ...` -- to the clipboard and swallows the click,
// so pointing at a button is never pressing it.

let on = false;
let outlined = null;   // the element currently carrying .tid-outline

/** The canonical locator for an element: the chain of data-tid values from the outermost tid-bearing
 *  ancestor down to the element itself, each with its instance key (the first other data-* attribute)
 *  folded in as `[key=value]`. With no tid anywhere, falls back to the nearest id, then the tag. */
export function locatorFor(el) {
  if (!el || !(el instanceof Element)) return "";
  const parts = [];
  let node = el;
  while (node && node !== document.body) {
    if (node.hasAttribute("data-tid")) {
      let part = node.getAttribute("data-tid");
      for (const a of node.attributes) {
        if (a.name !== "data-tid" && a.name.startsWith("data-")) {
          part += `[${a.name.slice(5)}=${a.value}]`;
          break;
        }
      }
      parts.unshift(part);
    }
    node = node.parentElement;
  }
  if (!parts.length) {
    const w = el.closest("[id]");
    return w ? `#${w.id}` : el.tagName.toLowerCase();
  }
  return parts.join(" > ");
}

const badge = () => {
  let b = document.querySelector(".tid-badge");
  if (!b) {
    b = document.createElement("div");
    b.className = "tid-badge";
    document.body.appendChild(b);
  }
  return b;
};

const clearOutline = () => {
  if (outlined) { outlined.classList.remove("tid-outline"); outlined = null; }
};

function paintHover(e) {
  clearOutline();
  const target = e.target instanceof Element ? e.target.closest("[data-tid]") : null;
  const b = badge();
  if (!target) { b.classList.remove("on"); return; }
  outlined = target;
  target.classList.add("tid-outline");
  const loc = locatorFor(target);
  b.textContent = `${location.hash || "#/"} :: ${loc}`;
  b.classList.add("on");
  // Pin the badge near the pointer without ever covering it -- above-right, flipped at the edges.
  const pad = 14;
  const x = Math.min(e.clientX + pad, innerWidth - b.offsetWidth - 8);
  const y = e.clientY - b.offsetHeight - pad < 8
    ? e.clientY + pad
    : e.clientY - b.offsetHeight - pad;
  b.style.left = `${Math.max(8, x)}px`;
  b.style.top = `${y}px`;
}

async function copy(text) {
  try { await navigator.clipboard.writeText(text); return true; }
  catch {
    try {
      const ta = document.createElement("textarea");
      ta.value = text;
      ta.style.position = "fixed"; ta.style.opacity = "0";
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand("copy");
      ta.remove();
      return ok;
    } catch { return false; }
  }
}

async function swallowClick(e) {
  e.preventDefault();
  e.stopPropagation();
  const target = e.target instanceof Element
    ? e.target.closest("[data-tid]") : null;
  if (!target) return;
  const text = `${location.hash || "#/"} :: ${locatorFor(target)}`;
  const ok = await copy(text);
  flash(ok ? `copied — ${text}` : "copy failed — the locator is in the console: APP.locator(el)");
}

/** Click feedback in place of the hover badge, which has usually been torn down by the repaint a
 *  navigation would have caused. Auto-clears. */
function flash(text) {
  const b = badge();
  b.textContent = text;
  b.classList.add("on", "flash");
  clearTimeout(flash.t);
  flash.t = setTimeout(() => b.classList.remove("flash"), 1600);
}

export function setLocators(v) {
  if (on === v) return;
  on = v;
  document.body.classList.toggle("locating", on);
  if (!on) { clearOutline(); badge().classList.remove("on"); }
}

const hashWantsIt = () =>
  new URLSearchParams((location.hash.split("?")[1] || "").split("#")[0]).get("locators") === "1";

export function initLocator() {
  APP.locator = locatorFor;   // console escape hatch, no mode needed: APP.locator($("..."))
  addEventListener("mousemove", e => { if (on) paintHover(e); }, true);
  addEventListener("click", e => { if (on) swallowClick(e); }, true);
  addEventListener("keydown", e => {
    if (e.key === "L" && e.shiftKey && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setLocators(!on);
      if (on) flash("locators ON — click copies a locator");
    }
  }, true);
  // A load or reload with ?locators=1 starts with the mode on. syncHash() drops params it doesn't
  // know on the next navigation, so this is a per-load switch; ctrl/⌘+shift+L owns it after that.
  if (hashWantsIt()) setLocators(true);
}
