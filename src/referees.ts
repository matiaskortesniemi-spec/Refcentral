/**
 * refcentral — referee identity
 *
 * Resolution order, most trustworthy first:
 *
 *   1. football-data.org referee id     stable integer, free tier, definitive
 *   2. known alias string               we have resolved this exact text before
 *   3. fuzzy match above AUTO_ACCEPT    accept and learn the alias
 *   4. fuzzy match in the grey band     QUARANTINE — block, do not merge
 *   5. nothing close                    create a new referee
 *
 * Step 4 is the one that earns its keep. Merging two officials who share a
 * surname is silent, permanent, and destroys the credibility of both
 * profiles. A quarantined name blocks one match from publishing until it is
 * resolved. That is a worse outcome for that match and a much better one for
 * the product.
 */

import { RefereeRecord, ResolveResult, Official, Confidence } from "./types";
import { compareNames, parseName, splitCountry, ParsedName } from "./normalize";

/** At or above this, accept automatically and learn the alias. */
export const AUTO_ACCEPT = 0.93;
/** Between this and AUTO_ACCEPT, quarantine rather than guess. */
export const QUARANTINE_FLOOR = 0.78;
/** A rival this close to the winner means we cannot safely pick either. */
export const AMBIGUITY_MARGIN = 0.04;

export interface RefereeStore {
  all(): RefereeRecord[];
  byFdId(fdId: number): RefereeRecord | undefined;
  byAlias(raw: string): RefereeRecord | undefined;
  save(r: RefereeRecord): void;
}

export class InMemoryRefereeStore implements RefereeStore {
  private records = new Map<string, RefereeRecord>();
  private aliasIndex = new Map<string, string>();
  private fdIndex = new Map<number, string>();

  all(): RefereeRecord[] {
    return [...this.records.values()];
  }
  byFdId(fdId: number): RefereeRecord | undefined {
    const id = this.fdIndex.get(fdId);
    return id ? this.records.get(id) : undefined;
  }
  byAlias(raw: string): RefereeRecord | undefined {
    const id = this.aliasIndex.get(raw.trim().toLowerCase());
    return id ? this.records.get(id) : undefined;
  }
  save(r: RefereeRecord): void {
    this.records.set(r.id, r);
    if (r.fdPersonId != null) this.fdIndex.set(r.fdPersonId, r.id);
    for (const a of r.aliases) this.aliasIndex.set(a.trim().toLowerCase(), r.id);
  }
}

let seq = 0;
function newId(): string {
  seq += 1;
  return `ref_${String(seq).padStart(5, "0")}`;
}

export class RefereeResolver {
  constructor(private store: RefereeStore) {}

  /**
   * Preferred path. When football-data.org has covered this fixture we get a
   * stable integer id, and any API-Football string seen alongside it is
   * learned as an alias — so the fuzzy path degrades into a fallback that
   * only runs on fixtures the free provider didn't cover.
   */
  resolveByOfficial(official: Official, alsoKnownAs?: string | null): ResolveResult {
    if (official.providerId == null) {
      return this.resolveByName(official.name, official.nationality);
    }

    let rec = this.store.byFdId(official.providerId);
    if (!rec) {
      rec = {
        id: newId(),
        fdPersonId: official.providerId,
        canonicalName: official.name,
        country: official.nationality,
        aliases: [official.name],
        matchesSeen: 0,
      };
    }

    // Learn the API-Football spelling against the definitive id.
    let learned = false;
    for (const alias of [official.name, alsoKnownAs].filter(Boolean) as string[]) {
      const { name } = splitCountry(alias);
      if (!rec.aliases.some((a) => a.toLowerCase() === name.toLowerCase())) {
        rec.aliases.push(name);
        learned = true;
      }
    }

    rec.matchesSeen += 1;
    this.store.save(rec);

    return {
      referee: rec,
      confidence: "EXACT_ID",
      score: 1,
      rivals: [],
      reason: learned
        ? `football-data id ${official.providerId}; learned alias`
        : `football-data id ${official.providerId}`,
      blocked: false,
    };
  }

  /** Fallback path when all we have is API-Football's free-text string. */
  resolveByName(raw: string | null, countryHint: string | null = null): ResolveResult {
    if (!raw || !raw.trim()) {
      return {
        referee: null,
        confidence: "QUARANTINE",
        score: 0,
        rivals: [],
        reason: "no referee supplied by the provider",
        blocked: true,
      };
    }

    const { name, country } = splitCountry(raw);
    const effectiveCountry = country ?? countryHint;

    const alias = this.store.byAlias(name);
    if (alias) {
      alias.matchesSeen += 1;
      this.store.save(alias);
      return {
        referee: alias,
        confidence: "KNOWN_ALIAS",
        score: 1,
        rivals: [],
        reason: "exact alias already learned",
        blocked: false,
      };
    }

    const parsed = parseName(name);
    const scored = this.store
      .all()
      .map((r) => ({ record: r, cmp: this.best(parsed, r, effectiveCountry) }))
      .filter((s) => s.cmp.score > 0)
      .sort((a, b) => b.cmp.score - a.cmp.score);

    const top = scored[0];
    const runnerUp = scored[1];

    if (!top || top.cmp.score < QUARANTINE_FLOOR) {
      const rec: RefereeRecord = {
        id: newId(),
        fdPersonId: null,
        canonicalName: name,
        country: effectiveCountry,
        aliases: [name],
        matchesSeen: 1,
      };
      this.store.save(rec);
      return {
        referee: rec,
        confidence: "NEW",
        score: top?.cmp.score ?? 0,
        rivals: [],
        reason: top
          ? `nearest existing referee scored ${top.cmp.score.toFixed(3)}, below floor`
          : "no existing referees",
        blocked: false,
      };
    }

    // Two candidates too close to separate — never guess between them.
    if (runnerUp && top.cmp.score - runnerUp.cmp.score < AMBIGUITY_MARGIN) {
      return {
        referee: null,
        confidence: "QUARANTINE",
        score: top.cmp.score,
        rivals: scored.slice(0, 3).map((s) => ({
          id: s.record.id,
          name: s.record.canonicalName,
          score: s.cmp.score,
        })),
        reason: `two candidates within ${AMBIGUITY_MARGIN} of each other`,
        blocked: true,
      };
    }

    if (top.cmp.score >= AUTO_ACCEPT) {
      const rec = top.record;
      rec.aliases.push(name);
      rec.matchesSeen += 1;
      if (!rec.country && effectiveCountry) rec.country = effectiveCountry;
      this.store.save(rec);
      return {
        referee: rec,
        confidence: "FUZZY_ACCEPT",
        score: top.cmp.score,
        rivals: [],
        reason: `matched "${rec.canonicalName}" (${top.cmp.notes.join("; ")})`,
        blocked: false,
      };
    }

    return {
      referee: null,
      confidence: "QUARANTINE",
      score: top.cmp.score,
      rivals: scored.slice(0, 3).map((s) => ({
        id: s.record.id,
        name: s.record.canonicalName,
        score: s.cmp.score,
      })),
      reason: `best match "${top.record.canonicalName}" scored ${top.cmp.score.toFixed(3)}, in the grey band (${top.cmp.notes.join("; ")})`,
      blocked: true,
    };
  }

  /** Best score across all known spellings of a referee. */
  private best(parsed: ParsedName, rec: RefereeRecord, country: string | null) {
    let best = { score: 0, notes: [] as string[] };
    for (const alias of rec.aliases) {
      const cmp = compareNames(parsed, parseName(alias));
      if (cmp.score > best.score) best = { score: cmp.score, notes: cmp.notes };
    }
    // A country mismatch is evidence against, not proof — providers disagree
    // on nationality strings and some officials hold two.
    if (country && rec.country && country.toLowerCase() !== rec.country.toLowerCase()) {
      best = {
        score: best.score * 0.88,
        notes: [...best.notes, `country differs (${country} vs ${rec.country})`],
      };
    }
    return best;
  }
}
