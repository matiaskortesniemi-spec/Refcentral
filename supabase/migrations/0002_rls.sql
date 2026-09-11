-- refcentral — 0002 row level security
--
-- On Supabase the anon key ships to the browser. Without RLS, anyone who
-- opens devtools can POST directly to the rating table and write whatever
-- they like, as many times as they like, for any user_id. Every weighting,
-- trimming and brigade-detection decision in this project assumes that isn't
-- possible. These policies are what make that assumption true.
--
-- Reading this file, the rule of thumb:
--   public read    reference data and PUBLISHED scores
--   own row only   anything a user wrote
--   service only   the scoring pipeline's output and ops tables
--
-- The service role key bypasses RLS entirely. It belongs in the ingest and
-- scoring jobs and NOWHERE the browser can reach it.

alter table competition          enable row level security;
alter table team                 enable row level security;
alter table referee              enable row level security;
alter table referee_alias        enable row level security;
alter table referee_quarantine   enable row level security;
alter table app_user             enable row level security;
alter table fixture              enable row level security;
alter table decision             enable row level security;
alter table allegiance           enable row level security;
alter table rating               enable row level security;
alter table crowd_proposal       enable row level security;
alter table crowd_cluster        enable row level security;
alter table controversy_vote     enable row level security;
alter table cluster_served       enable row level security;
alter table scored_decision      enable row level security;
alter table match_score          enable row level security;
alter table referee_aggregate    enable row level security;
alter table prior                enable row level security;
alter table score_alert          enable row level security;
alter table job_run              enable row level security;

-- ===========================================================================
-- Public read — reference data
-- ===========================================================================

create policy "public read" on competition   for select using (true);
create policy "public read" on team          for select using (true);
create policy "public read" on referee       for select using (true);
create policy "public read" on referee_alias for select using (true);

-- Fixtures and decisions are public, but only once they have actually opened.
-- A fixture still in INGESTED or BLOCKED is one where the referee is
-- quarantined or the decisions aren't final — showing it would publish a
-- provisional referee attribution.
create policy "public read opened" on fixture
  for select using (status in ('OPEN','CLOSED'));

create policy "public read opened" on decision
  for select using (
    exists (
      select 1 from fixture f
      where f.id = decision.fixture_id and f.status in ('OPEN','CLOSED')
    )
  );

-- ===========================================================================
-- Public read — published scores
-- ===========================================================================

create policy "public read" on scored_decision   for select using (true);
create policy "public read" on match_score       for select using (true);
create policy "public read" on referee_aggregate for select using (true);

-- ===========================================================================
-- Users — own row only
-- ===========================================================================

create policy "read own profile" on app_user
  for select using (auth.uid() = id);

-- Users may set a favourite team. They may NOT edit prior_ratings,
-- integrity_flags or suspended_at — those are the brigade detector's inputs,
-- and a user who can zero their own integrity_flags can lie about allegiance
-- forever. Column-level control comes from the grant below, not the policy.
create policy "update own profile" on app_user
  for update using (auth.uid() = id) with check (auth.uid() = id);

revoke update on app_user from authenticated;
grant update (favourite_team_id, favourite_set_at, favourite_changes)
  on app_user to authenticated;

-- ===========================================================================
-- Allegiance — own row, and only while rating is open
-- ===========================================================================

create policy "read own allegiance" on allegiance
  for select using (auth.uid() = user_id);

create policy "declare while open" on allegiance
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from fixture f
      where f.id = fixture_id
        and f.status = 'OPEN'
        and now() between f.rating_opens_at and f.rating_closes_at
    )
  );

-- Changing allegiance mid-window is allowed (people misclick) but the
-- effective value is recomputed server-side, never taken from the client.
create policy "amend while open" on allegiance
  for update using (
    auth.uid() = user_id
    and exists (
      select 1 from fixture f
      where f.id = fixture_id and f.status = 'OPEN' and now() < f.rating_closes_at
    )
  ) with check (auth.uid() = user_id);

-- ===========================================================================
-- Ratings — the important one
-- ===========================================================================

-- A user can read their own ratings and nobody else's. This is not privacy
-- theatre: if raw ratings were readable, the cooldown would be pointless
-- because anyone could poll the table and watch the totals move in real time,
-- and brigades could verify their push was landing. Aggregates live in
-- scored_decision, which is public.
create policy "read own ratings" on rating
  for select using (auth.uid() = user_id);

create policy "rate while open" on rating
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from fixture f
      where f.id = fixture_id
        and f.status = 'OPEN'
        and now() between f.rating_opens_at and f.rating_closes_at
    )
    -- Must have declared an allegiance first. Without this a user can rate
    -- with no declaration and land in whichever bucket the default puts them.
    and exists (
      select 1 from allegiance a
      where a.user_id = auth.uid() and a.fixture_id = rating.fixture_id
    )
    and not exists (
      select 1 from app_user u where u.id = auth.uid() and u.suspended_at is not null
    )
  );

create policy "amend while open" on rating
  for update using (
    auth.uid() = user_id
    and exists (
      select 1 from fixture f
      where f.id = fixture_id and f.status = 'OPEN' and now() < f.rating_closes_at
    )
  ) with check (auth.uid() = user_id);

-- No delete policy anywhere on rating: a user withdrawing a rating after the
-- window would silently reshape a published score. Account deletion cascades,
-- which is the GDPR path and a deliberate one.

-- ===========================================================================
-- Crowd
-- ===========================================================================

create policy "read own proposals" on crowd_proposal
  for select using (auth.uid() = user_id);

create policy "propose while open" on crowd_proposal
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from fixture f
      where f.id = fixture_id and f.status = 'OPEN' and now() < f.rating_closes_at
    )
  );

-- Only PROMOTED clusters are publicly readable. An unpromoted cluster must
-- never be linkable, or one fanbase can point at a specific cluster and vote
-- it through. Voting happens through a served queue, not a URL.
create policy "public read promoted" on crowd_cluster
  for select using (promoted = true);

create policy "read own votes" on controversy_vote
  for select using (auth.uid() = user_id);

-- A user may only vote on a cluster that was SERVED to them. This is the
-- database-level half of serve-don't-link.
create policy "vote on served clusters" on controversy_vote
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from cluster_served s
      where s.cluster_id = controversy_vote.cluster_id and s.user_id = auth.uid()
    )
  );

create policy "read own served" on cluster_served
  for select using (auth.uid() = user_id);

-- ===========================================================================
-- Service-role only
-- ===========================================================================
--
-- No policies at all on these, which with RLS enabled means no access for
-- anon or authenticated. The service role bypasses RLS and is the only way in.
--
--   referee_quarantine   ops queue
--   prior                scoring internals
--   score_alert          brigade alerts
--   job_run              cron observability
--
-- Writes to fixture, decision, scored_decision, match_score,
-- referee_aggregate and cluster_served are likewise service-role only: those
-- tables have SELECT policies above and no INSERT/UPDATE policies, so a
-- browser client can read them and nothing more.
