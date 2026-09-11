/**
 * refcentral — pile-on detection
 *
 * The scoring maths assumes ratings are roughly independent. A brigade breaks
 * that assumption, and no amount of trimming or shrinkage fixes a sample that
 * is correlated by design.
 *
 * So this runs before the maths, and when it fires the job publishes the
 * PREVIOUS value rather than the new one and raises an alert. Holding a
 * stale number for a day is recoverable. Publishing a manufactured one, and
 * having it propagate into a referee's career average, is not.
 *
 * Four signals. None is conclusive alone; two or more is a hold.
 */

import { Rating, ScoreFlag, Bucket, BUCKET_WEIGHT } from "./types";

export interface UserMeta {
  userId: string;
  /** ISO date the account was created. */
  createdAt: string;
  /** How many decisions this user has rated before today. */
  priorRatings: number;
}

export interface BrigadeInput {
  ratings: Rating[];
  users: Map<string, UserMeta>;
  /** When rating opened for this fixture. */
  windowOpenedAt: string;
}

export interface BrigadeResult {
  flags: ScoreFlag[];
  hold: boolean;
  detail: string[];
}

/** A decision with fewer effective votes than this is simply thin, not rigged. */
const THIN_SAMPLE_N = 60;
/** Above this share on the rails, the distribution is not a judgement. */
const RAIL_THRESHOLD = 0.72;
/** Window used to measure how concentrated arrivals are. */
const BURST_WINDOW_MS = 10 * 60 * 1000;
/**
 * Share of all ratings landing inside one such window. Organic post-match
 * traffic peaks around 0.2–0.35 of the total in any ten minutes; a
 * coordinated push lands far higher. Recalibrate this against your own
 * traffic after a few weeks — it is the one constant here that genuinely
 * depends on your audience.
 */
const BURST_THRESHOLD = 0.55;
/** Below this share of neutrals, one fanbase owns the sample. */
const MIN_NEUTRAL_SHARE = 0.08;
/** Share of raters who registered after the window opened. */
const NEW_ACCOUNT_THRESHOLD = 0.25;

export function detectBrigade(input: BrigadeInput): BrigadeResult {
  const { ratings, users, windowOpenedAt } = input;
  const flags: ScoreFlag[] = [];
  const detail: string[] = [];

  if (ratings.length === 0) {
    return { flags: ["THIN_SAMPLE"], hold: false, detail: ["no ratings"] };
  }

  // --- 1. thin sample -------------------------------------------------------
  const effectiveN = ratings.reduce(
    (acc, r) => acc + BUCKET_WEIGHT[bucketOf(r.allegiance)],
    0
  );
  if (effectiveN < THIN_SAMPLE_N) {
    flags.push("THIN_SAMPLE");
    detail.push(`effective n ${effectiveN.toFixed(1)} below ${THIN_SAMPLE_N}`);
  }

  // --- 2. rail concentration ------------------------------------------------
  const rails = ratings.filter((r) => r.value <= 0.25 || r.value >= 4.75).length;
  const rShare = rails / ratings.length;
  if (rShare >= RAIL_THRESHOLD) {
    flags.push("RAIL_HEAVY");
    detail.push(`${(rShare * 100).toFixed(0)}% of ratings on the rails`);
  }

  // --- 3. burst concentration ----------------------------------------------
  //
  // Absolute arrival rate is the wrong measure. Real post-match traffic is
  // always a burst — everyone rates in the first hour and then it decays. The
  // difference between organic traffic and a brigade is SHAPE, not volume:
  // organic decays smoothly across the window, a brigade lands as a spike
  // because it is coordinated from one place at one time.
  //
  // So: what share of all ratings arrived in the single busiest ten minutes?
  const opened = new Date(windowOpenedAt).getTime();
  const times = ratings.map((r) => new Date(r.createdAt).getTime()).sort((a, b) => a - b);
  const burst = maxWindowShare(times, BURST_WINDOW_MS);
  if (ratings.length >= 50 && burst >= BURST_THRESHOLD) {
    flags.push("VELOCITY_SPIKE");
    detail.push(`${(burst * 100).toFixed(0)}% of ratings landed inside ten minutes`);
  }

  // --- 4. composition -------------------------------------------------------
  const neutrals = ratings.filter((r) => r.allegiance === "NEUTRAL").length;
  const nShare = neutrals / ratings.length;
  if (nShare < MIN_NEUTRAL_SHARE) {
    flags.push("LOW_NEUTRAL_SHARE");
    detail.push(`only ${(nShare * 100).toFixed(1)}% of raters were neutral`);
  }

  const fresh = ratings.filter((r) => {
    const u = users.get(r.userId);
    if (!u) return true;
    return new Date(u.createdAt).getTime() >= opened || u.priorRatings === 0;
  }).length;
  const freshShare = fresh / ratings.length;
  if (freshShare >= NEW_ACCOUNT_THRESHOLD) {
    flags.push("NEW_ACCOUNT_SURGE");
    detail.push(`${(freshShare * 100).toFixed(0)}% of raters are new or first-time`);
  }

  // THIN_SAMPLE on its own is a fact about the data, not a manipulation
  // signal — it is already handled by shrinkage. Only the manipulation flags
  // count toward a hold.
  const manipulation = flags.filter((f) => f !== "THIN_SAMPLE");
  return { flags, hold: manipulation.length >= 2, detail };
}

export function bucketOf(side: Rating["allegiance"]): Bucket {
  return side === "HOME" ? "HOME_FAN" : side === "AWAY" ? "AWAY_FAN" : "NEUTRAL";
}

/**
 * Largest share of timestamps falling inside any window of `windowMs`.
 * Two-pointer sweep over sorted times; O(n).
 */
export function maxWindowShare(sortedTimes: number[], windowMs: number): number {
  if (sortedTimes.length === 0) return 0;
  let best = 0;
  let lo = 0;
  for (let hi = 0; hi < sortedTimes.length; hi++) {
    while (sortedTimes[hi] - sortedTimes[lo] > windowMs) lo++;
    best = Math.max(best, hi - lo + 1);
  }
  return best / sortedTimes.length;
}
