/** CONFIG VALIDATION — parsing helpers for a story.md `kv` map, plus the shared filename slugifier. */
import { warn } from "./warnings.ts";

const configLabel = (key: string) => key.replace(/^config\./, "");

/** Read `key` from a kv map as a whole number >= 1, warning and falling back to `def` otherwise. */
export function num(kv: Record<string, string>, key: string, def: number): number {
  const raw = kv[key];
  if (raw == null) return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) { warn(`   (config "${configLabel(key)}: ${raw}" is not a whole number — using ${def})`); return def; }
  if (n < 1)                { warn(`   (config "${configLabel(key)}: ${raw}" must be at least 1 — using ${def})`); return def; }
  return n;
}

/** Read `key` from a kv map as a boolean (only "true"/"false"), warning and falling back to `def` otherwise. */
export function bool(kv: Record<string, string>, key: string, def: boolean): boolean {
  const raw = kv[key];
  if (raw == null) return def;
  const v = raw.trim().toLowerCase();
  if (v === "true")  return true;
  if (v === "false") return false;
  warn(`   (config "${configLabel(key)}: ${raw}" is not true/false — using ${def})`);
  return def;
}

/** Read `key` from a kv map as one of `allowed`, warning and falling back to `def` otherwise. */
export function enumOf<T extends string>(kv: Record<string, string>, key: string, allowed: readonly T[], def: T): T {
  const raw = kv[key];
  if (raw == null) return def;
  const v = raw.trim().toLowerCase();
  if ((allowed as readonly string[]).includes(v)) return v as T;
  warn(`   (config "${configLabel(key)}: ${raw}" is not one of ${allowed.join("/")} — using ${def})`);
  return def;
}

/** A safe folder-name slug from any string, or "" when nothing usable survives. */
export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}
