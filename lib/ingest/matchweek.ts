/**
 * refcentral — matchweek windows
 *
 * Rating on a match stays open until the next matchweek kicks off.
 *
 * The alternative was a fixed 72 hours, which is an arbitrary number nobody
 * could defend and which fits the football calendar badly: it closes a Sunday
 * match on Wednesday for no reason, and it treats a congested midweek round
 * the same as a fortnight-long international break.
 *
 * A matchweek boundary is the natural unit. It is how supporters already
 * think — this weekend's games are "current" until next weekend's start — and
 * it self-adjusts: a break gives a long window, a congested schedule a short
 * one, without anyone tuning a constant.
 *
 * It also solves backfill. Seeding the site with the most recent completed
 * matchweek gives a rateable set immediately, and those matches are recent
 * enough that hindsight and self-selection aren't meaningfully in play. Older
 * history can still be ingested for referee context, and simply arrives with
 * a window that has already closed.
 */

/** Parses "Regular Season - 4" and similar into a round number. */
export function roundNumber(round: string | null | undefined): number | null {
  if (!round) return null;
  const m = /(\d+)\s*$/.exec(round.trim());
  return m ? Number(m[1]) : null;
}

export interface RoundBoundary {
  round: number;
  firstKickoff: Date;
  lastKickoff: Date;
}

/**
 * Groups a season's fixtures into rounds and records when each begins.
 * Fixtures whose round can't be parsed are ignored rather than guessed at.
 */
export function roundBoundaries(
  fixtures: { round: string | null; kickoff: string }[]
): Map<number, RoundBoundary> {
  const out = new Map<number, RoundBoundary>();

  for (const f of fixtures) {
    const n = roundNumber(f.round);
    if (n === null) continue;
    const t = new Date(f.kickoff);
    if (Number.isNaN(t.getTime())) continue;

    const existing = out.get(n);
    if (!existing) {
      out.set(n, { round: n, firstKickoff: t, lastKickoff: t });
    } else {
      if (t < existing.firstKickoff) existing.firstKickoff = t;
      if (t > existing.lastKickoff) existing.lastKickoff = t;
    }
  }

  return out;
}

/** Shortest a window may be, however congested the schedule. */
export const MIN_WINDOW_HOURS = 24;
/** Used when there is no next round — end of season, or unknown fixtures. */
export const FALLBACK_WINDOW_DAYS = 7;
/** Full time is in neither feed; approximate from kickoff. */
export const APPROX_MATCH_MINUTES = 105;
/** Everyone rates before anyone sees the totals move. */
export const RATING_DELAY_MIN = 90;

export interface Window {
  opensAt: Date;
  closesAt: Date;
  /** How the closing time was decided, for the job log. */
  basis: "NEXT_ROUND" | "MIN_WINDOW" | "FALLBACK";
  nextRound: number | null;
}

/**
 * Opens 90 minutes after estimated full time; closes when the next round
 * begins.
 */
export function ratingWindow(
  kickoff: Date,
  round: string | null,
  boundaries: Map<number, RoundBoundary>
): Window {
  const fullTime = new Date(kickoff.getTime() + APPROX_MATCH_MINUTES * 60_000);
  const opensAt = new Date(fullTime.getTime() + RATING_DELAY_MIN * 60_000);

  const n = roundNumber(round);
  const next = n === null ? undefined : boundaries.get(n + 1);

  if (!next) {
    return {
      opensAt,
      closesAt: new Date(opensAt.getTime() + FALLBACK_WINDOW_DAYS * 86_400_000),
      basis: "FALLBACK",
      nextRound: n === null ? null : n + 1,
    };
  }

  const minClose = new Date(opensAt.getTime() + MIN_WINDOW_HOURS * 3_600_000);

  // A round that starts before this match's window could reasonably run —
  // a Monday night game followed by a Tuesday cup-congested round — still
  // gets the floor rather than a window of minutes.
  if (next.firstKickoff <= minClose) {
    return { opensAt, closesAt: minClose, basis: "MIN_WINDOW", nextRound: next.round };
  }

  return { opensAt, closesAt: next.firstKickoff, basis: "NEXT_ROUND", nextRound: next.round };
}

/**
 * Whether a fixture should be published as rateable at all.
 *
 * A backfilled match from last season is worth ingesting — it gives the
 * referee a match history — but its window closed long ago and it should
 * arrive CLOSED rather than OPEN.
 */
export function statusFor(window: Window, now = new Date()): "OPEN" | "CLOSED" {
  return now < window.closesAt ? "OPEN" : "CLOSED";
}
