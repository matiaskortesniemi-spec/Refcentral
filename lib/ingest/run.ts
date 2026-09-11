/**
 * refcentral — ingest job
 *
 * For each competition in a date window:
 *   1. pull finished fixtures from API-Football
 *   2. pull the same window from football-data.org (one call) for linking
 *   3. per fixture: fetch events, adapt, link, resolve the referee, run rules
 *   4. write fixture + decisions, or BLOCK the fixture if the referee is
 *      quarantined
 *
 * Idempotent. Fixtures upsert on af_fixture_id, decisions on their
 * deterministic id, so a re-run after a partial failure repairs rather than
 * duplicates.
 *
 * A quarantined referee blocks its fixture rather than guessing. That is the
 * design decision from referees.ts carried through to the database: a blocked
 * fixture is invisible to users (see the RLS policy on `fixture`) until
 * someone resolves the name.
 */

import { SupabaseClient } from "@supabase/supabase-js";
import { ApiFootball, FootballData } from "./providers";
import { DbRefereeStore, TeamCache, serviceClient, startRun, finishRun } from "./store";
import { adaptApiFootball, AF_LEAGUES } from "../../src/adapters/apifootball";
import { findOfficials } from "../../src/adapters/footballdata";
import { runRules } from "../../src/rules";
import { RefereeResolver } from "../../src/referees";
import { FdMatchLite, Decision } from "../../src/types";

/**
 * Launching Premier League only.
 *
 * AF_LEAGUES still carries all six, and every other competition works by
 * passing --competitions. Narrowing the default is deliberate rather than a
 * limitation:
 *
 *   - the crowd thresholds in crowd.ts need a quorum of 400 weighted votes on
 *     a tier-5 incident. Concentrating an audience on ten matches a week gets
 *     there; spreading it across fifty does not.
 *   - the league-adjusted career score and per-competition priors exist to
 *     make a Serie A 3.4 comparable to a Bundesliga 3.4. With one competition
 *     that machinery is dormant, so launch does not depend on it being right.
 *   - the 100% cross-provider link rate measured in testing was a Premier
 *     League number. The Champions League, with team names in several
 *     languages, is where linking is most likely to degrade.
 *
 * Add competitions by extending this array once the above stop being true.
 */
export const DEFAULT_COMPETITIONS = ["PL"];

const RATING_DELAY_MIN = 90;
const RATING_WINDOW_HOURS = 72;
/** Full time isn't in either feed; approximate from kickoff. */
const APPROX_MATCH_MINUTES = 105;

export interface IngestOptions {
  from: string;              // YYYY-MM-DD
  to: string;                // YYYY-MM-DD
  season: number;
  competitions?: string[];   // defaults to DEFAULT_COMPETITIONS
  dryRun?: boolean;
  verbose?: boolean;
}

export interface IngestStats {
  fixturesSeen: number;
  fixturesWritten: number;
  fixturesBlocked: number;
  decisionsWritten: number;
  linked: number;
  linkFailed: number;
  refereesByFdId: number;
  refereesByName: number;
  refereesNew: number;
  quarantined: number;
  warnings: string[];
}

export async function ingest(opts: IngestOptions): Promise<IngestStats> {
  const stats: IngestStats = {
    fixturesSeen: 0, fixturesWritten: 0, fixturesBlocked: 0, decisionsWritten: 0,
    linked: 0, linkFailed: 0,
    refereesByFdId: 0, refereesByName: 0, refereesNew: 0, quarantined: 0,
    warnings: [],
  };

  const afKey = process.env.AF_KEY;
  const fdKey = process.env.FD_KEY;
  if (!afKey) throw new Error("AF_KEY not set");
  if (!fdKey) stats.warnings.push("FD_KEY not set — identity falls back to name matching only");

  const af = new ApiFootball(afKey);
  const fd = fdKey ? new FootballData(fdKey) : null;

  const db: SupabaseClient | null = opts.dryRun ? null : serviceClient();
  const runId = db ? await startRun(db, "INGEST", opts.from, opts.to) : null;

  const store = db ? await DbRefereeStore.load(db) : new (await import("../../src/referees")).InMemoryRefereeStore();
  const resolver = new RefereeResolver(store);
  const teams = db ? new TeamCache(db) : null;
  if (teams) await teams.preload();

  const codes = opts.competitions ?? DEFAULT_COMPETITIONS;

  try {
    for (const code of codes) {
      const league = AF_LEAGUES[code];
      if (!league) {
        stats.warnings.push(`unknown competition code ${code}`);
        continue;
      }

      log(opts, `\n[${code}] fetching fixtures ${opts.from}..${opts.to}`);
      let fixtures: any[] = [];
      try {
        fixtures = await af.fixtures(league.afId, opts.season, opts.from, opts.to);
      } catch (e) {
        stats.warnings.push(`[${code}] fixtures: ${e}`);
        continue;
      }
      log(opts, `[${code}] ${fixtures.length} finished fixtures`);
      stats.fixturesSeen += fixtures.length;
      if (fixtures.length === 0) continue;

      // One football-data call per competition, reused for every fixture.
      let fdCandidates: FdMatchLite[] = [];
      if (fd) {
        try {
          const raw = await fd.finishedMatches(league.fdCode, opts.from, opts.to);
          fdCandidates = raw as FdMatchLite[];
          log(opts, `[${code}] ${fdCandidates.length} football-data candidates`);
        } catch (e) {
          stats.warnings.push(`[${code}] football-data list: ${e}`);
        }
      }

      for (const f of fixtures) {
        try {
          await ingestOne(f, code, fdCandidates, {
            af, fd, db, teams, resolver, opts, stats,
          });
        } catch (e) {
          stats.warnings.push(`fixture ${f?.fixture?.id}: ${e}`);
        }
      }
    }

    if (db && store instanceof DbRefereeStore) {
      const flushed = await store.flush();
      log(opts, `\nflushed ${flushed.referees} referees, ${flushed.aliases} aliases`);
    }

    if (db) await finishRun(db, runId, true, stats);
    return stats;
  } catch (e) {
    if (db) await finishRun(db, runId, false, stats, String(e));
    throw e;
  }
}

// ---------------------------------------------------------------------------

interface Ctx {
  af: ApiFootball;
  fd: FootballData | null;
  db: SupabaseClient | null;
  teams: TeamCache | null;
  resolver: RefereeResolver;
  opts: IngestOptions;
  stats: IngestStats;
}

async function ingestOne(raw: any, code: string, fdCandidates: FdMatchLite[], ctx: Ctx) {
  const { af, fd, db, teams, resolver, opts, stats } = ctx;
  const afFixtureId = raw.fixture.id;

  const events = await af.events(afFixtureId);
  const match = adaptApiFootball(raw, events);
  stats.warnings.push(...match.warnings.map((w) => `fixture ${afFixtureId}: ${w}`));

  // --- link to football-data for a referee id ------------------------------
  let officials: { providerId: number | null; name: string; role: string; nationality: string | null }[] = [];
  let fdMatchId: number | null = null;
  let linkScore: number | null = null;

  if (fd && fdCandidates.length) {
    // The list representation has no referees[], so we shortlist on the list
    // and then spend one call on the single best candidate.
    const shortlist = fdCandidates.map((c) => ({ ...c, referees: [] as any[] }));
    const probe = findOfficials(match, shortlist);
    if (probe.link?.linked) {
      const best = shortlist.find((c) => probe.link && linkMatches(c, match));
      if (best) {
        try {
          const full = (await fd.match(best.id)) as FdMatchLite;
          const resolved = findOfficials(match, [full]);
          officials = resolved.officials;
          fdMatchId = full.id;
          linkScore = resolved.link?.score ?? probe.link.score;
          stats.linked++;
        } catch (e) {
          stats.warnings.push(`fixture ${afFixtureId}: football-data match fetch: ${e}`);
          stats.linkFailed++;
        }
      }
    } else {
      stats.linkFailed++;
    }
  }

  // --- resolve the referee --------------------------------------------------
  const main = officials.find((o) => o.role === "REFEREE");
  const resolution = main
    ? resolver.resolveByOfficial(main as any, match.refereeRaw)
    : resolver.resolveByName(match.refereeRaw);

  switch (resolution.confidence) {
    case "EXACT_ID": stats.refereesByFdId++; break;
    case "KNOWN_ALIAS":
    case "FUZZY_ACCEPT": stats.refereesByName++; break;
    case "NEW": stats.refereesNew++; break;
    case "QUARANTINE": stats.quarantined++; break;
  }

  // --- write ----------------------------------------------------------------
  const kickoff = new Date(match.kickoff);
  const fullTime = new Date(kickoff.getTime() + APPROX_MATCH_MINUTES * 60_000);
  const opensAt = new Date(fullTime.getTime() + RATING_DELAY_MIN * 60_000);
  const closesAt = new Date(opensAt.getTime() + RATING_WINDOW_HOURS * 3_600_000);

  const blocked = resolution.blocked || !resolution.referee;
  const result = runRules(match);
  stats.warnings.push(...result.warnings.map((w) => `fixture ${afFixtureId}: ${w}`));

  log(opts,
    `  ${raw.teams.home.name} v ${raw.teams.away.name}  ` +
    `ref=${resolution.referee?.canonicalName ?? "?"} (${resolution.confidence})  ` +
    `link=${linkScore?.toFixed(3) ?? "none"}  decisions=${result.decisions.length}` +
    (blocked ? "  BLOCKED" : "")
  );

  if (!db || !teams) {
    if (blocked) stats.fixturesBlocked++;
    else { stats.fixturesWritten++; stats.decisionsWritten += result.decisions.length; }
    return;
  }

  if (blocked) {
    await db.from("referee_quarantine").insert({
      raw_name: match.refereeRaw ?? "(none supplied)",
      country: null,
      score: resolution.score,
      rivals: resolution.rivals,
      reason: resolution.reason,
      af_fixture_id: afFixtureId,
    });
    stats.fixturesBlocked++;
  }

  const homeId = await teams.ensure(raw.teams.home.id, raw.teams.home.name);
  const awayId = await teams.ensure(raw.teams.away.id, raw.teams.away.name);

  const { data: fixtureRow, error: fixtureErr } = await db
    .from("fixture")
    .upsert(
      {
        af_fixture_id: afFixtureId,
        fd_match_id: fdMatchId,
        link_score: linkScore,
        competition_code: code,
        season: opts.season,
        kickoff: kickoff.toISOString(),
        home_team_id: homeId,
        away_team_id: awayId,
        ft_home: match.fullTime.home,
        ft_away: match.fullTime.away,
        referee_id: resolution.referee?.id ?? null,
        status: blocked ? "BLOCKED" : "OPEN",
        rating_opens_at: opensAt.toISOString(),
        rating_closes_at: closesAt.toISOString(),
      },
      { onConflict: "af_fixture_id" }
    )
    .select("id")
    .single();

  if (fixtureErr) throw new Error(`upserting fixture: ${fixtureErr.message}`);
  stats.fixturesWritten++;

  if (result.decisions.length) {
    const rows = result.decisions.map((d: Decision) => ({
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
    }));
    const { error: decErr } = await db.from("decision").upsert(rows, { onConflict: "id" });
    if (decErr) throw new Error(`upserting decisions: ${decErr.message}`);
    stats.decisionsWritten += rows.length;
  }
}

/** Cheap re-check so we pick the same candidate findOfficials scored best. */
function linkMatches(c: FdMatchLite, match: { home: { name: string }; away: { name: string } }): boolean {
  const norm = (s: string) => s.toLowerCase().replace(/[^a-z]/g, "");
  const h = norm(c.homeTeam.name);
  const a = norm(c.awayTeam.name);
  return h.includes(norm(match.home.name).slice(0, 5)) || a.includes(norm(match.away.name).slice(0, 5));
}

function log(opts: IngestOptions, msg: string) {
  if (opts.verbose !== false) console.log(msg);
}
