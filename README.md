# refcentral

Referee performance ratings for the top five European leagues and the
Champions League. Decisions are rated individually, weighted by how much each
call mattered and by whether the rater had a stake in the result.

Currently the engine and the ingest pipeline. No frontend yet.

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
with stable integer ids. Verified working on the free plan across five of six
competitions.

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
