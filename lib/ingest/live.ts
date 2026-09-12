/**
 * refcentral — live ingest
 *
 * Polls in-play fixtures and writes decisions as they happen, so a match is
 * visible and rateable while it is still being played.
 *
 * Two things make this harder than it looks.
 *
 * VAR SETTLING. A penalty given at 28' and overturned at 30' are one event,
 * and the rules fold them into a single decision. Publishing the penalty
 * instantly means someone can rate a call that is about to be reversed, and
 * their rating then belongs to a decision that no longer exists in that form.
 * So decisions that VAR can touch — penalties, reds, disallowed goals — are
 * held for a short settling period before they become rateable. Everything
 * else publishes immediately.
 *
 * TIER STABILITY. The escalators read the score at the minute of the call, so
 * a card at 80' in a one-goal game is tier 3. If the game finishes 4-0 that
 * reading does not change, because the state at the time is what mattered.
 * That is deliberate and it is why live tiering is safe: nothing recomputes
 * after the fact.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { ApiFootball } from "./providers";
import { serviceClient, DbRefereeStore, TeamCache, startRun, finishRun } from "./store";
import { adaptApiFootball, AF_LEAGUES } from "../../src/adapters/apifootball";
import { runRules } from "../../src/rules";
import { RefereeResolver } from "../../src/referees";
import { Decision, DecisionType } from "../../src/types";
import { roundNumber } from "./matchweek";

/**
 * How long a VAR-touchable decision waits before it can be rated.
 *
 * Three minutes covers the overwhelming majority of on-field reviews. The
 * decision is still shown immediately — it is only the rating that waits, so
 * the page stays live while the record stays correct.
 */
export const VAR_SETTLE_MINUTES = 3;

/** Decision types a VAR review can still change. */
const VAR_TOUCHABLE: DecisionType[] = [
  "PENALTY_AWARDED", "PENALTY_MISSED", "RED_CARD", "SECOND_YELLOW",
];

/**
 * Rough full time, used to gate the game-management rating.
 *
 * Individual calls can be judged the moment they happen — you saw the tackle,
 * you have an opinion. "Control, communication, consistency" is a judgement
 * about the whole ninety minutes, and rating it at minute 20 is rating a
 * match that has not happened yet. So it stays visible throughout and becomes
 * rateable at the final whistle.
 */
const APPROX_FULL_TIME_MIN = 115;

/** API-Football short codes for a match currently being played. */
const IN_PLAY = ["1H", "HT", "2H", "ET", "BT", "P", "LIVE"];

export interface LiveOptions {
  league?: number;
  season?: number;
  /** Seconds between polls. */
  interval?: number;
  /** Stop after this many minutes. Omit to run until no matches are in play. */
  maxMinutes?: number;
  verbose?: boolean;
  client?: SupabaseClient;
}

export interface LiveStats {
  polls: number;
  fixturesTracked: number;
  decisionsWritten: number;
  pendingVar: number;
  warnings: string[];
}

export async function runLive(opts: LiveOptions = {}): Promise<LiveStats> {
  const afKey = process.env.AF_KEY;
  if (!afKey) throw new Error("AF_KEY not set");

  const league = opts.league ?? AF_LEAGUES.PL.afId;
  const season = opts.season ?? currentSeason();
  const interval = (opts.interval ?? 60) * 1000;
  const log = (m: string) => opts.verbose !== false && console.log(m);

  const af = new ApiFootball(afKey);
  const db = opts.client ?? serviceClient();
  const runId = await startRun(db, "LIVE", new Date().toISOString(), new Date().toISOString());

  const store = await DbRefereeStore.load(db);
  const resolver = new RefereeResolver(store);
  const teams = new TeamCache(db);
  await teams.preload();

  const stats: LiveStats = {
    polls: 0, fixturesTracked: 0, decisionsWritten: 0, pendingVar: 0, warnings: [],
  };

  const started = Date.now();
  const seenDecisions = new Set<string>();
  const trackedFixtures = new Set<number>();

  try {
    for (;;) {
      stats.polls++;

      let live: any[] = [];
      try {
        live = await af.get<any[]>(`/fixtures?league=${league}&season=${season}&live=all`);
      } catch (e) {
        stats.warnings.push(`poll: ${e}`);
        await sleep(interval);
        continue;
      }

      const inPlay = live.filter((f) => IN_PLAY.includes(f.fixture?.status?.short));
      log(`poll ${stats.polls}: ${inPlay.length} in play`);

      if (inPlay.length === 0 && trackedFixtures.size > 0) {
        log("no matches in play — live run finished");
        break;
      }

      for (const raw of inPlay) {
        try {
          const written = await pollOne(raw, { af, db, teams, resolver, store, seenDecisions, stats, log });
          stats.decisionsWritten += written;
          trackedFixtures.add(raw.fixture.id);
        } catch (e) {
          stats.warnings.push(`fixture ${raw?.fixture?.id}: ${e}`);
        }
      }

      stats.fixturesTracked = trackedFixtures.size;

      if (opts.maxMinutes && Date.now() - started > opts.maxMinutes * 60_000) {
        log(`reached ${opts.maxMinutes} minute limit`);
        break;
      }
      await sleep(interval);
    }

    await store.flush();
    await finishRun(db, runId, true, stats);
    return stats;
  } catch (e) {
    await finishRun(db, runId, false, stats, String(e));
    throw e;
  }
}

// ---------------------------------------------------------------------------

interface PollCtx {
  af: ApiFootball;
  db: SupabaseClient;
  teams: TeamCache;
  resolver: RefereeResolver;
  store: DbRefereeStore;
  seenDecisions: Set<string>;
  stats: LiveStats;
  log: (m: string) => void;
}

async function pollOne(raw: any, ctx: PollCtx): Promise<number> {
  const { af, db, teams, resolver, store, seenDecisions, stats, log } = ctx;
  const afId = raw.fixture.id;

  const events = await af.events(afId);
  const match = adaptApiFootball(raw, events);

  // The adapter marks a match finished on FT; an in-play fixture is not, and
  // runRules refuses to score an unfinished match. Live is the one place that
  // check has to be bypassed, because the whole point is scoring in progress.
  const result = runRules({ ...match, finished: true });

  /**
   * The referee is often absent from a live fixture — API-Football tends to
   * populate it only after the match. Bailing out here meant a live match
   * was never written at all, so the site showed nothing while five games
   * were being played.
   *
   * A referee is not needed to display a match in progress. Write the fixture
   * without one and let the post-match ingest attach the official later, when
   * the feed actually has it. The referee page simply gains the match then.
   */
  let refereeId: string | null = null;
  if (match.refereeRaw) {
    const resolution = resolver.resolveByName(match.refereeRaw);
    if (resolution.referee && !resolution.blocked) {
      refereeId = resolution.referee.id;
      await store.flushOne(resolution.referee.id);
    }
  }

  const homeId = await teams.ensure(raw.teams.home.id, raw.teams.home.name);
  const awayId = await teams.ensure(raw.teams.away.id, raw.teams.away.name);
  const kickoff = new Date(match.kickoff);

  const { data: fixtureRow, error: fxErr } = await db
    .from("fixture")
    .upsert(
      {
        af_fixture_id: afId,
        competition_code: "PL",
        season: raw.league?.season ?? currentSeason(),
        round: roundNumber(raw.league?.round ?? null),
        kickoff: kickoff.toISOString(),
        home_team_id: homeId,
        away_team_id: awayId,
        // The live score. Named ft_* for the finished case, but carrying the
        // running score means the card shows 1–0 during the match instead of
        // an empty dash.
        ft_home: raw.goals?.home ?? null,
        ft_away: raw.goals?.away ?? null,
        referee_id: refereeId,
        status: "OPEN",
        // Opens now. The per-decision settling below is what actually gates
        // whether an individual call can be rated yet.
        rating_opens_at: kickoff.toISOString(),
        rating_closes_at: new Date(kickoff.getTime() + 7 * 86_400_000).toISOString(),
      },
      { onConflict: "af_fixture_id" }
    )
    .select("id")
    .single();

  if (fxErr) throw new Error(`upserting live fixture: ${fxErr.message}`);

  const fresh = result.decisions.filter((d: Decision) => !seenDecisions.has(d.id));
  if (fresh.length === 0) {
    log(
      `  ${raw.teams.home.name} v ${raw.teams.away.name} ${raw.fixture.status.elapsed}'` +
      ` · fixture written, no new decisions` +
      (refereeId ? "" : " · referee not yet published by the feed")
    );
    return 0;
  }

  const now = Date.now();
  const approxFullTime = kickoff.getTime() + APPROX_FULL_TIME_MIN * 60_000;

  const rows = fresh.map((d: Decision) => {
    const settling = VAR_TOUCHABLE.includes(d.type);
    if (settling) stats.pendingVar++;

    const rateableAt =
      d.type === "GAME_MANAGEMENT"
        ? approxFullTime
        : settling
          ? now + VAR_SETTLE_MINUTES * 60_000
          : now;

    return {
      id: d.id,
      fixture_id: fixtureRow.id,
      type: d.type,
      tier: d.tier,
      minute: d.minute,
      extra_time: d.extra,
      favours: d.favours,
      against: d.against,
      player_name: d.playerName,
      team_id: null,
      label: d.label,
      rule_id: d.ruleId,
      tier_reasons: d.tierReasons,
      var_note: d.varNote ?? null,
      source: d.source,
      // Shown immediately; rateable when it can be judged fairly.
      rateable_from: new Date(rateableAt).toISOString(),
    };
  });

  const { error: decErr } = await db.from("decision").upsert(rows, { onConflict: "id" });
  if (decErr) throw new Error(`upserting live decisions: ${decErr.message}`);

  for (const d of fresh) seenDecisions.add(d.id);
  log(
    `  ${raw.teams.home.name} v ${raw.teams.away.name} ${raw.fixture.status.elapsed}' ` +
    `· +${fresh.length} decision${fresh.length === 1 ? "" : "s"}`
  );
  return fresh.length;
}

function currentSeason(now = new Date()): number {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? y : y - 1;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
