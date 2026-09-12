/**
 * refcentral — read queries
 *
 * Everything here runs through the anon key and therefore through RLS. A
 * fixture that is BLOCKED (quarantined referee) is invisible to these queries
 * by policy, not by a filter written here — which is the right place for that
 * rule to live.
 *
 * Scores come from `scored_decision`, written by the nightly job. Raw ratings
 * are never readable, so a page can show what the crowd concluded but never
 * watch it being concluded.
 */

import { anonClient } from "../supabase/client";

export interface FixtureSummary {
  id: number;
  round: number | null;
  kickoff: string;
  competition: string;
  home: string;
  away: string;
  ftHome: number | null;
  ftAway: number | null;
  refereeId: string | null;
  refereeName: string | null;
  status: string;
  ratingOpensAt: string | null;
  ratingClosesAt: string | null;
  decisionCount: number;
  matchScore: number | null;
}

export interface DecisionRow {
  id: string;
  type: string;
  tier: number;
  minute: number;
  extraTime: number | null;
  favours: string;
  against: string;
  label: string;
  tierReasons: string[];
  varNote: string | null;
  source: string;
  /** Null until the scoring job has run over it. */
  score: number | null;
  neutralMean: number | null;
  partisanMean: number | null;
  divergence: number | null;
  effectiveN: number;
  held: boolean;
  /** Null means rateable now. Used to hold game management until full time. */
  rateableFrom: string | null;
}

/** Most recent fixtures, newest first. */
export async function recentFixtures(limit = 20): Promise<FixtureSummary[]> {
  const db = anonClient();

  const { data, error } = await db
    .from("fixture")
    .select(`
      id, kickoff, competition_code, ft_home, ft_away, status, round,
      rating_opens_at, rating_closes_at, referee_id,
      home:home_team_id ( name ),
      away:away_team_id ( name ),
      referee:referee_id ( canonical_name ),
      decision ( id ),
      match_score ( score )
    `)
    .order("kickoff", { ascending: false })
    .limit(limit);

  if (error) throw new Error(`recentFixtures: ${error.message}`);

  return (data ?? []).map((f: any) => ({
    id: f.id,
    round: f.round ?? null,
    kickoff: f.kickoff,
    competition: f.competition_code,
    home: f.home?.name ?? "Unknown",
    away: f.away?.name ?? "Unknown",
    ftHome: f.ft_home,
    ftAway: f.ft_away,
    refereeId: f.referee_id,
    refereeName: f.referee?.canonical_name ?? null,
    status: f.status,
    ratingOpensAt: f.rating_opens_at,
    ratingClosesAt: f.rating_closes_at,
    decisionCount: Array.isArray(f.decision) ? f.decision.length : 0,
    matchScore: f.match_score?.[0]?.score ?? f.match_score?.score ?? null,
  }));
}

/** Decisions for one fixture, with scores where the job has produced them. */
export async function decisionsForFixture(fixtureId: number): Promise<DecisionRow[]> {
  const db = anonClient();

  const { data, error } = await db
    .from("decision")
    .select(`
      id, type, tier, minute, extra_time, favours, against,
      label, tier_reasons, var_note, source, rateable_from,
      scored_decision ( score, neutral_mean, partisan_mean, divergence, effective_n, held )
    `)
    .eq("fixture_id", fixtureId)
    .order("minute", { ascending: true });

  if (error) throw new Error(`decisionsForFixture: ${error.message}`);

  return (data ?? []).map((d: any) => {
    const s = Array.isArray(d.scored_decision) ? d.scored_decision[0] : d.scored_decision;
    return {
      id: d.id,
      type: d.type,
      tier: d.tier,
      minute: d.minute,
      extraTime: d.extra_time,
      favours: d.favours,
      against: d.against,
      label: d.label,
      tierReasons: d.tier_reasons ?? [],
      varNote: d.var_note,
      source: d.source,
      score: s?.score ?? null,
      neutralMean: s?.neutral_mean ?? null,
      partisanMean: s?.partisan_mean ?? null,
      divergence: s?.divergence ?? null,
      effectiveN: s?.effective_n ?? 0,
      held: s?.held ?? false,
      rateableFrom: d.rateable_from ?? null,
    };
  });
}

export interface RefereeProfile {
  id: string;
  name: string;
  country: string | null;
  matches: number;
  career: number | null;
  careerRaw: number | null;
  neutral: number | null;
  partisan: number | null;
  form: number | null;
  categories: { category: string; score: number; neutral: number | null; partisan: number | null; divergence: number | null; decisions: number }[];
}

export async function refereeProfile(refereeId: string): Promise<RefereeProfile | null> {
  const db = anonClient();

  const { data, error } = await db
    .from("referee")
    .select(`
      id, canonical_name, country,
      referee_aggregate ( matches, career, career_raw, neutral, partisan, form, categories )
    `)
    .eq("id", refereeId)
    .maybeSingle();

  if (error) throw new Error(`refereeProfile: ${error.message}`);
  if (!data) return null;

  const agg: any = Array.isArray((data as any).referee_aggregate)
    ? (data as any).referee_aggregate[0]
    : (data as any).referee_aggregate;

  return {
    id: (data as any).id,
    name: (data as any).canonical_name,
    country: (data as any).country,
    matches: agg?.matches ?? 0,
    career: agg?.career ?? null,
    careerRaw: agg?.career_raw ?? null,
    neutral: agg?.neutral ?? null,
    partisan: agg?.partisan ?? null,
    form: agg?.form ?? null,
    categories: agg?.categories ?? [],
  };
}

// ---------------------------------------------------------------------------
// Referee pages
// ---------------------------------------------------------------------------

export interface RefereeListEntry {
  id: string;
  name: string;
  country: string | null;
  matches: number;
  career: number | null;
  neutral: number | null;
  partisan: number | null;
  /** neutral minus partisan. The gap is usually the interesting part. */
  divergence: number | null;
}

/**
 * Every referee with a match on file.
 *
 * Deliberately ordered by name, not by score. A list sorted by rating is a
 * leaderboard, and a leaderboard of officials is the thing this site exists
 * not to be.
 */
export async function allReferees(): Promise<RefereeListEntry[]> {
  const db = anonClient();
  const { data, error } = await db
    .from("referee")
    .select(`
      id, canonical_name, country,
      referee_aggregate ( matches, career, neutral, partisan ),
      fixture ( id )
    `)
    .order("canonical_name");

  if (error) throw new Error(`allReferees: ${error.message}`);

  return (data ?? [])
    .map((r: any) => {
      const a = Array.isArray(r.referee_aggregate) ? r.referee_aggregate[0] : r.referee_aggregate;
      const neutral = a?.neutral ?? null;
      const partisan = a?.partisan ?? null;
      return {
        id: r.id,
        name: r.canonical_name,
        country: r.country,
        matches: a?.matches ?? (Array.isArray(r.fixture) ? r.fixture.length : 0),
        career: a?.career ?? null,
        neutral,
        partisan,
        divergence: neutral != null && partisan != null ? neutral - partisan : null,
      };
    })
    .filter((r) => r.matches > 0);
}

export interface RefereeMatch {
  fixtureId: number;
  kickoff: string;
  home: string;
  away: string;
  ftHome: number | null;
  ftAway: number | null;
  score: number | null;
  neutralScore: number | null;
  partisanScore: number | null;
  decisionCount: number;
}

export async function refereeMatches(refereeId: string): Promise<RefereeMatch[]> {
  const db = anonClient();
  const { data, error } = await db
    .from("fixture")
    .select(`
      id, kickoff, ft_home, ft_away,
      home:home_team_id ( name ),
      away:away_team_id ( name ),
      decision ( id ),
      match_score ( score, neutral_score, partisan_score )
    `)
    .eq("referee_id", refereeId)
    .order("kickoff", { ascending: false });

  if (error) throw new Error(`refereeMatches: ${error.message}`);

  return (data ?? []).map((f: any) => {
    const ms = Array.isArray(f.match_score) ? f.match_score[0] : f.match_score;
    return {
      fixtureId: f.id,
      kickoff: f.kickoff,
      home: f.home?.name ?? "Unknown",
      away: f.away?.name ?? "Unknown",
      ftHome: f.ft_home,
      ftAway: f.ft_away,
      score: ms?.score ?? null,
      neutralScore: ms?.neutral_score ?? null,
      partisanScore: ms?.partisan_score ?? null,
      decisionCount: Array.isArray(f.decision) ? f.decision.length : 0,
    };
  });
}


// ---------------------------------------------------------------------------
// The current matchweek
// ---------------------------------------------------------------------------

export interface MatchweekView {
  fixtures: FixtureSummary[];
  /** Matchweek number, when the provider gave one we could parse. */
  round: number | null;
  /** True when these matches can still be rated. */
  open: boolean;
  /** When rating closes, i.e. when the next matchweek kicks off. */
  closesAt: string | null;
}

/**
 * What the site should be showing right now.
 *
 * The rating window already encodes this: a fixture stays open until the next
 * matchweek kicks off, so "every fixture with an open window" IS the current
 * matchweek, without needing to know today's date or the fixture calendar.
 *
 * When nothing is open — the hours between one window closing and the next
 * round finishing — it falls back to the most recent completed matchweek, so
 * the page is never empty. That set is shown read-only, which is honest: those
 * matches genuinely are no longer rateable.
 */
export async function currentMatchweek(): Promise<MatchweekView> {
  const db = anonClient();
  const nowIso = new Date().toISOString();

  const openRes = await db
    .from("fixture")
    .select(`
      id, kickoff, competition_code, ft_home, ft_away, status, round,
      rating_opens_at, rating_closes_at, referee_id,
      home:home_team_id ( name ),
      away:away_team_id ( name ),
      referee:referee_id ( canonical_name ),
      decision ( id ),
      match_score ( score )
    `)
    .eq("status", "OPEN")
    .lte("rating_opens_at", nowIso)
    .gte("rating_closes_at", nowIso)
    .order("kickoff", { ascending: true });

  if (openRes.error) throw new Error(`currentMatchweek: ${openRes.error.message}`);

  if (openRes.data?.length) {
    const fixtures = openRes.data.map(mapFixture);
    return {
      fixtures,
      round: fixtures.find((f) => f.round != null)?.round ?? null,
      open: true,
      closesAt: fixtures.reduce<string | null>(
        (soonest, f) =>
          f.ratingClosesAt && (!soonest || f.ratingClosesAt < soonest) ? f.ratingClosesAt : soonest,
        null
      ),
    };
  }

  // Nothing open. Show the last completed matchweek rather than an empty page.
  const recent = await recentFixtures(30);
  if (!recent.length) return { fixtures: [], round: null, open: false, closesAt: null };

  const lastRound = recent.find((f) => f.round != null)?.round ?? null;
  const fixtures = lastRound == null ? recent.slice(0, 10) : recent.filter((f) => f.round === lastRound);

  return { fixtures, round: lastRound, open: false, closesAt: null };
}

function mapFixture(f: any): FixtureSummary {
  return {
    id: f.id,
    round: f.round ?? null,
    kickoff: f.kickoff,
    competition: f.competition_code,
    home: f.home?.name ?? "Unknown",
    away: f.away?.name ?? "Unknown",
    ftHome: f.ft_home,
    ftAway: f.ft_away,
    refereeId: f.referee_id,
    refereeName: f.referee?.canonical_name ?? null,
    status: f.status,
    ratingOpensAt: f.rating_opens_at,
    ratingClosesAt: f.rating_closes_at,
    decisionCount: Array.isArray(f.decision) ? f.decision.length : 0,
    matchScore: f.match_score?.[0]?.score ?? f.match_score?.score ?? null,
  };
}
