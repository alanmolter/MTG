/**
 * Card-name resolution for deck ingestion.
 *
 * Target: the Scryfall oracle_id of the card (canonical identity across
 * printings and faces). unaccent and the mojibake repair are matching aids
 * only; the stored name is the catalogue name, never the "fixed" string.
 *
 * Order: exact key → mojibake-repaired key → unaccented key → wildcard
 * (one char per U+FFFD / "´┐¢" / "?") among unaccented keys of the same length.
 */

export interface CatalogCard {
  name: string;
  oracleId?: string | null;
}

export type ResolveMethod = "exact" | "mojibake" | "unaccent" | "wildcard";

export interface ResolvedName {
  input: string;
  name: string;
  oracleId: string | null;
  method: ResolveMethod;
}

/** Re-decode UTF-8 text that was read as Latin-1/cp1252 ("JÃ¶tun" → "Jötun"). */
export function fixMojibake(input: string): string {
  if (!/[ÃÂâ][\u0080-\u00ff\u2018-\u203a\u0152-\u0178]/.test(input)) return input;
  const cp1252: Record<number, number> = {
    0x20ac: 0x80, 0x201a: 0x82, 0x0192: 0x83, 0x201e: 0x84, 0x2026: 0x85, 0x2020: 0x86,
    0x2021: 0x87, 0x02c6: 0x88, 0x2030: 0x89, 0x0160: 0x8a, 0x2039: 0x8b, 0x0152: 0x8c,
    0x017d: 0x8e, 0x2018: 0x91, 0x2019: 0x92, 0x201c: 0x93, 0x201d: 0x94, 0x2022: 0x95,
    0x2013: 0x96, 0x2014: 0x97, 0x02dc: 0x98, 0x2122: 0x99, 0x0161: 0x9a, 0x203a: 0x9b,
    0x0153: 0x9c, 0x017e: 0x9e, 0x0178: 0x9f,
  };
  const bytes: number[] = [];
  for (const ch of input) {
    const code = ch.codePointAt(0)!;
    if (code <= 0xff) bytes.push(code);
    else if (cp1252[code] !== undefined) bytes.push(cp1252[code]);
    else return input; // not a Latin-1 round trip; leave it alone
  }
  try {
    const decoded = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
    return decoded;
  } catch {
    return input;
  }
}

/** Strip diacritics (NFKD + combining marks), like Postgres unaccent for Latin. */
export function unaccent(input: string): string {
  return input
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/æ/g, "ae").replace(/Æ/g, "Ae");
}

export function nameKey(input: string): string {
  return input.trim().replace(/\s+/g, " ").toLowerCase();
}

const REPLACEMENT = /´┐¢|\uFFFD|\?/g;

function catalogKeys(name: string): string[] {
  const full = name.trim();
  const keys = new Set<string>([nameKey(full), nameKey(full.replace(/\s*\/\/\s*/g, "/"))]);
  for (const face of full.split(/\s*\/\/\s*/)) if (face) keys.add(nameKey(face));
  return Array.from(keys);
}

export class CardNameResolver {
  private exact = new Map<string, CatalogCard>();
  private plain = new Map<string, CatalogCard>();
  private byLength = new Map<number, string[]>();

  constructor(catalog: Iterable<CatalogCard>) {
    for (const card of Array.from(catalog)) {
      for (const key of catalogKeys(card.name)) {
        // Several printings share a name and only some carry oracle_id:
        // keep the first one with an oracle_id.
        const prevExact = this.exact.get(key);
        if (!prevExact || (!prevExact.oracleId && card.oracleId)) this.exact.set(key, card);
        const plainKey = unaccent(key);
        const prevPlain = this.plain.get(plainKey);
        if (!prevPlain) {
          this.plain.set(plainKey, card);
          const list = this.byLength.get(plainKey.length) ?? [];
          list.push(plainKey);
          this.byLength.set(plainKey.length, list);
        } else if (!prevPlain.oracleId && card.oracleId) {
          this.plain.set(plainKey, card);
        }
      }
    }
  }

  resolve(input: string): ResolvedName | null {
    const hit = (card: CatalogCard, method: ResolveMethod): ResolvedName => ({
      input, name: card.name, oracleId: card.oracleId ?? null, method,
    });
    const key = nameKey(input);
    const exact = this.exact.get(key);
    if (exact) return hit(exact, "exact");

    const repaired = nameKey(fixMojibake(input));
    if (repaired !== key) {
      const card = this.exact.get(repaired) ?? this.plain.get(unaccent(repaired));
      if (card) return hit(card, "mojibake");
    }

    const plainKey = unaccent(repaired);
    const plain = this.plain.get(plainKey);
    if (plain) return hit(plain, "unaccent");

    if (REPLACEMENT.test(repaired)) {
      REPLACEMENT.lastIndex = 0;
      const pattern = unaccent(repaired.replace(REPLACEMENT, "\u0000"));
      const re = new RegExp(
        "^" + pattern.split("\u0000").map((p) => p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(".") + "$",
      );
      const candidates = (this.byLength.get(pattern.length) ?? []).filter((k) => re.test(k));
      if (candidates.length === 1) return hit(this.plain.get(candidates[0])!, "wildcard");
    }
    REPLACEMENT.lastIndex = 0;
    return null;
  }

  /** Canonical catalogue name, or the trimmed input when nothing matches. */
  canonicalName(input: string): string {
    return this.resolve(input)?.name ?? input.trim();
  }
}
