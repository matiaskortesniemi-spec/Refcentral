/**
 * refcentral — ingest CLI
 *
 *   npx tsx scripts/ingest.ts --dry-run --from 2024-08-16 --to 2024-08-19
 *   npx tsx scripts/ingest.ts --from 2024-08-16 --to 2024-08-19 --competitions PL
 *
 * --dry-run touches the providers but never the database. Start there.
 *
 * Defaults to the last three days, which is the window a nightly cron wants:
 * wide enough to catch a fixture the previous run missed, narrow enough to
 * stay cheap. Re-running is safe — every write is an upsert on a
 * deterministic key.
 */

import { ingest } from "../lib/ingest/run";

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

(async () => {
  const today = new Date();
  const threeDaysAgo = new Date(today.getTime() - 3 * 86_400_000);

  const from = arg("from", isoDate(threeDaysAgo))!;
  const to = arg("to", isoDate(today))!;
  const season = Number(arg("season", process.env.SEASON ?? "2024"));
  const comps = arg("competitions");
  const dryRun = flag("dry-run");

  console.log("refcentral ingest");
  console.log(`  window      ${from} .. ${to}`);
  console.log(`  season      ${season}`);
  console.log(`  competitions ${comps ?? "all six"}`);
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
