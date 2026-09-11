-- refcentral — 0001 schema (Supabase / PostgreSQL)
--
-- Two things differ from the generic version:
--
--   1. app_user hangs off auth.users. Supabase Auth owns credentials,
--      sessions and magic links; we never store a password. The link is a
--      uuid foreign key, and a trigger creates the row on signup so there is
--      no window where a logged-in user has no profile.
--
--   2. Row Level Security is on for every table. This is not optional on
--      Supabase: the anon key ships to the browser, so without RLS anyone
--      who opens devtools can write ratings directly to the table and every
--      weighting decision in this project becomes decoration. Policies are
--      in 0002.

-- ===========================================================================
-- Reference data
-- ===========================================================================

create table competition (
  code              text primary key,
  name              text not null,
  af_league_id      integer unique,
  fd_code           text unique
);

create table team (
  id                bigserial primary key,
  name              text not null,
  short_name        text,
  af_team_id        integer unique,
  fd_team_id        integer unique
);

create table referee (
  id                text primary key,
  fd_person_id      integer unique,
  canonical_name    text not null,
  country           text,
  created_at        timestamptz not null default now()
);

create table referee_alias (
  alias             text primary key,
  referee_id        text not null references referee(id) on delete cascade,
  source            text not null check (source in ('API_FOOTBALL','FOOTBALL_DATA','MANUAL')),
  learned_at        timestamptz not null default now()
);
create index on referee_alias (referee_id);

create table referee_quarantine (
  id                bigserial primary key,
  raw_name          text not null,
  country           text,
  score             numeric(5,4) not null,
  rivals            jsonb not null default '[]',
  reason            text not null,
  af_fixture_id     integer,
  resolved_as       text references referee(id),
  resolved_at       timestamptz,
  created_at        timestamptz not null default now()
);
create index on referee_quarantine (resolved_at) where resolved_at is null;

-- ===========================================================================
-- Users
-- ===========================================================================

create table app_user (
  -- Same uuid as auth.users. One row per account, created by trigger.
  id                  uuid primary key references auth.users(id) on delete cascade,
  created_at          timestamptz not null default now(),

  -- Optional and skippable. Pre-sets the per-fixture declaration and catches
  -- users declaring neutral on their own club's match. Never a weight by
  -- itself — see lib/allegiance.ts.
  favourite_team_id   bigint references team(id),
  favourite_set_at    timestamptz,
  favourite_changes   integer not null default 0,

  -- Denormalised for the brigade detector; refreshed by the scoring job.
  prior_ratings       integer not null default 0,
  integrity_flags     integer not null default 0,
  suspended_at        timestamptz
);
create index on app_user (favourite_team_id);

-- Create the profile row the moment an account exists, so there is never a
-- signed-in user without one.
create function handle_new_user()
returns trigger
language plpgsql
security definer set search_path = public
as $$
begin
  insert into public.app_user (id) values (new.id)
  on conflict (id) do nothing;
  return new;
end;
$$;

create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function handle_new_user();

-- ===========================================================================
-- Fixtures and decisions
-- ===========================================================================

create type fixture_status as enum ('INGESTED','BLOCKED','OPEN','CLOSED');

create table fixture (
  id                bigserial primary key,
  af_fixture_id     integer unique not null,
  fd_match_id       integer unique,
  link_score        numeric(5,4),
  competition_code  text not null references competition(code),
  season            integer not null,
  kickoff           timestamptz not null,
  home_team_id      bigint not null references team(id),
  away_team_id      bigint not null references team(id),
  ft_home           smallint,
  ft_away           smallint,
  referee_id        text references referee(id),
  status            fixture_status not null default 'INGESTED',
  rating_opens_at   timestamptz,
  rating_closes_at  timestamptz,
  ingested_at       timestamptz not null default now()
);
create index on fixture (competition_code, kickoff desc);
create index on fixture (referee_id);
create index on fixture (status) where status in ('INGESTED','OPEN');

create type decision_type as enum (
  'PENALTY_AWARDED','PENALTY_MISSED','RED_CARD','SECOND_YELLOW','YELLOW_CARD',
  'VAR_OVERTURN','VAR_UPHELD','CROWD_INCIDENT','GAME_MANAGEMENT'
);

create table decision (
  id                text primary key,
  fixture_id        bigint not null references fixture(id) on delete cascade,
  type              decision_type not null,
  tier              smallint not null check (tier in (1,2,3,5)),
  minute            smallint not null,
  extra_time        smallint,
  favours           text not null check (favours in ('HOME','AWAY','NEUTRAL')),
  against           text not null check (against in ('HOME','AWAY','NEUTRAL')),
  player_name       text,
  team_id           bigint references team(id),
  label             text not null,
  rule_id           text not null,
  tier_reasons      jsonb not null default '[]',
  var_note          text,
  source            text not null check (source in ('AUTO','CROWD')),
  created_at        timestamptz not null default now()
);
create index on decision (fixture_id);

-- ===========================================================================
-- Allegiance and ratings
-- ===========================================================================

create table allegiance (
  user_id       uuid not null references app_user(id) on delete cascade,
  fixture_id    bigint not null references fixture(id) on delete cascade,
  declared      text not null check (declared  in ('HOME','AWAY','NEUTRAL')),
  effective     text not null check (effective in ('HOME','AWAY','NEUTRAL')),
  override_rule text,
  declared_at   timestamptz not null default now(),
  primary key (user_id, fixture_id)
);

create table rating (
  user_id       uuid not null references app_user(id) on delete cascade,
  decision_id   text not null references decision(id) on delete cascade,
  fixture_id    bigint not null references fixture(id) on delete cascade,
  value         numeric(2,1) not null check (value >= 0 and value <= 5),
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  -- The constraint the entire weighting scheme rests on.
  primary key (user_id, decision_id)
);
create index on rating (decision_id);
create index on rating (fixture_id, created_at);

-- ===========================================================================
-- Crowd-flagged incidents
-- ===========================================================================

create table crowd_proposal (
  id            bigserial primary key,
  fixture_id    bigint not null references fixture(id) on delete cascade,
  user_id       uuid not null references app_user(id) on delete cascade,
  minute        smallint not null,
  category      text not null,
  note          text not null check (length(note) <= 120),
  created_at    timestamptz not null default now(),
  unique (fixture_id, user_id, category, minute)
);

create table crowd_cluster (
  id              text primary key,
  fixture_id      bigint not null references fixture(id) on delete cascade,
  category        text not null,
  minute          smallint not null,
  proposer_count  integer not null,
  note            text not null,
  favours         text not null,
  against         text not null,
  promoted        boolean not null default false,
  promoted_at     timestamptz,
  decision_id     text references decision(id),
  created_at      timestamptz not null default now()
);
create index on crowd_cluster (fixture_id) where not promoted;

create table controversy_vote (
  cluster_id     text not null references crowd_cluster(id) on delete cascade,
  user_id        uuid not null references app_user(id) on delete cascade,
  controversial  boolean not null,
  created_at     timestamptz not null default now(),
  primary key (cluster_id, user_id)
);

-- Clusters are served, never linked. This table is what makes that
-- enforceable — see serveVotingQueue in lib/crowd.ts.
create table cluster_served (
  cluster_id  text not null references crowd_cluster(id) on delete cascade,
  user_id     uuid not null references app_user(id) on delete cascade,
  served_at   timestamptz not null default now(),
  primary key (cluster_id, user_id)
);

-- ===========================================================================
-- Scoring output — written only by the service role
-- ===========================================================================

create table scored_decision (
  decision_id     text primary key references decision(id) on delete cascade,
  fixture_id      bigint not null references fixture(id) on delete cascade,
  score           numeric(4,3) not null,
  raw_combined    numeric(4,3),
  effective_n     numeric(10,2) not null,
  prior_value     numeric(4,3) not null,
  prior_source    text not null,
  neutral_mean    numeric(4,3),
  partisan_mean   numeric(4,3),
  divergence      numeric(4,3),
  buckets         jsonb not null default '{}',
  flags           text[] not null default '{}',
  held            boolean not null default false,
  scored_at       timestamptz not null default now()
);
create index on scored_decision (fixture_id);

create table match_score (
  fixture_id        bigint primary key references fixture(id) on delete cascade,
  referee_id        text not null references referee(id),
  competition_code  text not null references competition(code),
  score             numeric(4,3) not null,
  neutral_score     numeric(4,3),
  partisan_score    numeric(4,3),
  decision_count    smallint not null,
  effective_n       numeric(10,2) not null,
  flags             text[] not null default '{}',
  held              boolean not null default false,
  scored_at         timestamptz not null default now()
);
create index on match_score (referee_id);

create table referee_aggregate (
  referee_id        text primary key references referee(id) on delete cascade,
  matches           integer not null,
  career            numeric(4,3) not null,
  career_raw        numeric(4,3) not null,
  career_adjusted   numeric(4,3) not null,
  neutral           numeric(4,3),
  partisan          numeric(4,3),
  form              numeric(4,3) not null,
  categories        jsonb not null default '[]',
  per_competition   jsonb not null default '[]',
  scored_at         timestamptz not null default now()
);

create table prior (
  scope         text not null,
  key           text not null,
  mean          numeric(4,3) not null,
  n             numeric(12,2) not null,
  computed_at   timestamptz not null default now(),
  primary key (scope, key)
);

create table score_alert (
  id            bigserial primary key,
  decision_id   text not null references decision(id) on delete cascade,
  flags         text[] not null,
  detail        jsonb not null default '[]',
  held          boolean not null,
  reviewed_at   timestamptz,
  created_at    timestamptz not null default now()
);
create index on score_alert (reviewed_at) where reviewed_at is null;

create table job_run (
  id            bigserial primary key,
  job           text not null,
  window_from   timestamptz,
  window_to     timestamptz,
  started_at    timestamptz not null default now(),
  finished_at   timestamptz,
  ok            boolean,
  stats         jsonb,
  error         text
);
create index on job_run (job, started_at desc);
