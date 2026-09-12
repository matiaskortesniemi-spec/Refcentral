-- refcentral — 0004 matchweek number on fixtures
--
-- The rating window already encodes which matchweek is current: a fixture is
-- rateable until the next round kicks off. That is enough to *select* the
-- right matches, but not to *name* them, and "Matchweek 4" is what a reader
-- recognises.
--
-- Storing the round also makes the grouping explicit rather than inferred
-- from timestamps, which matters when a fixture is postponed and played out
-- of sequence — it belongs to its original matchweek regardless of when it
-- was eventually played.

alter table fixture add column if not exists round smallint;

create index if not exists fixture_round_idx
  on fixture (competition_code, season, round);

comment on column fixture.round is
  'Matchweek number parsed from the provider round string. Null when the '
  'provider gave a round we could not parse (cup rounds, play-offs).';
