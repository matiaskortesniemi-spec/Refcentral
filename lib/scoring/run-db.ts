/**
 * refcentral — scoring job, database wiring
 *
 * src/scoring/job.ts holds the maths and knows nothing about Postgres. This
 * file loads rows, hands them over, and writes results back. Keeping that
 * split is why the scoring demo runs with no database and no keys.
 *
 * Runs with the service role key, and that is necessary rather than
 * convenient. Raw ratings are deliberately unreadable through RLS — if they
 * weren't, the cooldown would be meaningless and a brigade could watch its
 * push land. The scoring job is the one thing permitted to see individual
 * ratings, which is what lets the site publish a conclusion without ever
 * exposing who concluded what.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { serviceClient, startRun, finishRun } from "../ingest/store";
import { Decision, DecisionType, Tier } from "../../src/types";
import { Rating, ScoredDecision, Priors } from "../../src/scoring/types";
import { UserMeta } from "../../src/scoring/brigade";
import {
  buildPriors, runScoringJob, FixtureMeta, JobOutput,
} from "../../src/scoring/job";

export interface ScoreOptions {
  /** Only rescore fixtures whose rating window touches this many days back. */
  sinceDays?: number;
  dryRun?: boolean;
  verbose?: boolean;
  /**
   * Injectable client. Defaults to the service-role client; tests pass a fake
   * so the whole load-compute-write path can run without a database.
   */
  client?: SupabaseClient;
}

export interface ScoreStats {
  fixtures: number;
  decisions: number;
  ratings: number;
  scoredWritten: number;
  matchesWritten: number;
  refereesWritten: number;
  held: number;
  alerts: number;
  priorSources: Record<string, number>;
}

// ---------------------------------------------------------------------------
// Loading
// ---------------------------------------------------------------------------

async function loadFixtures(
  db: SupabaseClient,
  sinceDays: number
): Promise<Map<number, FixtureMeta>> {
  const since = new Date(Date.now() - sinceDays * 86_400_000).toISOString();

  const { data, error } = await db
    .from("fixture")
    .select("id, referee_id, competition_code, kickoff, rating_opens_at, referee:referee_id(canonical_name)")
    .in("status", ["OPEN", "CLOSED"])
    .not("referee_id", "is", null)
    .gte("kickoff", since);

  if (error) throw new Error(`loading fixtures: ${error.message}`);

  const out = new Map<number, FixtureMeta>();
  for (const f of data ?? []) {
    const ref: any = Array.isArray((f as any).referee) ? (f as any).referee[0] : (f as any).referee;
    out.set(f.id, {
      fixtureId: f.id,
      refereeId: f.referee_id!,
      refereeName: ref?.canonical_name ?? f.referee_id!,
      competition: f.competition_code,
      kickoff: f.kickoff,
      ratingOpenedAt: f.rating_opens_at ?? f.kickoff,
    });
  }
  return out;
}

async function loadDecisions(db: SupabaseClient, fixtureIds: number[]): Promise<Decision[]> {
  if (!fixtureIds.length) return [];

  const { data, error } = await db
    .from("decision")
    .select("id, fixture_id, type, tier, minute, extra_time, favours, against, player_name, team_id, label, rule_id, tier_reasons, var_note, source, created_at")
    .in("fixture_id", fixtureIds);

  if (error) throw new Error(`loading decisions: ${error.message}`);

  return (data ?? []).map((d: any) => ({
    id: d.id,
    fixtureId: d.fixture_id,
    type: d.type as DecisionType,
    tier: d.tier as Tier,
    minute: d.minute,
    extra: d.extra_time,
    favours: d.favours,
    against: d.against,
    playerId: null,
    playerName: d.player_name,
    teamId: d.team_id,
    label: d.label,
    ruleId: d.rule_id,
    tierReasons: d.tier_reasons ?? [],
    source: d.source,
    varNote: d.var_note ?? undefined,
    createdAt: d.created_at,
  }));
}

/**
 * Ratings joined to the allegiance the user declared for that fixture.
 *
 * `effective`, not `declared` — the override from declare_allegiance() is the
 * whole point. A supporter who clicked "Neither" on their own club's match
 * must be weighted as a supporter here.
 */
async function loadRatings(db: SupabaseClient, fixtureIds: number[]): Promise<Rating[]> {
  if (!fixtureIds.length) return [];

  const { data: rows, error } = await db
    .from("rating")
    .select("user_id, decision_id, fixture_id, value, created_at")
    .in("fixture_id", fixtureIds);
  if (error) throw new Error(`loading ratings: ${error.message}`);

  const { data: alls, error: allErr } = await db
    .from("allegiance")
    .select("user_id, fixture_id, effective")
    .in("fixture_id", fixtureIds);
  if (allErr) throw new Error(`loading allegiances: ${allErr.message}`);

  const key = (u: string, f: number) => `${u}|${f}`;
  const byUserFixture = new Map<string, string>();
  for (const a of alls ?? []) byUserFixture.set(key(a.user_id, a.fixture_id), a.effective);

  const out: Rating[] = [];
  for (const r of rows ?? []) {
    // An RLS policy makes this impossible, but a rating with no declaration
    // has no defensible weight, so drop rather than guess.
    const allegiance = byUserFixture.get(key(r.user_id, r.fixture_id));
    if (!allegiance) continue;
    out.push({
      decisionId: r.decision_id,
      fixtureId: r.fixture_id,
      userId: r.user_id,
      value: Number(r.value),
      allegiance: allegiance as Rating["allegiance"],
      createdAt: r.created_at,
    });
  }
  return out;
}

async function loadUsers(db: SupabaseClient, userIds: string[]): Promise<Map<string, UserMeta>> {
  const out = new Map<string, UserMeta>();
  if (!userIds.length) return out;

  const { data, error } = await db
    .from("app_user")
    .select("id, created_at, prior_ratings")
    .in("id", userIds);
  if (error) throw new Error(`loading users: ${error.message}`);

  for (const u of data ?? []) {
    out.set(u.id, {
      userId: u.id,
      createdAt: u.created_at,
      priorRatings: u.prior_ratings ?? 0,
    });
  }
  return out;
}

/** Last run's scores, so a held decision can republish its previous value. */
async function loadPrevious(
  db: SupabaseClient,
  decisionIds: string[]
): Promise<Map<string, ScoredDecision>> {
  const out = new Map<string, ScoredDecision>();
  if (!decisionIds.length) return out;

  const { data, error } = await db
    .from("scored_decision")
    .select("decision_id, fixture_id, score, raw_combined, effective_n, prior_value, prior_source, neutral_mean, partisan_mean, divergence, flags, held")
    .in("decision_id", decisionIds);
  if (error) throw new Error(`loading previous scores: ${error.message}`);

  for (const s of data ?? []) {
    out.set(s.decision_id, {
      decisionId: s.decision_id,
      fixtureId: s.fixture_id,
      type: "GAME_MANAGEMENT",
      tier: 1,
      score: Number(s.score),
      rawCombined: s.raw_combined === null ? null : Number(s.raw_combined),
      effectiveN: Number(s.effective_n),
      prior: { value: Number(s.prior_value), source: s.prior_source, m: 40 },
      buckets: {} as any,
      neutralMean: s.neutral_mean === null ? null : Number(s.neutral_mean),
      partisanMean: s.partisan_mean === null ? null : Number(s.partisan_mean),
      divergence: s.divergence === null ? null : Number(s.divergence),
      flags: s.flags ?? [],
      held: s.held,
    });
  }
  return out;
}

// ---------------------------------------------------------------------------
// Priors
// ---------------------------------------------------------------------------

/**
 * Priors are rebuilt from everything already scored, then the run uses them.
 * They are never built from the output of the run in progress, or the prior
 * would feed on its own product and drift toward itself.
 */
async function buildPriorsFromDb(db: SupabaseClient): Promise<Priors> {
  const { data: scored, error } = await db
    .from("scored_decision")
    .select("raw_combined, effective_n, held, decision:decision_id(type, fixture_id), fixture:fixture_id(competition_code)");
  if (error) throw new Error(`building priors: ${error.message}`);

  const { data: matches, error: msErr } = await db
    .from("match_score")
    .select("competition_code, score, held");
  if (msErr) throw new Error(`building priors: ${msErr.message}`);

  const scoredInput = (scored ?? [])
    .filter((s: any) => !s.held)
    .map((s: any) => {
      const d = Array.isArray(s.decision) ? s.decision[0] : s.decision;
      const f = Array.isArray(s.fixture) ? s.fixture[0] : s.fixture;
      return {
        competition: f?.competition_code ?? "PL",
        type: (d?.type ?? "GAME_MANAGEMENT") as DecisionType,
        rawCombined: s.raw_combined === null ? null : Number(s.raw_combined),
        effectiveN: Number(s.effective_n),
      };
    });

  const matchInput = (matches ?? [])
    .filter((m: any) => !m.held)
    .map((m: any) => ({ competition: m.competition_code, score: Number(m.score) }));

  return buildPriors(scoredInput, matchInput);
}

// ---------------------------------------------------------------------------
// Writing
// ---------------------------------------------------------------------------

async function writeResults(
  db: SupabaseClient,
  out: JobOutput,
  fixtures: Map<number, FixtureMeta>
): Promise<{ scored: number; matches: number; referees: number }> {
  if (out.decisions.length) {
    const rows = out.decisions.map((d) => ({
      decision_id: d.decisionId,
      fixture_id: d.fixtureId,
      score: d.score,
      raw_combined: d.rawCombined,
      effective_n: d.effectiveN,
      prior_value: d.prior.value,
      prior_source: d.prior.source,
      neutral_mean: d.neutralMean,
      partisan_mean: d.partisanMean,
      divergence: d.divergence,
      buckets: d.buckets,
      flags: d.flags,
      held: d.held,
      scored_at: new Date().toISOString(),
    }));
    const { error } = await db.from("scored_decision").upsert(rows, { onConflict: "decision_id" });
    if (error) throw new Error(`writing scored_decision: ${error.message}`);
  }

  if (out.matches.length) {
    const rows = out.matches.map((m) => ({
      fixture_id: m.fixtureId,
      referee_id: m.refereeId,
      competition_code: m.competition,
      score: m.score,
      neutral_score: m.neutralScore,
      partisan_score: m.partisanScore,
      decision_count: m.decisionCount,
      effective_n: m.effectiveN,
      flags: m.flags,
      held: m.held,
      scored_at: new Date().toISOString(),
    }));
    const { error } = await db.from("match_score").upsert(rows, { onConflict: "fixture_id" });
    if (error) throw new Error(`writing match_score: ${error.message}`);
  }

  if (out.referees.length) {
    const rows = out.referees.map((r) => ({
      referee_id: r.refereeId,
      matches: r.matches,
      career: r.career,
      career_raw: r.careerRaw,
      career_adjusted: r.careerAdjusted,
      neutral: r.neutral,
      partisan: r.partisan,
      form: r.form,
      categories: r.categories,
      per_competition: r.perCompetition,
      scored_at: new Date().toISOString(),
    }));
    const { error } = await db.from("referee_aggregate").upsert(rows, { onConflict: "referee_id" });
    if (error) throw new Error(`writing referee_aggregate: ${error.message}`);
  }

  for (const a of out.alerts) {
    await db.from("score_alert").insert({
      decision_id: a.decisionId,
      flags: a.flags,
      detail: a.detail,
      held: out.decisions.find((d) => d.decisionId === a.decisionId)?.held ?? false,
    });
  }

  // Persist priors so a later run can inspect what was used.
  const priorRows = [
    ...[...out.priors.leagueType].map(([key, v]) => ({ scope: "LEAGUE_TYPE", key, mean: v.mean, n: v.n })),
    ...[...out.priors.globalType].map(([key, v]) => ({ scope: "GLOBAL_TYPE", key, mean: v.mean, n: v.n })),
    ...[...out.priors.leagueReferee].map(([key, v]) => ({ scope: "LEAGUE_REFEREE", key, mean: v.mean, n: v.n })),
  ];
  if (priorRows.length) {
    await db.from("prior").upsert(priorRows, { onConflict: "scope,key" });
  }

  return {
    scored: out.decisions.length,
    matches: out.matches.length,
    referees: out.referees.length,
  };
}

/** Keeps the brigade detector's new-account signal honest. */
async function refreshPriorRatingCounts(db: SupabaseClient, ratings: Rating[]): Promise<void> {
  const counts = new Map<string, number>();
  for (const r of ratings) counts.set(r.userId, (counts.get(r.userId) ?? 0) + 1);
  for (const [userId, n] of counts) {
    await db.from("app_user").update({ prior_ratings: n }).eq("id", userId);
  }
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

export async function score(opts: ScoreOptions = {}): Promise<ScoreStats> {
  const sinceDays = opts.sinceDays ?? 30;
  const log = (m: string) => opts.verbose !== false && console.log(m);

  const db = opts.client ?? serviceClient();
  const runId = opts.dryRun ? null : await startRun(db, "SCORE", new Date(Date.now() - sinceDays * 86_400_000).toISOString(), new Date().toISOString());

  try {
    const fixtures = await loadFixtures(db, sinceDays);
    const ids = [...fixtures.keys()];
    log(`${fixtures.size} fixtures in scope`);

    const decisions = await loadDecisions(db, ids);
    const ratings = await loadRatings(db, ids);
    log(`${decisions.length} decisions, ${ratings.length} ratings`);

    if (ratings.length === 0) {
      log("no ratings yet — nothing to score");
      const empty: ScoreStats = {
        fixtures: fixtures.size, decisions: decisions.length, ratings: 0,
        scoredWritten: 0, matchesWritten: 0, refereesWritten: 0,
        held: 0, alerts: 0, priorSources: {},
      };
      if (runId) await finishRun(db, runId, true, empty);
      return empty;
    }

    const users = await loadUsers(db, [...new Set(ratings.map((r) => r.userId))]);
    const previous = await loadPrevious(db, decisions.map((d) => d.id));
    const priors = await buildPriorsFromDb(db);

    const out = runScoringJob({ decisions, ratings, fixtures, users, previous }, priors);

    const priorSources: Record<string, number> = {};
    for (const d of out.decisions) {
      priorSources[d.prior.source] = (priorSources[d.prior.source] ?? 0) + 1;
    }

    const stats: ScoreStats = {
      fixtures: fixtures.size,
      decisions: decisions.length,
      ratings: ratings.length,
      scoredWritten: 0,
      matchesWritten: 0,
      refereesWritten: 0,
      held: out.decisions.filter((d) => d.held).length,
      alerts: out.alerts.length,
      priorSources,
    };

    if (!opts.dryRun) {
      const written = await writeResults(db, out, fixtures);
      stats.scoredWritten = written.scored;
      stats.matchesWritten = written.matches;
      stats.refereesWritten = written.referees;
      await refreshPriorRatingCounts(db, ratings);
    }

    if (runId) await finishRun(db, runId, true, stats);
    return stats;
  } catch (e) {
    if (runId) await finishRun(db, runId, false, {}, String(e));
    throw e;
  }
}
