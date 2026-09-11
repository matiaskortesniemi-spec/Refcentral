# refcentral — Supabase setup

Two migrations. Run them in order. `0002` is the one that matters for
security, and it is not optional.

## 1. Create the project

At supabase.com, new project. Two settings worth getting right now because
neither can be changed later without a migration:

- **Region: EU.** `eu-north-1` (Stockholm) or `eu-central-1` (Frankfurt).
  You're in Finland, your users will be European, and this makes the GDPR
  conversation considerably shorter than explaining a US data transfer.
- **Save the database password** somewhere real. Supabase shows it once.

## 2. Run the migrations

SQL Editor → New query → paste `0001_schema.sql` → Run. Then the same with
`0002_rls.sql`.

Expected result: 20 tables, all with RLS enabled.

Verify before moving on:

```sql
select tablename, rowsecurity
from pg_tables
where schemaname = 'public'
order by tablename;
```

Every row must show `rowsecurity = true`. If any is false, stop and fix it —
a table without RLS on Supabase is a table the public can write to.

## 3. Seed the competitions

```sql
insert into competition (code, name, af_league_id, fd_code) values
  ('PL',  'Premier League',    39, 'PL'),
  ('PD',  'La Liga',          140, 'PD'),
  ('SA',  'Serie A',          135, 'SA'),
  ('BL1', 'Bundesliga',        78, 'BL1'),
  ('FL1', 'Ligue 1',           61, 'FL1'),
  ('CL',  'Champions League',   2, 'CL');
```

Teams get populated by the ingest job, not by hand.

## 4. Auth

Authentication → Providers. Enable **Email** with "Confirm email" on, and
turn **off** "Enable email provider sign-ups with password" if the option is
there — you want magic links, not passwords. Optionally enable Google.

Authentication → URL Configuration: set Site URL to `http://localhost:3000`
for now, and add your Vercel URL when you have one.

Then confirm the signup trigger fires: create a test user via
Authentication → Users → Add user, and check a matching row appeared:

```sql
select id, created_at from app_user;
```

If that's empty, the trigger in `0001` didn't install and every signed-in
user will hit foreign key errors the first time they rate something.

## 5. Keys

Settings → API gives you three things:

| Key | Goes where | Notes |
|---|---|---|
| Project URL | `NEXT_PUBLIC_SUPABASE_URL` | public, fine in the browser |
| `anon` public key | `NEXT_PUBLIC_SUPABASE_ANON_KEY` | public, RLS is what protects you |
| `service_role` key | `SUPABASE_SERVICE_ROLE_KEY` | **bypasses RLS entirely** |

The service role key goes in the ingest and scoring jobs only. Never in a
`NEXT_PUBLIC_` variable, never in client code, never in a repo. It can read
and write every table regardless of policy — it is effectively the database
password.

## What the policies actually do

Worth understanding rather than trusting, since these are load-bearing:

**Ratings are private.** A user reads their own and nobody else's. Not
privacy theatre — if raw ratings were readable, the cooldown would be
meaningless because anyone could poll the table and watch totals move, and a
brigade could verify its push was landing. Aggregates live in
`scored_decision`, which is public.

**You can't rate without declaring.** The insert policy on `rating` requires
an `allegiance` row for that fixture to already exist. Otherwise a user could
rate with no declaration and fall into whichever bucket the default picks.

**You can't rate a closed fixture.** Insert and update both check
`status = 'OPEN'` and the time window, in the database. Not in the app, where
it could be bypassed by calling PostgREST directly.

**Users can't edit their own integrity flags.** `app_user` has a column-level
grant covering only the favourite-team fields. A user who could zero
`integrity_flags` could declare neutral on their own club's matches forever.

**Unpromoted clusters aren't readable.** Only `promoted = true` is public, and
`controversy_vote` inserts require a matching `cluster_served` row. That's the
database-level half of serve-don't-link — without it, someone posts a cluster
URL to a fan forum and the 50% threshold stops meaning anything.

**Ratings can't be deleted.** No delete policy exists. A user withdrawing a
rating after the window would silently reshape a published score. Account
deletion cascades, which is the GDPR path and a deliberate one.

## Note on validation

I checked these migrations structurally — balanced parens, even dollar-quote
blocks, all 20 tables RLS-enabled, and exactly the four intended tables left
service-role-only. I could not execute them, because there's no Postgres in
my sandbox. Run `0001` first and read the output before running `0002`; if
something fails it will be a missing extension or a naming collision, and
both are obvious from the error.
