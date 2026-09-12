/**
 * refcentral — scoring CLI
 *
 *   npm run score            score the last 30 days
 *   npm run score:dry        compute everything, write nothing
 *   npm run score -- --since 90
 *
 * Safe to re-run. Every write is an upsert keyed on the decision, fixture or
 * referee, so a failed run is repaired by running it again.
 */

import { score } from "../lib/scoring/run-db";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  return fallback;
};

(async () => {
  const sinceDays = Number(arg("since", "30"));
  const dryRun = process.argv.includes("--dry-run");

  console.log("refcentral scoring");
  console.log(`  window  last ${sinceDays} days`);
  console.log(`  mode    ${dryRun ? "DRY RUN — no database writes" : "writing to Supabase"}\n`);

  const started = Date.now();
  try {
    const s = await score({ sinceDays, dryRun });

    console.log(`\n=== done in ${((Date.now() - started) / 1000).toFixed(1)}s ===`);
    console.log(`  fixtures in scope   ${s.fixtures}`);
    console.log(`  decisions           ${s.decisions}`);
    console.log(`  ratings counted     ${s.ratings}`);
    console.log("");
    console.log(`  scored_decision     ${s.scoredWritten}`);
    console.log(`  match_score         ${s.matchesWritten}`);
    console.log(`  referee_aggregate   ${s.refereesWritten}`);

    if (s.held) console.log(`\n  ${s.held} decision(s) HELD — previous value republished`);
    if (s.alerts) console.log(`  ${s.alerts} alert(s) written to score_alert`);

    if (Object.keys(s.priorSources).length) {
      console.log("\n  prior sources used:");
      for (const [src, n] of Object.entries(s.priorSources)) {
        console.log(`    ${src.padEnd(14)} ${n}`);
      }
      if (s.priorSources.FALLBACK) {
        console.log(
          "\n  FALLBACK means not enough history exists yet for a league-specific\n" +
          "  baseline. Correct behaviour early on, not a problem to fix."
        );
      }
    }
  } catch (e) {
    console.error(`\nscoring failed: ${e}`);
    process.exit(1);
  }
})();
