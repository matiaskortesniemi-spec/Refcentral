/**
 * refcentral — scoring types
 *
 * Nothing here is computed at read time. The widget reads rows this job
 * produced. A rating submitted now changes nothing visible until the next
 * run, which is also what makes the cooldown real rather than cosmetic.
 */

import { DecisionType, Side, Tier } from "../types";

/** One user's slider position on one decision. */
export interface Rating {
  decisionId: string;
  fixtureId: number;
  userId: string;
  /** 0.0 – 5.0 */
  value: number;
  /** Allegiance the user declared for THIS fixture. */
  allegiance: Side;
  createdAt: string;
}

/** Buckets are scored separately, then combined. See scoreDecision. */
export type Bucket = "NEUTRAL" | "HOME_FAN" | "AWAY_FAN";

export const BUCKET_WEIGHT: Record<Bucket, number> = {
  NEUTRAL: 1.0,
  HOME_FAN: 0.4,
  AWAY_FAN: 0.4,
};

export interface BucketResult {
  bucket: Bucket;
  /** Raw submissions in this bucket, after dedupe, before trimming. */
  n: number;
  /** Submissions actually averaged, after trimming. */
  nTrimmed: number;
  /** Trimmed mean of this bucket, or null when the bucket is empty. */
  mean: number | null;
  /** Share of this bucket sitting on the 0 or 5 rail. */
  railShare: number;
}

export interface ScoredDecision {
  decisionId: string;
  fixtureId: number;
  type: DecisionType;
  tier: Tier;
  /** The published number. Weighted, trimmed, shrunk. */
  score: number;
  /** Before shrinkage — useful for showing how thin a sample is. */
  rawCombined: number | null;
  /** Sum of bucketWeight * n. Drives how hard shrinkage bites. */
  effectiveN: number;
  prior: { value: number; source: "LEAGUE_TYPE" | "GLOBAL_TYPE" | "FALLBACK"; m: number };
  buckets: Record<Bucket, BucketResult>;
  /** Published split shown in the UI. */
  neutralMean: number | null;
  partisanMean: number | null;
  divergence: number | null;
  flags: ScoreFlag[];
  /** True when flags forced us to publish the previous value instead. */
  held: boolean;
}

export type ScoreFlag =
  | "THIN_SAMPLE"
  | "RAIL_HEAVY"
  | "VELOCITY_SPIKE"
  | "LOW_NEUTRAL_SHARE"
  | "NEW_ACCOUNT_SURGE";

export interface MatchScore {
  fixtureId: number;
  refereeId: string;
  competition: string;
  kickoff: string;
  /** Tier-weighted roll-up of the decisions. */
  score: number;
  neutralScore: number | null;
  partisanScore: number | null;
  decisionCount: number;
  effectiveN: number;
  flags: ScoreFlag[];
  held: boolean;
}

/** Category a decision rolls into on a referee's profile. */
export type Category = "PENALTIES" | "DISCIPLINE" | "VAR" | "GAME_MANAGEMENT" | "OTHER";

export interface CategoryAggregate {
  category: Category;
  score: number;
  neutral: number | null;
  partisan: number | null;
  divergence: number | null;
  decisions: number;
}

export interface RefereeAggregate {
  refereeId: string;
  canonicalName: string;
  matches: number;
  /** Shrunk toward the referee population mean of their competitions. */
  career: number;
  /** Raw mean of match scores, unshrunk. */
  careerRaw: number;
  /**
   * Career adjusted so competitions with different rating cultures are
   * comparable. See leagueAdjust in job.ts.
   */
  careerAdjusted: number;
  neutral: number | null;
  partisan: number | null;
  /** Last 10 matches minus career. Positive means improving. */
  form: number;
  categories: CategoryAggregate[];
  perCompetition: { competition: string; matches: number; score: number }[];
}

export interface Priors {
  /**
   * Typical effective-N for a decision, by competition+type. Used to scale
   * how much weight the prior carries — see adaptiveM in job.ts.
   */
  typicalN: Map<string, number>;
  /** Mean rating by competition + decision type. */
  leagueType: Map<string, { mean: number; n: number }>;
  /** Mean rating by decision type across all competitions. */
  globalType: Map<DecisionType, { mean: number; n: number }>;
  /** Mean match score by competition — the referee-population mean. */
  leagueReferee: Map<string, { mean: number; n: number }>;
  globalReferee: { mean: number; n: number };
}
