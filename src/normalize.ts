/**
 * refcentral — name normalization
 *
 * API-Football hands you the referee as free text: "Björn Kuipers, Netherlands".
 * Sometimes "B. Kuipers". Sometimes null. Sometimes a spelling that drifts
 * between seasons. The referee is the primary key of this entire product, so
 * every one of those variants has to land on the same person — or two careers
 * silently merge into one profile and both become worthless.
 *
 * No dependencies. This is small enough to own outright.
 */

/** Splits the ", Country" suffix API-Football appends, when present. */
export function splitCountry(raw: string): { name: string; country: string | null } {
  const parts = raw.split(",").map((s) => s.trim()).filter(Boolean);
  if (parts.length < 2) return { name: raw.trim(), country: null };
  const tail = parts[parts.length - 1];
  // A country has no initials, no digits, and at least three letters.
  if (/^[A-Za-zÀ-ÿ' -]{3,}$/.test(tail) && !tail.includes(".")) {
    return { name: parts.slice(0, -1).join(", ").trim(), country: tail };
  }
  return { name: raw.trim(), country: null };
}

/** Lowercase, strip diacritics and punctuation, collapse whitespace. */
export function normalize(s: string): string {
  return s
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s'-]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Particles that belong to the surname, not the given names. */
const PARTICLES = new Set([
  "van", "von", "de", "del", "della", "di", "da", "dos", "das", "du",
  "la", "le", "el", "al", "den", "der", "ter", "op", "bin", "ibn", "mac", "mc",
]);

export interface ParsedName {
  raw: string;
  normalized: string;
  given: string[];
  /** Surname including any particles. */
  surname: string;
  /** First letters of the given names, e.g. ["b"] for "B. Kuipers". */
  initials: string[];
  /** True when the given names were supplied only as initials. */
  initialsOnly: boolean;
}

export function parseName(raw: string): ParsedName {
  const normalized = normalize(raw);
  const tokens = normalized.split(" ").filter(Boolean);

  if (tokens.length === 0) {
    return { raw, normalized, given: [], surname: "", initials: [], initialsOnly: false };
  }
  if (tokens.length === 1) {
    return { raw, normalized, given: [], surname: tokens[0], initials: [], initialsOnly: false };
  }

  // Walk backwards collecting particles into the surname.
  let i = tokens.length - 1;
  const surnameParts = [tokens[i]];
  i--;
  while (i >= 1 && PARTICLES.has(tokens[i])) {
    surnameParts.unshift(tokens[i]);
    i--;
  }

  const given = tokens.slice(0, i + 1);
  const initials = given.map((g) => g[0]);
  const initialsOnly = given.length > 0 && given.every((g) => g.length === 1);

  return { raw, normalized, given, surname: surnameParts.join(" "), initials, initialsOnly };
}

// ---------------------------------------------------------------------------
// Similarity
// ---------------------------------------------------------------------------

export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array(a.length).fill(false);
  const bMatched = new Array(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const lo = Math.max(0, i - matchWindow);
    const hi = Math.min(i + matchWindow + 1, b.length);
    for (let j = lo; j < hi; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;

  let prefix = 0;
  for (let i = 0; i < Math.min(4, a.length, b.length); i++) {
    if (a[i] === b[i]) prefix++;
    else break;
  }
  return jaro + prefix * 0.1 * (1 - jaro);
}

export interface NameComparison {
  score: number;
  surnameScore: number;
  givenAgreement: "FULL" | "INITIAL" | "CONFLICT" | "UNKNOWN";
  notes: string[];
}

/**
 * Surname-weighted comparison.
 *
 * The surname carries almost all the signal — "M. Oliver" and "Michael Oliver"
 * are the same person, while "Michael Oliver" and "Michael Salisbury" are not,
 * despite sharing a given name. So surname similarity dominates and given
 * names act as a confirmation or a veto.
 *
 * The veto is the important half: when both sides have full given names and
 * those names disagree, the score is pushed hard down even on an identical
 * surname. That's the "two brothers who both referee" case, and it should
 * land in quarantine rather than auto-merge.
 */
export function compareNames(a: ParsedName, b: ParsedName): NameComparison {
  const notes: string[] = [];
  const surnameScore = jaroWinkler(a.surname, b.surname);

  let givenAgreement: NameComparison["givenAgreement"] = "UNKNOWN";
  let givenFactor = 1.0;

  const aHasGiven = a.given.length > 0;
  const bHasGiven = b.given.length > 0;

  if (!aHasGiven || !bHasGiven) {
    givenAgreement = "UNKNOWN";
    givenFactor = 0.97; // mild penalty: we simply can't confirm
    notes.push("one side has no given name");
  } else if (a.initialsOnly || b.initialsOnly) {
    const ai = a.initials.join("");
    const bi = b.initials.join("");
    const shared = Math.min(ai.length, bi.length);
    if (shared > 0 && ai.slice(0, shared) === bi.slice(0, shared)) {
      givenAgreement = "INITIAL";
      givenFactor = 0.99;
      notes.push("initials agree");
    } else {
      givenAgreement = "CONFLICT";
      givenFactor = 0.55;
      notes.push(`initials disagree (${ai} vs ${bi})`);
    }
  } else {
    const gs = jaroWinkler(a.given.join(" "), b.given.join(" "));
    if (gs >= 0.9) {
      givenAgreement = "FULL";
      givenFactor = 1.0;
      notes.push("given names agree");
    } else if (gs >= 0.7) {
      givenAgreement = "INITIAL";
      givenFactor = 0.93;
      notes.push("given names similar but not identical");
    } else {
      givenAgreement = "CONFLICT";
      givenFactor = 0.5;
      notes.push(`given names conflict (${a.given.join(" ")} vs ${b.given.join(" ")})`);
    }
  }

  // Surname is 85% of the signal; the rest is the whole-string comparison,
  // which catches reordered or partially-parsed names.
  const whole = jaroWinkler(a.normalized, b.normalized);
  const base = surnameScore * 0.85 + whole * 0.15;

  return { score: base * givenFactor, surnameScore, givenAgreement, notes };
}
