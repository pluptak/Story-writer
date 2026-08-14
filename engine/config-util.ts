/** CONFIG VALIDATION — parsing helpers for a story.md `kv` map, plus the shared filename slugifier. */
const configLabel = (key: string) => key.replace(/^config\./, "");

export function num(kv: Record<string, string>, key: string, def: number): number {
  const raw = kv[key];
  if (raw == null) return def;
  const n = Number(raw);
  if (!Number.isInteger(n)) { console.warn(`   (config "${configLabel(key)}: ${raw}" is not a whole number — using ${def})`); return def; }
  if (n < 1)                { console.warn(`   (config "${configLabel(key)}: ${raw}" must be at least 1 — using ${def})`); return def; }
  return n;
}

export function bool(kv: Record<string, string>, key: string, def: boolean): boolean {
  const raw = kv[key];
  if (raw == null) return def;
  const v = raw.trim().toLowerCase();
  if (v === "true")  return true;
  if (v === "false") return false;
  console.warn(`   (config "${configLabel(key)}: ${raw}" is not true/false — using ${def})`);
  return def;
}

export function enumOf<T extends string>(kv: Record<string, string>, key: string, allowed: readonly T[], def: T): T {
  const raw = kv[key];
  if (raw == null) return def;
  const v = raw.trim().toLowerCase();
  if ((allowed as readonly string[]).includes(v)) return v as T;
  console.warn(`   (config "${configLabel(key)}: ${raw}" is not one of ${allowed.join("/")} — using ${def})`);
  return def;
}

export function slugify(s: string): string {
  return s.toLowerCase().normalize("NFKD")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}
