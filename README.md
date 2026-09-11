# refcentral

Referee performance ratings, launching with the **Premier League**. Decisions
are rated individually, weighted by how much each call mattered and by whether
the rater had a stake in the result.

Currently the engine and the ingest pipeline. No frontend yet.

## Scope

One competition on purpose. The other five top-tier leagues and the Champions
League all work today — pass `--competitions SA,BL1` — but nothing runs them on
a schedule, for three reasons:

- **Vote density.** A tier-5 crowd incident needs a quorum of 400 weighted
  votes. Ten matches a week can reach that; fifty cannot.
- **Cross-league comparison is unsolved in practice.** The league-adjusted
  career score in `src/scoring/job.ts` exists to make a Serie A 3.4 comparable
  to a Bundesliga 3.4. It is a modelling choice, and launch should not depend
  on it being right.
- **Linking is least tested where it is hardest.** The cross-provider link rate
  measured 10/10 on a Premier League matchday. The Champions League, with team
  names in several languages, is where that degrades.

Widen by editing `DEFAULT_COMPETITIONS` in `lib/ingest/run.ts`.

## Setup

```bash
npm install
cp .env.example .env.local     # then fill it in
npm run typecheck
```

Supabase setup is in `supabase/SETUP.md`. Run the two migrations before
anything writes to the database.

## Scripts

| Command | What it does |
|---|---|
| `npm run typecheck` | Type-checks everything |
| `npm run smoke` | Probes the providers — quota, VAR strings, referee name shapes |
| `npm run ingest:dry` | Full ingest against real APIs, writes nothing |
| `npm run ingest` | Ingest for real, writes to Supabase |
| `npm run demo:rules` | Rule engine and referee identity against fixtures |
| `npm run demo:scoring` | Scoring job, including a synthetic brigade |

The two demos need no keys and no database. Good for checking nothing broke.

## Layout

```
src/                  the engine — no database, no network
  types.ts            normalized model + provider payload shapes
  rules.ts            event -> decision mapping, tiers, VAR folding
  normalize.ts        name parsing, Jaro-Winkler, surname-weighted compare
  referees.ts         identity resolution with alias learning + quarantine
  allegiance.ts       login + favourite team -> per-fixture weighting
  crowd.ts            proposal clustering and the >50% promotion rule
  adapters/           provider payload -> normalized model
  scoring/            the nightly batch: priors, trimming, shrinkage, brigades

lib/ingest/           the parts that touch the network and the database
  providers.ts        throttled API-Football and football-data clients
  store.ts            service-role Supabase client, referee store, team cache
  run.ts              the job itself

scripts/              CLI entry points
supabase/migrations/  0001 schema, 0002 row level security
.github/workflows/    the ingest cron
```

`src/` never imports from `lib/`. The engine is testable without a network or
a database, which is why the demos work with no configuration.

## Data sources

**API-Football** (Pro, $19/mo) for fixtures and events, including VAR from the
2020-21 season onward. Returns the referee as free text with no id.

**football-data.org** (free tier) for referee identity — a `referees[]` array
with stable integer ids.

Measured on a real Premier League matchday (2024-08-16 to 08-19, 10 fixtures):
every fixture linked across the two providers, and every referee resolved by
football-data id. No name matching, no quarantines. Link scores ranged from
0.904 to 1.000 against an accept threshold of 0.88.

That matters because API-Football returns referees as initials only —
`"M. Oliver"`, `"D. Bond"` — with no country. Resolving those by name alone
would be genuinely risky. The football-data id path makes the name matcher a
fallback rather than a dependency.

Neither is load-bearing. Both go through adapters into one `NormalizedMatch`;
swapping either means writing a new adapter and nothing else.

## Before launch

- Legal review. API-Football's terms grant no publishing licence and state
  that permission must be obtained from the competent authorities. A formal
  complaint from a league or federation lets them terminate access without
  refund. Publicly rating named officials is the open question, and it should
  be settled before the frontend is built, not after.
- `BURST_THRESHOLD`, `RAIL_THRESHOLD` and `MIN_NEUTRAL_SHARE` in
  `src/scoring/brigade.ts` are guesses until there is real traffic.
- No frontend, no auth flow, no crowd UI, no ops screens for the quarantine
  queue.
- With one competition, per-league priors will not reach `MIN_PRIOR_N` for a
  while. Expect `FALLBACK` in the scoring output early on — that is correct
  behaviour, not a bug.
