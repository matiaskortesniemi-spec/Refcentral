-- refcentral — 0003 allegiance and profile functions
--
-- The problem this solves:
--
-- The allegiance row carries two values. `declared` is what the user clicked.
-- `effective` is what the weighting actually uses, after checking it against
-- their registered club. If the browser writes both, a user simply declares
-- NEUTRAL on their own club's match and keeps full 1.0 weight — and the
-- entire allegiance system is decorative.
--
-- So the client never writes to `allegiance` at all. It calls
-- declare_allegiance(), which runs SECURITY DEFINER, reads the favourite team
-- from the database rather than from the request, computes `effective`
-- itself, and records the override.
--
-- Same reasoning for set_favourite_team(): the seasonal change limit is only
-- a limit if the client can't edit the counter.

-- ===========================================================================
-- Allegiance
-- ===========================================================================

create or replace function declare_allegiance(
  p_fixture_id bigint,
  p_declared   text
)
returns allegiance
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user      uuid := auth.uid();
  v_fav       bigint;
  v_home      bigint;
  v_away      bigint;
  v_own       text;
  v_effective text;
  v_rule      text;
  v_row       allegiance;
begin
  if v_user is null then
    raise exception 'not signed in';
  end if;

  if p_declared not in ('HOME','AWAY','NEUTRAL') then
    raise exception 'declaration must be HOME, AWAY or NEUTRAL';
  end if;

  if exists (select 1 from app_user where id = v_user and suspended_at is not null) then
    raise exception 'account suspended';
  end if;

  -- The window check lives here as well as in the RLS policy, because this
  -- function bypasses RLS.
  select home_team_id, away_team_id
    into v_home, v_away
  from fixture
  where id = p_fixture_id
    and status = 'OPEN'
    and now() between rating_opens_at and rating_closes_at;

  if not found then
    raise exception 'rating is not open for this fixture';
  end if;

  select favourite_team_id into v_fav from app_user where id = v_user;

  v_effective := p_declared;
  v_rule := null;

  if v_fav is not null then
    if v_fav = v_home then
      v_own := 'HOME';
    elsif v_fav = v_away then
      v_own := 'AWAY';
    end if;

    -- Declaring anything other than your own club, when your own club is
    -- playing, does not work. The effective allegiance is your club.
    if v_own is not null and p_declared <> v_own then
      v_effective := v_own;
      v_rule := case
        when p_declared = 'NEUTRAL' then 'DECLARED_NEUTRAL_ON_OWN_CLUB'
        else 'DECLARED_OPPOSITE_OF_OWN_CLUB'
      end;

      -- One override is noise. A pattern is not. Counted here, acted on
      -- elsewhere — nothing is deleted and nobody is banned for this.
      update app_user
        set integrity_flags = integrity_flags + 1
      where id = v_user;
    end if;
  end if;

  insert into allegiance (user_id, fixture_id, declared, effective, override_rule)
  values (v_user, p_fixture_id, p_declared, v_effective, v_rule)
  on conflict (user_id, fixture_id) do update
    set declared      = excluded.declared,
        effective     = excluded.effective,
        override_rule = excluded.override_rule,
        declared_at   = now()
  returning * into v_row;

  return v_row;
end;
$$;

-- The client may call the function and read its own row. It may not write
-- the table directly — that is the whole point of the function existing.
revoke insert, update, delete on allegiance from authenticated;
grant execute on function declare_allegiance(bigint, text) to authenticated;

drop policy if exists "declare while open" on allegiance;
drop policy if exists "amend while open" on allegiance;

-- ===========================================================================
-- Favourite team
-- ===========================================================================

create or replace function set_favourite_team(p_team_id bigint)
returns app_user
language plpgsql
security definer
set search_path = public
as $$
declare
  v_user    uuid := auth.uid();
  v_current bigint;
  v_changes integer;
  v_row     app_user;
begin
  if v_user is null then
    raise exception 'not signed in';
  end if;

  if p_team_id is not null and not exists (select 1 from team where id = p_team_id) then
    raise exception 'unknown team';
  end if;

  select favourite_team_id, favourite_changes
    into v_current, v_changes
  from app_user where id = v_user;

  if v_current is not distinct from p_team_id then
    select * into v_row from app_user where id = v_user;
    return v_row;
  end if;

  -- Switching clubs more often than this is gaming the 0.4 weight rather
  -- than changing your mind.
  if v_current is not null and v_changes >= 2 then
    raise exception 'favourite team can only be changed twice per season';
  end if;

  update app_user
     set favourite_team_id = p_team_id,
         favourite_set_at  = now(),
         favourite_changes = case when v_current is null then favourite_changes
                                  else favourite_changes + 1 end
   where id = v_user
  returning * into v_row;

  -- Past allegiances are never rewritten. A rating submitted as a declared
  -- neutral stays weighted as one; otherwise a user could rate a hundred
  -- matches, then switch clubs, and retroactively reweight all of them.
  return v_row;
end;
$$;

revoke update on app_user from authenticated;
grant execute on function set_favourite_team(bigint) to authenticated;

-- ===========================================================================
-- Reading your own allegiance
-- ===========================================================================
-- The select policy from 0002 still applies; only the write paths moved.
