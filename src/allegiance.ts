/**
 * refcentral — allegiance resolution
 *
 * The one piece of the login that is actually refcentral-specific. Your auth
 * provider hands you a user id; this decides what that user's rating is worth
 * on a given fixture.
 *
 * Three inputs:
 *   1. the per-fixture declaration the user clicked
 *   2. their registered favourite team, if they set one
 *   3. whether those two are consistent
 *
 * The registered favourite is NOT a weight. A Villa fan rating Arsenal v
 * Spurs is genuinely neutral in that match, and treating them otherwise would
 * throw away real neutral signal. It does three other jobs:
 *
 *   PRE-SET    opening a match involving your club pre-selects your club.
 *              This matters more than it looks. Declaring partisan is a pure
 *              cost — your rating counts 0.4x — so there is a standing
 *              incentive to click "Neither". Pre-setting makes honesty the
 *              path of least resistance rather than an act of virtue.
 *
 *   OVERRIDE   declaring neutral on your own club's match doesn't work. The
 *              effective allegiance is your club regardless of what you
 *              clicked, and the override is recorded.
 *
 *   RIVALRY    a Spurs fan rating an Arsenal match is not neutral in any
 *              meaningful sense even though they support neither side.
 *              Optional, off by default — see RIVALRIES.
 */

import { Side } from "./types";

export interface UserProfile {
  userId: number;
  favouriteTeamId: number | null;
  /** How many times they've switched. Frequent switching is gaming. */
  favouriteChanges: number;
  integrityFlags: number;
}

export interface FixtureTeams {
  fixtureId: number;
  homeTeamId: number;
  awayTeamId: number;
}

export type OverrideRule =
  | "DECLARED_NEUTRAL_ON_OWN_CLUB"
  | "DECLARED_OPPOSITE_OF_OWN_CLUB"
  | "RIVALRY"
  | null;

export interface AllegianceResult {
  declared: Side;
  effective: Side;
  overrideRule: OverrideRule;
  /** True when the user tried to claim neutrality they don't have. */
  integrityHit: boolean;
  /** What the UI should pre-select before the user touches anything. */
  suggested: Side;
}

/**
 * Rivalry pairs. A fan of one is not neutral on a match involving the other.
 * Off by default: `resolveAllegiance` only applies it when `useRivalries` is
 * true, because the list is subjective, incomplete, and a wrong entry
 * silently downweights honest neutrals.
 *
 * Keyed by team id — fill these in from your `team` table.
 */
export const RIVALRIES: Map<number, Set<number>> = new Map();

export function addRivalry(a: number, b: number): void {
  if (!RIVALRIES.has(a)) RIVALRIES.set(a, new Set());
  if (!RIVALRIES.has(b)) RIVALRIES.set(b, new Set());
  RIVALRIES.get(a)!.add(b);
  RIVALRIES.get(b)!.add(a);
}

/** What to pre-select in the UI before the user chooses. */
export function suggestAllegiance(profile: UserProfile, fixture: FixtureTeams): Side {
  if (profile.favouriteTeamId === null) return "NEUTRAL";
  if (profile.favouriteTeamId === fixture.homeTeamId) return "HOME";
  if (profile.favouriteTeamId === fixture.awayTeamId) return "AWAY";
  return "NEUTRAL";
}

export function resolveAllegiance(
  profile: UserProfile,
  fixture: FixtureTeams,
  declared: Side,
  opts: { useRivalries?: boolean } = {}
): AllegianceResult {
  const suggested = suggestAllegiance(profile, fixture);
  const fav = profile.favouriteTeamId;

  // No favourite on file: take the declaration at face value. Most users,
  // most of the time.
  if (fav === null) {
    return { declared, effective: declared, overrideRule: null, integrityHit: false, suggested };
  }

  const ownSide: Side | null =
    fav === fixture.homeTeamId ? "HOME" : fav === fixture.awayTeamId ? "AWAY" : null;

  if (ownSide) {
    if (declared === ownSide) {
      return { declared, effective: declared, overrideRule: null, integrityHit: false, suggested };
    }
    // Declared neutral, or declared for the opposition, on their own club's
    // match. Either way the effective allegiance is their club.
    return {
      declared,
      effective: ownSide,
      overrideRule:
        declared === "NEUTRAL" ? "DECLARED_NEUTRAL_ON_OWN_CLUB" : "DECLARED_OPPOSITE_OF_OWN_CLUB",
      integrityHit: true,
      suggested,
    };
  }

  // Their club isn't playing. Optionally check rivalry.
  if (opts.useRivalries) {
    const rivals = RIVALRIES.get(fav);
    if (rivals && declared === "NEUTRAL") {
      if (rivals.has(fixture.homeTeamId)) {
        return { declared, effective: "AWAY", overrideRule: "RIVALRY", integrityHit: false, suggested };
      }
      if (rivals.has(fixture.awayTeamId)) {
        return { declared, effective: "HOME", overrideRule: "RIVALRY", integrityHit: false, suggested };
      }
    }
  }

  return { declared, effective: declared, overrideRule: null, integrityHit: false, suggested };
}

// ---------------------------------------------------------------------------
// Favourite-team changes
// ---------------------------------------------------------------------------

/** Switching more often than this is gaming the 0.4 weight, not fandom. */
export const MAX_FAVOURITE_CHANGES_PER_SEASON = 2;

export interface ChangeVerdict {
  allowed: boolean;
  reason: string;
  /** Fixtures already rated keep their original allegiance either way. */
  retroactive: false;
}

export function canChangeFavourite(profile: UserProfile): ChangeVerdict {
  if (profile.favouriteTeamId === null) {
    return { allowed: true, reason: "first time setting a favourite", retroactive: false };
  }
  if (profile.favouriteChanges >= MAX_FAVOURITE_CHANGES_PER_SEASON) {
    return {
      allowed: false,
      reason: `already changed ${profile.favouriteChanges} times this season`,
      retroactive: false,
    };
  }
  return { allowed: true, reason: "within the seasonal limit", retroactive: false };
}

/**
 * Changing a favourite never rewrites past allegiances. A rating submitted
 * as a declared Villa fan stays weighted as one — otherwise a user could rate
 * a hundred matches as a neutral, then switch, and retroactively shift the
 * weighting of everything they touched.
 */
export const FAVOURITE_CHANGES_ARE_RETROACTIVE = false;

// ---------------------------------------------------------------------------
// Integrity
// ---------------------------------------------------------------------------

/**
 * One override is noise — people set a favourite years ago, or support two
 * clubs, or genuinely don't care about this match. A pattern is different.
 *
 * The response is deliberately mild: their ratings still count, at partisan
 * weight, which is what they'd have counted as if they'd been honest. Nothing
 * is deleted and nobody is banned. The user is told once, plainly, that their
 * declaration was corrected — silently overriding someone is worse than
 * telling them.
 */
export const INTEGRITY_NOTICE_AT = 3;
export const INTEGRITY_REVIEW_AT = 15;

export function integrityAction(flags: number): "NONE" | "NOTIFY" | "REVIEW" {
  if (flags >= INTEGRITY_REVIEW_AT) return "REVIEW";
  if (flags >= INTEGRITY_NOTICE_AT) return "NOTIFY";
  return "NONE";
}
