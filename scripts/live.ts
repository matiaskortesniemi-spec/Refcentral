/**
 * refcentral — live ingest CLI
 *
 *   npm run live                    poll until no matches are in play
 *   npm run live -- --interval 30   poll every 30 seconds
 *   npm run live -- --max 150       stop after 150 minutes
 *
 * Start it around kickoff. It exits on its own once every tracked match has
 * finished, so it can be launched and left alone.
 *
 * Request cost: one call per poll to list in-play fixtures, plus one per
 * fixture for events. Ten concurrent matches polled every 60 seconds for two
 * hours is roughly 1,300 requests — comfortable inside the Pro plan's daily
 * 7,500, but worth knowing before setting the interval to 10 seconds.
 */

import { runLive } from "../lib/ingest/live";

const arg = (name: string, fallback?: string) => {
  const i = process.argv.indexOf(`--${name}`);
  if (i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith("--")) {
    return process.argv[i + 1];
  }
  return fallback;
};

(async () => {
  const interval = Number(arg("interval", "60"));
  const maxMinutes = arg("max") ? Number(arg("max")) : undefined;

  console.log("refcentral live ingest");
  console.log(`  polling every ${interval}s${maxMinutes ? `, max ${maxMinutes} min` : ""}`);
  console.log("  exits when no Premier League match is in play\n");

  try {
    const s = await runLive({ interval, maxMinutes });
    console.log(`\n=== finished ===`);
    console.log(`  polls              ${s.polls}`);
    console.log(`  fixtures tracked   ${s.fixturesTracked}`);
    console.log(`  decisions written  ${s.decisionsWritten}`);
    console.log(`  held for VAR       ${s.pendingVar}`);
    if (s.warnings.length) {
      console.log(`\n  ${s.warnings.length} warning(s):`);
      for (const w of [...new Set(s.warnings)].slice(0, 10)) console.log(`    - ${w}`);
    }
  } catch (e) {
    console.error(`\nlive ingest failed: ${e}`);
    process.exit(1);
  }
})();
