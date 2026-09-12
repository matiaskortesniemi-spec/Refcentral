-- refcentral — 0005 live rating
--
-- Two changes so a match can be rated while it is still being played.
--
-- 1. decision.rateable_from
--
--    A penalty given at 28' and overturned at 30' are one refereeing event,
--    and the rules fold them into a single decision. Publishing instantly
--    means someone can rate a call that is about to be reversed, leaving
--    their rating attached to a decision that no longer exists in that form.
--
--    So VAR-touchable decisions are shown immediately but held from rating
--    for a few minutes. Everything else is rateable the moment it appears.
--    The gate is per-decision rather than per-fixture, because a yellow card
--    has nothing to wait for.
--
-- 2. The rating policy now checks it.
--
--    Enforced in the database rather than the UI, for the same reason as
--    every other window check: the client is not the security boundary.

alter table decision
  add column if not exists rateable_from timestamptz;

comment on column decision.rateable_from is
  'When this decision becomes rateable. Null means immediately. Used to hold '
  'VAR-touchable calls for a short settling period during live matches.';

create index if not exists decision_rateable_idx
  on decision (fixture_id, rateable_from);

-- Replace the rating insert policy so it also respects the settling period.
drop policy if exists "rate while open" on rating;

create policy "rate while open" on rating
  for insert with check (
    auth.uid() = user_id
    and exists (
      select 1 from fixture f
      where f.id = fixture_id
        and f.status = 'OPEN'
        and now() between f.rating_opens_at and f.rating_closes_at
    )
    and exists (
      select 1 from decision d
      where d.id = rating.decision_id
        and (d.rateable_from is null or now() >= d.rateable_from)
    )
    and exists (
      select 1 from allegiance a
      where a.user_id = auth.uid() and a.fixture_id = rating.fixture_id
    )
    and not exists (
      select 1 from app_user u where u.id = auth.uid() and u.suspended_at is not null
    )
  );
