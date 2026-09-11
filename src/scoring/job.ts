/**
 * refcentral — the nightly scoring job
 *
 * Reads decisions + ratings, writes scored rows. Idempotent: running it twice
 * on the same inputs produces the same outputs, so a failed run is just
 * re-run rather than repaired.
 *
 * Pipeline:
 *
 *   buildPriors      per-competition, per-type means from everything scored
 *        |             so far. This is the fix for the cross-league problem:
 *        |             Serie A and the Bundesliga do not rate the same way,
 *        |             and a single global prior drags one toward the other.
 *        v
 *   scoreDecision    dedupe -> brigade check -> trim per bucket -> weight
 *        |             -> shrink toward the right prior
 *        v
 *   scoreMatch       tier-weighted roll-up across a fixture's decisions
 *        |
 *        v
 *   aggregateReferee career mean shrunk toward the referee population,
 *                     plus a league-adjusted figure for cross-competition
 *                     comparison, category splits and form
 */

import { Decision, DecisionType, Tier } from "../types";
import {
  Rating, ScoredDecision, MatchScore, RefereeAggregate, Priors,
  Bucket, BUCKET_WEIGHT, BucketResult, Category, CategoryAggregate, ScoreFlag,
} from "./types";
import { trimmedMean, shrink, combineBuckets, dedupeByUser, railShare, mean } from "./stats";
import { detectBrigade, UserMeta, bucketOf } from "./brigade";

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Notional prior observations for a single decision. */
export const DECISION_PRIOR_M = 40;
/** Notional prior matches for a referee's career. */
export const REFEREE_PRIOR_M = 6;
/** Used only when no prior has enough history behind it. */
export const FALLBACK_PRIOR = 3.2;
/** A prior needs this much history before it is trusted over the next level up. */
export const MIN_PRIOR_N = 200;
export const MIN_REFEREE_PRIOR_N = 20;
/** Trim proportion per bucket. */
export const TRIM = 0.08;

const TIER_WEIGHT: Record<Tier, number> = { 5: 5, 3: 3, 2: 2, 1: 1 };

const CATEGORY_OF: Record<DecisionType, Category> = {
  PENALTY_AWARDED: "PENALTIES",
  PENALTY_MISSED: "PENALTIES",
  RED_CARD: "DISCIPLINE",
  SECOND_YELLOW: "DISCIPLINE",
  YELLOW_CARD: "DISCIPLINE",
  VAR_OVERTURN: "VAR",
  VAR_UPHELD: "VAR",
  CROWD_INCIDENT: "OTHER",
  GAME_MANAGEMENT: "GAME_MANAGEMENT",
};

// ---------------------------------------------------------------------------
// Inputs
// ---------------------------------------------------------------------------

export interface FixtureMeta {
  fixtureId: number;
  refereeId: string;
  refereeName: string;
  competition: string;
  kickoff: string;
  ratingOpenedAt: string;
}

export interface JobInput {
  decisions: Decision[];
  ratings: Rating[];
  fixtures: Map<number, FixtureMeta>;
  users: Map<string, UserMeta>;
  /** Previous run's output, used when a decision is held. */
  previous?: Map<string, ScoredDecision>;
}

export interface JobOutput {
  decisions: ScoredDecision[];
  matches: MatchScore[];
  referees: RefereeAggregate[];
  priors: Priors;
  alerts: { decisionId: string; flags: ScoreFlag[]; detail: string[] }[];
}

// ---------------------------------------------------------------------------
// 1. Priors
// ---------------------------------------------------------------------------

/**
 * Two-level priors with a constant fallback.
 *
 *   competition + decision type   preferred, needs MIN_PRIOR_N behind it
 *   decision type across all      fallback for a thin competition
 *   FALLBACK_PRIOR                cold start only
 *
 * These are computed from the raw combined means of decisions that already
 * cleared the brigade check — never from shrunk scores, or the prior would
 * feed on its own output and collapse toward itself over time.
 */
export function buildPriors(
  scored: { competition: string; type: DecisionType; rawCombined: number | null; effectiveN: number }[],
  matchScores: { competition: string; score: number }[]
): Priors {
  const leagueType = new Map<string, { sum: number; n: number }>();
  const globalType = new Map<DecisionType, { sum: number; n: number }>();

  for (const s of scored) {
    if (s.rawCombined === null || s.effectiveN <= 0) continue;
    const lk = `${s.competition}|${s.type}`;
    const l = leagueType.get(lk) ?? { sum: 0, n: 0 };
    l.sum += s.rawCombined * s.effectiveN;
    l.n += s.effectiveN;
    leagueType.set(lk, l);

    const g = globalType.get(s.type) ?? { sum: 0, n: 0 };
    g.sum += s.rawCombined * s.effectiveN;
    g.n += s.effectiveN;
    globalType.set(s.type, g);
  }

  const leagueReferee = new Map<string, { sum: number; n: number }>();
  let gSum = 0;
  let gN = 0;
  for (const m of matchScores) {
    const r = leagueReferee.get(m.competition) ?? { sum: 0, n: 0 };
    r.sum += m.score;
    r.n += 1;
    leagueReferee.set(m.competition, r);
    gSum += m.score;
    gN += 1;
  }

  return {
    leagueType: new Map([...leagueType].map(([k, v]) => [k, { mean: v.sum / v.n, n: v.n }])),
    globalType: new Map([...globalType].map(([k, v]) => [k, { mean: v.sum / v.n, n: v.n }])),
    leagueReferee: new Map([...leagueReferee].map(([k, v]) => [k, { mean: v.sum / v.n, n: v.n }])),
    globalReferee: { mean: gN ? gSum / gN : FALLBACK_PRIOR, n: gN },
  };
}

export function priorFor(
  priors: Priors,
  competition: string,
  type: DecisionType
): { value: number; source: "LEAGUE_TYPE" | "GLOBAL_TYPE" | "FALLBACK"; m: number } {
  const lt = priors.leagueType.get(`${competition}|${type}`);
  if (lt && lt.n >= MIN_PRIOR_N) return { value: lt.mean, source: "LEAGUE_TYPE", m: DECISION_PRIOR_M };

  const gt = priors.globalType.get(type);
  if (gt && gt.n >= MIN_PRIOR_N) return { value: gt.mean, source: "GLOBAL_TYPE", m: DECISION_PRIOR_M };

  return { value: FALLBACK_PRIOR, source: "FALLBACK", m: DECISION_PRIOR_M };
}

// ---------------------------------------------------------------------------
// 2. Decision scoring
// ---------------------------------------------------------------------------

export function scoreDecision(
  decision: Decision,
  ratings: Rating[],
  meta: FixtureMeta,
  priors: Priors,
  users: Map<string, UserMeta>,
  previous?: ScoredDecision
): { scored: ScoredDecision; alert: { decisionId: string; flags: ScoreFlag[]; detail: string[] } | null } {
  const deduped = dedupeByUser(ratings.filter((r) => r.decisionId === decision.id));

  const brigade = detectBrigade({
    ratings: deduped,
    users,
    windowOpenedAt: meta.ratingOpenedAt,
  });

  const byBucket: Record<Bucket, number[]> = { NEUTRAL: [], HOME_FAN: [], AWAY_FAN: [] };
  for (const r of deduped) byBucket[bucketOf(r.allegiance)].push(r.value);

  const buckets = {} as Record<Bucket, BucketResult>;
  for (const b of ["NEUTRAL", "HOME_FAN", "AWAY_FAN"] as Bucket[]) {
    const values = byBucket[b];
    const { mean: m, nTrimmed } = trimmedMean(values, TRIM);
    buckets[b] = { bucket: b, n: values.length, nTrimmed, mean: m, railShare: railShare(values) };
  }

  const { combined, effectiveN } = combineBuckets(
    (["NEUTRAL", "HOME_FAN", "AWAY_FAN"] as Bucket[]).map((b) => ({
      mean: buckets[b].mean,
      n: buckets[b].n,
      weight: BUCKET_WEIGHT[b],
    }))
  );

  const prior = priorFor(priors, meta.competition, decision.type);
  const fresh = shrink(combined, effectiveN, prior.value, prior.m);

  const neutralMean = buckets.NEUTRAL.mean;
  const partisanValues = [...byBucket.HOME_FAN, ...byBucket.AWAY_FAN];
  const partisanMean = trimmedMean(partisanValues, TRIM).mean;

  // A hold must never publish the manufactured number. With a previous value
  // we republish it; without one (a brigade on the first scoring run) we fall
  // back to the prior, which is the honest "we don't know yet" answer.
  const held = brigade.hold;
  const publishedScore = held
    ? (previous?.score ?? prior.value)
    : fresh;

  const scored: ScoredDecision = {
    decisionId: decision.id,
    fixtureId: decision.fixtureId,
    type: decision.type,
    tier: decision.tier,
    score: publishedScore,
    rawCombined: combined,
    effectiveN,
    prior,
    buckets,
    neutralMean,
    partisanMean,
    divergence:
      neutralMean !== null && partisanMean !== null ? neutralMean - partisanMean : null,
    flags: brigade.flags,
    held,
  };

  const alert =
    brigade.hold || brigade.flags.some((f) => f !== "THIN_SAMPLE")
      ? { decisionId: decision.id, flags: brigade.flags, detail: brigade.detail }
      : null;

  return { scored, alert };
}

// ---------------------------------------------------------------------------
// 3. Match roll-up
// ---------------------------------------------------------------------------

export function scoreMatch(meta: FixtureMeta, scored: ScoredDecision[]): MatchScore | null {
  if (scored.length === 0) return null;

  let num = 0;
  let den = 0;
  let nNum = 0;
  let nDen = 0;
  let pNum = 0;
  let pDen = 0;
  const flags = new Set<ScoreFlag>();

  for (const d of scored) {
    const w = TIER_WEIGHT[d.tier];
    num += d.score * w;
    den += w;
    if (d.neutralMean !== null) {
      nNum += d.neutralMean * w;
      nDen += w;
    }
    if (d.partisanMean !== null) {
      pNum += d.partisanMean * w;
      pDen += w;
    }
    d.flags.forEach((f) => flags.add(f));
  }

  return {
    fixtureId: meta.fixtureId,
    refereeId: meta.refereeId,
    competition: meta.competition,
    kickoff: meta.kickoff,
    score: num / den,
    neutralScore: nDen ? nNum / nDen : null,
    partisanScore: pDen ? pNum / pDen : null,
    decisionCount: scored.length,
    effectiveN: scored.reduce((a, d) => a + d.effectiveN, 0),
    flags: [...flags],
    held: scored.some((d) => d.held),
  };
}

// ---------------------------------------------------------------------------
// 4. Referee aggregates
// ---------------------------------------------------------------------------

/**
 * Makes match scores from different competitions comparable.
 *
 * The problem, in the demo data and probably in reality: competitions rate
 * differently. A 3.4 in a harsh competition and a 3.4 in a generous one are
 * not the same performance, and a referee who works both plus the Champions
 * League gets a career average that is partly an artefact of their fixture
 * list.
 *
 * The adjustment re-centres each match on its competition's referee
 * population mean, then adds back the global mean. A referee exactly average
 * in every competition they work scores the global mean, whichever mix of
 * competitions that is.
 *
 * Published alongside the raw career figure, never instead of it — this is a
 * modelling choice and users should be able to see both.
 */
function leagueAdjust(score: number, competition: string, priors: Priors): number {
  const lr = priors.leagueReferee.get(competition);
  if (!lr || lr.n < MIN_REFEREE_PRIOR_N) return score;
  return score - lr.mean + priors.globalReferee.mean;
}

export function aggregateReferee(
  refereeId: string,
  canonicalName: string,
  matches: MatchScore[],
  decisionsByFixture: Map<number, ScoredDecision[]>,
  priors: Priors
): RefereeAggregate {
  const ordered = [...matches].sort((a, b) => a.kickoff.localeCompare(b.kickoff));
  const scores = ordered.map((m) => m.score);
  const careerRaw = mean(scores) ?? FALLBACK_PRIOR;

  // Shrink the career toward the referee population of the competitions they
  // actually work, weighted by how often they work each.
  const byComp = new Map<string, number[]>();
  for (const m of ordered) {
    (byComp.get(m.competition) ?? byComp.set(m.competition, []).get(m.competition)!).push(m.score);
  }
  let popNum = 0;
  let popDen = 0;
  for (const [comp, list] of byComp) {
    const lr = priors.leagueReferee.get(comp);
    const popMean = lr && lr.n >= MIN_REFEREE_PRIOR_N ? lr.mean : priors.globalReferee.mean;
    popNum += popMean * list.length;
    popDen += list.length;
  }
  const population = popDen ? popNum / popDen : priors.globalReferee.mean;

  const career = shrink(careerRaw, ordered.length, population, REFEREE_PRIOR_M);
  const careerAdjusted =
    mean(ordered.map((m) => leagueAdjust(m.score, m.competition, priors))) ?? career;

  const last10 = scores.slice(-10);
  const form = (mean(last10) ?? careerRaw) - careerRaw;

  // --- category splits ------------------------------------------------------
  const catBuckets = new Map<Category, ScoredDecision[]>();
  for (const m of ordered) {
    for (const d of decisionsByFixture.get(m.fixtureId) ?? []) {
      const c = CATEGORY_OF[d.type];
      (catBuckets.get(c) ?? catBuckets.set(c, []).get(c)!).push(d);
    }
  }

  const categories: CategoryAggregate[] = [...catBuckets.entries()].map(([category, ds]) => {
    const n = mean(ds.map((d) => d.neutralMean).filter((x): x is number => x !== null));
    const p = mean(ds.map((d) => d.partisanMean).filter((x): x is number => x !== null));
    return {
      category,
      score: mean(ds.map((d) => d.score)) ?? FALLBACK_PRIOR,
      neutral: n,
      partisan: p,
      divergence: n !== null && p !== null ? n - p : null,
      decisions: ds.length,
    };
  });

  return {
    refereeId,
    canonicalName,
    matches: ordered.length,
    career,
    careerRaw,
    careerAdjusted,
    neutral: mean(ordered.map((m) => m.neutralScore).filter((x): x is number => x !== null)),
    partisan: mean(ordered.map((m) => m.partisanScore).filter((x): x is number => x !== null)),
    form,
    categories: categories.sort((a, b) => b.decisions - a.decisions),
    perCompetition: [...byComp].map(([competition, list]) => ({
      competition,
      matches: list.length,
      score: mean(list) ?? FALLBACK_PRIOR,
    })),
  };
}

// ---------------------------------------------------------------------------
// 5. The job
// ---------------------------------------------------------------------------

export function runScoringJob(input: JobInput, priors: Priors): JobOutput {
  const { decisions, ratings, fixtures, users, previous } = input;

  const ratingsByDecision = new Map<string, Rating[]>();
  for (const r of ratings) {
    (ratingsByDecision.get(r.decisionId) ?? ratingsByDecision.set(r.decisionId, []).get(r.decisionId)!).push(r);
  }

  const scoredDecisions: ScoredDecision[] = [];
  const alerts: JobOutput["alerts"] = [];

  for (const d of decisions) {
    const meta = fixtures.get(d.fixtureId);
    if (!meta) continue;
    const { scored, alert } = scoreDecision(
      d,
      ratingsByDecision.get(d.id) ?? [],
      meta,
      priors,
      users,
      previous?.get(d.id)
    );
    scoredDecisions.push(scored);
    if (alert) alerts.push(alert);
  }

  const byFixture = new Map<number, ScoredDecision[]>();
  for (const s of scoredDecisions) {
    (byFixture.get(s.fixtureId) ?? byFixture.set(s.fixtureId, []).get(s.fixtureId)!).push(s);
  }

  const matches: MatchScore[] = [];
  for (const [fixtureId, ds] of byFixture) {
    const meta = fixtures.get(fixtureId);
    if (!meta) continue;
    const ms = scoreMatch(meta, ds);
    if (ms) matches.push(ms);
  }

  const byReferee = new Map<string, MatchScore[]>();
  for (const m of matches) {
    (byReferee.get(m.refereeId) ?? byReferee.set(m.refereeId, []).get(m.refereeId)!).push(m);
  }

  const referees: RefereeAggregate[] = [];
  for (const [refereeId, ms] of byReferee) {
    const name = fixtures.get(ms[0].fixtureId)?.refereeName ?? refereeId;
    referees.push(aggregateReferee(refereeId, name, ms, byFixture, priors));
  }

  return { decisions: scoredDecisions, matches, referees, priors, alerts };
}
