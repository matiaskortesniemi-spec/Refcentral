/**
 * refcentral — ingest CLI
 *
 *   npx tsx scripts/ingest.ts --dry-run --from 2024-08-16 --to 2024-08-19
 *   npx tsx scripts/ingest.ts --from 2024-08-16 --to 2024-08-19
 *
 * Defaults to the Premier League. Other competitions still work — pass
 * --competitions SA,BL1 — but nothing runs them on a schedule.
 *
 * --dry-run touches the providers but never the database. Start there.
 *
 * Defaults to the last three days, which is the window a nightly cron wants:
 * wide enough to catch a fixture the previous run missed, narrow enough to
 * stay cheap. Re-running is safe — every write is an upsert on a
 * deterministic key.
 */

import { ingest, DEFAULT_COMPETITIONS } from "../lib/ingest/run";

function arg(name: string, fallback?: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  return fallback;
}
const flag = (name: string) => process.argv.includes(`--${name}`);

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

/**
 * API-Football names a season by the year it starts in, so the 2026-27
 * Premier League season is season=2026. European seasons begin in summer, so
 * anything from July onward belongs to the current calendar year.
 */
function currentSeason(now = new Date()): number {
  const y = now.getUTCFullYear();
  return now.getUTCMonth() >= 6 ? y : y - 1;
}

(async () => {
  const today = new Date();
  // Ten days rather than three: long enough to cover a full matchweek
  // including a Monday-night fixture, plus a re-run margin if a job failed.
  // Every write is an upsert, so overlap costs a request and nothing else.
  const threeDaysAgo = new Date(today.getTime() - 10 * 86_400_000);

  const from = arg("from", isoDate(threeDaysAgo))!;
  const to = arg("to", isoDate(today))!;
  const season = Number(arg("season", process.env.SEASON ?? String(currentSeason())));
  const comps = arg("competitions");
  const dryRun = flag("dry-run");

  console.log("refcentral ingest");
  console.log(`  window      ${from} .. ${to}`);
  console.log(`  season      ${season}`);
  console.log(`  competitions ${comps ?? DEFAULT_COMPETITIONS.join(",") + " (default)"}`);
  console.log(`  mode        ${dryRun ? "DRY RUN — no database writes" : "writing to Supabase"}`);

  const started = Date.now();
  try {
    const stats = await ingest({
      from,
      to,
      season,
      competitions: comps ? comps.split(",").map((s) => s.trim()) : undefined,
      dryRun,
    });

    console.log(`\n=== done in ${((Date.now() - started) / 1000).toFixed(0)}s ===`);
    console.log(`  fixtures seen      ${stats.fixturesSeen}`);
    console.log(`  fixtures written   ${stats.fixturesWritten}`);
    console.log(`  fixtures blocked   ${stats.fixturesBlocked}`);
    console.log(`  decisions written  ${stats.decisionsWritten}`);
    console.log("");
    console.log("  === the number this whole exercise was for ===");
    const attempted = stats.linked + stats.linkFailed;
    const pct = attempted ? ((stats.linked / attempted) * 100).toFixed(1) : "n/a";
    console.log(`  cross-provider link succeeded  ${stats.linked}/${attempted}  (${pct}%)`);
    console.log("");
    console.log("  referee resolution:");
    console.log(`    by football-data id   ${stats.refereesByFdId}   <- the good path`);
    console.log(`    by name matching      ${stats.refereesByName}`);
    console.log(`    new referee created   ${stats.refereesNew}`);
    console.log(`    quarantined           ${stats.quarantined}   <- blocks its fixture`);

    if (stats.warnings.length) {
      console.log(`\n  ${stats.warnings.length} warnings:`);
      const seen = new Set<string>();
      for (const w of stats.warnings) {
        const key = w.replace(/fixture \d+/, "fixture N");
        if (seen.has(key)) continue;
        seen.add(key);
        console.log(`    - ${w}`);
      }
      if (stats.warnings.length > seen.size) {
        console.log(`    (${stats.warnings.length - seen.size} more, deduplicated)`);
      }
    }
  } catch (e) {
    console.error(`\ningest failed: ${e}`);
    process.exit(1);
  }
})();
