/**
 * refcentral — API-Football deep sample (v3)
 *
 * v2 established that the plan works and the season cap is 2024. It then died
 * on the per-minute rate limit because I paced calls at 250ms — four a second
 * against a limit of roughly ten a minute.
 *
 * v3 changes approach. Rather than sampling six leagues shallowly, it samples
 * ONE league deeply, because the two open questions both need volume:
 *
 *   - VAR detail strings. These are what the classifier keys on, and VAR
 *     events are sparse. Four fixtures found none; twenty-five should.
 *   - Referee name shapes. v2 returned "D. Bond", "R. Jones", "T. Robinson" —
 *     initial form, no country. Worth confirming across a wider sample,
 *     because it determines how hard the identity problem actually is.
 *
 * Every call goes through one throttle. 429s are retried with backoff rather
 * than throwing, and the run reports its quota use at the end.
 *
 * Usage:
 *   export AF_KEY=...
 *   npx tsx smoketest3.ts
 *
 *   LEAGUE=135 npx tsx smoketest3.ts     # Serie A instead
 *   SAMPLE=40  npx tsx smoketest3.ts     # more fixtures
 *   RPM=30     npx tsx smoketest3.ts     # after upgrading to Pro
 */

const AF_KEY = process.env.AF_KEY;
const AF = "https://v3.football.api-sports.io";

const LEAGUE = Number(process.env.LEAGUE ?? 39);          // 39 = Premier League
const SEASON = Number(process.env.SEASON ?? 2024);        // free plan reaches 2022-2024
const SAMPLE = Number(process.env.SAMPLE ?? 25);
/** Free plan is about 10/min. Default below it, raise after upgrading. */
const RPM = Number(process.env.RPM ?? 8);

const LEAGUE_NAMES: Record<number, string> = {
  39: "Premier League", 140: "La Liga", 135: "Serie A",
  78: "Bundesliga", 61: "Ligue 1", 2: "Champions League",
};

const ok = (s: string) => console.log(`  \u2713 ${s}`);
const bad = (s: string) => console.log(`  \u2717 ${s}`);
const info = (s: string) => console.log(`    ${s}`);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// Throttle — one queue, every call goes through it
// ---------------------------------------------------------------------------

const GAP_MS = Math.ceil(60_000 / RPM);
let chain: Promise<unknown> = Promise.resolve();
let callCount = 0;

function schedule<T>(fn: () => Promise<T>): Promise<T> {
  const run = chain.then(async () => {
    const started = Date.now();
    try {
      return await fn();
    } finally {
      const elapsed = Date.now() - started;
      if (elapsed < GAP_MS) await sleep(GAP_MS - elapsed);
    }
  });
  chain = run.catch(() => undefined);
  return run as Promise<T>;
}

interface Envelope<T> {
  get: string;
  parameters: unknown;
  errors: unknown;
  results: number;
  response: T;
}

function errorsOf(env: Envelope<unknown>): string[] {
  const e = env.errors;
  if (!e) return [];
  if (Array.isArray(e)) return e.map(String);
  if (typeof e === "object") {
    return Object.entries(e as Record<string, unknown>).map(([k, v]) => `${k}: ${v}`);
  }
  return [String(e)];
}

/** Retries a 429 up to three times with growing backoff instead of throwing. */
async function af<T>(path: string, attempt = 0): Promise<Envelope<T>> {
  const env = await schedule(async () => {
    callCount++;
    const res = await fetch(`${AF}${path}`, { headers: { "x-apisports-key": AF_KEY! } });
    const body = (await res.json()) as Envelope<T>;
    return { status: res.status, body };
  });

  const rateLimited =
    env.status === 429 ||
    errorsOf(env.body).some((e) => e.toLowerCase().includes("ratelimit"));

  if (rateLimited) {
    if (attempt >= 3) {
      throw new Error(`rate limited four times on ${path} — lower RPM and retry`);
    }
    const wait = (attempt + 1) * 20_000;
    info(`rate limited, waiting ${wait / 1000}s then retrying (attempt ${attempt + 2})`);
    await sleep(wait);
    return af<T>(path, attempt + 1);
  }

  if (env.status !== 200) {
    throw new Error(`HTTP ${env.status} on ${path} :: ${JSON.stringify(env.body).slice(0, 200)}`);
  }
  return env.body;
}

/** Spreads n picks evenly across a list rather than taking a contiguous run. */
function spread<T>(items: T[], n: number): T[] {
  if (items.length <= n) return items;
  const step = items.length / n;
  const out: T[] = [];
  for (let i = 0; i < n; i++) out.push(items[Math.floor(i * step)]);
  return out;
}

// ---------------------------------------------------------------------------

(async () => {
  if (!AF_KEY) {
    bad("AF_KEY not set. Run: export AF_KEY=your_key");
    process.exit(1);
  }

  const leagueName = LEAGUE_NAMES[LEAGUE] ?? `league ${LEAGUE}`;
  console.log(`refcentral deep sample — ${leagueName} ${SEASON}`);
  console.log(`sampling ${SAMPLE} fixtures at ${RPM} requests/min (~${Math.ceil(((SAMPLE + 2) * GAP_MS) / 60000)} min)\n`);

  const before = await af<any>("/status");
  info(`quota before: ${before.response?.requests?.current} / ${before.response?.requests?.limit_day}`);

  // -------------------------------------------------------------------------
  console.log("\n=== Fixtures ===");
  const fxEnv = await af<any[]>(`/fixtures?league=${LEAGUE}&season=${SEASON}&status=FT`);
  const fxErrs = errorsOf(fxEnv);
  if (fxErrs.length) {
    bad(fxErrs.join("; "));
    process.exit(1);
  }
  const fixtures = fxEnv.response ?? [];
  ok(`${fixtures.length} finished fixtures`);

  const sample = spread(fixtures, SAMPLE);
  info(`sampling ${sample.length}, spread across the whole season`);

  // -------------------------------------------------------------------------
  const refereeSamples: string[] = [];
  const eventTypes = new Map<string, number>();
  const varDetails = new Map<string, number>();
  const cardDetails = new Map<string, number>();
  const goalDetails = new Map<string, number>();
  let withVar = 0;

  console.log("\n=== Sampling events ===");
  for (let i = 0; i < sample.length; i++) {
    const f = sample[i];
    if (f.fixture?.referee) refereeSamples.push(f.fixture.referee);

    try {
      const ev = await af<any[]>(`/fixtures/events?fixture=${f.fixture.id}`);
      const errs = errorsOf(ev);
      if (errs.length) {
        bad(`fixture ${f.fixture.id}: ${errs.join("; ")}`);
        continue;
      }
      let varsHere = 0;
      for (const e of ev.response ?? []) {
        const t = String(e.type);
        eventTypes.set(t, (eventTypes.get(t) ?? 0) + 1);
        const lower = t.toLowerCase();
        if (lower === "var") {
          varsHere++;
          varDetails.set(e.detail, (varDetails.get(e.detail) ?? 0) + 1);
        } else if (lower === "card") {
          cardDetails.set(e.detail, (cardDetails.get(e.detail) ?? 0) + 1);
        } else if (lower === "goal") {
          goalDetails.set(e.detail, (goalDetails.get(e.detail) ?? 0) + 1);
        }
      }
      if (varsHere > 0) withVar++;
      process.stdout.write(
        `\r    ${i + 1}/${sample.length} fixtures · ${varDetails.size} distinct VAR strings · ${withVar} fixtures with VAR   `
      );
    } catch (e) {
      console.log(`\n`);
      bad(`fixture ${f.fixture.id}: ${e}`);
    }
  }
  console.log("\n");

  // -------------------------------------------------------------------------
  console.log("=== Event types ===");
  for (const [t, n] of [...eventTypes].sort((a, b) => b[1] - a[1])) info(`${t.padEnd(10)} x${n}`);

  console.log("\n=== VAR detail strings — THESE GO INTO THE CLASSIFIER ===");
  if (varDetails.size === 0) {
    bad(`no VAR events in ${sample.length} fixtures`);
    info("either this season predates VAR coverage, or the sample is still too small");
  } else {
    info(`${withVar} of ${sample.length} fixtures had at least one VAR event`);
    for (const [d, n] of [...varDetails].sort((a, b) => b[1] - a[1])) info(`"${d}"  x${n}`);
  }

  console.log("\n=== Card detail strings ===");
  for (const [d, n] of [...cardDetails].sort((a, b) => b[1] - a[1])) info(`"${d}"  x${n}`);

  console.log("\n=== Goal detail strings ===");
  for (const [d, n] of [...goalDetails].sort((a, b) => b[1] - a[1])) info(`"${d}"  x${n}`);

  // -------------------------------------------------------------------------
  console.log("\n=== Referee strings ===");
  const unique = [...new Set(refereeSamples)];
  if (unique.length === 0) {
    bad("none returned");
  } else {
    const withCountry = refereeSamples.filter((x) => x.includes(",")).length;
    const initialForm = refereeSamples.filter((x) => /^[A-Z]\.\s/.test(x)).length;
    const fullName = refereeSamples.filter((x) => /^[A-Za-z\u00C0-\u017F'-]{2,}\s/.test(x)).length;
    ok(`${refereeSamples.length} samples, ${unique.length} distinct`);
    info(`with ", Country" suffix : ${withCountry}/${refereeSamples.length}`);
    info(`initial form "X. Name"  : ${initialForm}/${refereeSamples.length}`);
    info(`full given name         : ${fullName}/${refereeSamples.length}`);
    console.log();
    for (const x of unique.sort()) info(`"${x}"`);
  }

  const after = await af<any>("/status");
  console.log(
    `\nquota after: ${after.response?.requests?.current} / ${after.response?.requests?.limit_day}  (${callCount} calls this run)`
  );
})();
