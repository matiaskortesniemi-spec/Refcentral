"use client";

/**
 * refcentral — home
 *
 * Reads real fixtures and decisions through the anon key, so everything here
 * is subject to RLS. A fixture with a quarantined referee is invisible
 * because the policy hides it, not because this file filters it.
 *
 * Framing, per the product's purpose of analysing calls rather than attacking
 * officials:
 *
 *   - the decision is the unit. A referee's name is context for a set of
 *     calls, never a headline with a verdict attached.
 *   - every tier prints its reasoning. "Raised to tier 3: shown in the 90'
 *     with one goal in it" is a checkable fact about the match, and showing
 *     it is what separates analysis from a scoreboard of blame.
 *   - no leaderboard, and no ranking of referees against one another.
 */

import { useCallback, useEffect, useRef, useState } from "react";
import {
  recentFixtures, decisionsForFixture, FixtureSummary, DecisionRow,
} from "@/lib/queries/read";
import { useSession, loadProfile, Profile } from "@/lib/supabase/auth";
import { myRatings, allTeams, TeamOption, AllegianceRow } from "@/lib/queries/write";
import {
  SignIn, AccountBar, FavouritePicker, AllegiancePicker, RatingSlider,
} from "./rating";
import Link from "next/link";

const TIER_LABEL: Record<number, string> = {
  5: "Match-changing",
  3: "Significant",
  2: "Blended in",
  1: "Routine",
};

export default function Home() {
  const [fixtures, setFixtures] = useState<FixtureSummary[] | null>(null);
  const [decisions, setDecisions] = useState<Record<number, DecisionRow[]>>({});
  const [index, setIndex] = useState(0);
  const [error, setError] = useState<string | null>(null);

  const { session } = useSession();
  const [profile, setProfile] = useState<Profile | null>(null);
  const [teams, setTeams] = useState<TeamOption[]>([]);
  const [allegiances, setAllegiances] = useState<Record<number, AllegianceRow>>({});
  const [ratings, setRatings] = useState<Record<number, Record<string, number>>>({});
  const [profileNonce, setProfileNonce] = useState(0);

  const trackRef = useRef<HTMLDivElement>(null);
  const deckRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    recentFixtures(20)
      .then(setFixtures)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  // Prefetch the visible fixture and its neighbours, so swiping never lands
  // on an empty card while a query runs.
  useEffect(() => {
    if (!fixtures?.length) return;
    for (const i of [index, index + 1, index - 1]) {
      const f = fixtures[i];
      if (!f || decisions[f.id]) continue;
      decisionsForFixture(f.id)
        .then((d) => setDecisions((prev) => ({ ...prev, [f.id]: d })))
        .catch(() => undefined);
    }
  }, [fixtures, index, decisions]);

  useEffect(() => {
    if (!session) {
      setProfile(null);
      return;
    }
    loadProfile().then(setProfile).catch(() => undefined);
    allTeams().then(setTeams).catch(() => undefined);
  }, [session, profileNonce]);

  useEffect(() => {
    if (!session || !fixtures?.length) return;
    const f = fixtures[index];
    if (!f || ratings[f.id]) return;
    myRatings(f.id)
      .then((r) => setRatings((prev) => ({ ...prev, [f.id]: r })))
      .catch(() => undefined);
  }, [session, fixtures, index, ratings]);

  const goTo = useCallback(
    (i: number, instant = false) => {
      if (!fixtures?.length) return;
      const next = Math.max(0, Math.min(fixtures.length - 1, i));
      setIndex(next);
      const track = trackRef.current;
      if (!track) return;
      if (instant) track.classList.remove("animate");
      track.style.transform = `translateX(${-next * 100}%)`;
      if (instant) requestAnimationFrame(() => track.classList.add("animate"));
    },
    [fixtures]
  );

  useEffect(() => {
    const deck = deckRef.current;
    const track = trackRef.current;
    if (!deck || !track) return;

    let dragging = false;
    let startX = 0;
    let dx = 0;

    const down = (e: PointerEvent) => {
      // Dragging a slider must not swipe the card.
      if ((e.target as HTMLElement).closest("input[type=range]")) return;
      dragging = true;
      startX = e.clientX;
      dx = 0;
      track.classList.remove("animate");
    };
    const move = (e: PointerEvent) => {
      if (!dragging) return;
      dx = e.clientX - startX;
      track.style.transform = `translateX(calc(${-index * 100}% + ${dx}px))`;
    };
    const up = () => {
      if (!dragging) return;
      dragging = false;
      track.classList.add("animate");
      const threshold = Math.min(90, deck.offsetWidth * 0.18);
      if (dx < -threshold) goTo(index + 1);
      else if (dx > threshold) goTo(index - 1);
      else goTo(index);
    };

    deck.addEventListener("pointerdown", down);
    window.addEventListener("pointermove", move);
    window.addEventListener("pointerup", up);
    return () => {
      deck.removeEventListener("pointerdown", down);
      window.removeEventListener("pointermove", move);
      window.removeEventListener("pointerup", up);
    };
  }, [index, goTo]);

  const current = fixtures?.[index];
  const currentDecisions = current ? decisions[current.id] : undefined;

  return (
    <>
      <header>
        <div className="wrap bar">
          <div className="mark">
            <span className="whistle" />
            refcentral
          </div>
          <Link href="/referees" className="tagline">
            Referees
          </Link>
        </div>
      </header>

      <main className="wrap">
        <div className="hero">
          <div>
            <h1>Rate the calls, not the result.</h1>
            <p className="lede">
              Every Premier League match is broken into the decisions that actually shaped it.
              You rate each one on its own — <strong>not the referee as a whole</strong> — and
              each call carries a weight you can see the reasoning for.
            </p>
            <div className="tally">
              <div>
                <b>{fixtures?.length ?? "—"}</b>
                <span>matches loaded</span>
              </div>
              <div>
                <b>{fixtures?.reduce((a, f) => a + f.decisionCount, 0) ?? "—"}</b>
                <span>decisions logged</span>
              </div>
              <div>
                <b>{new Set(fixtures?.map((f) => f.refereeName).filter(Boolean)).size || "—"}</b>
                <span>referees covered</span>
              </div>
            </div>
          </div>

          <div>
            {error && (
              <div className="state">
                <h2>Couldn&apos;t load matches</h2>
                <p>{error}</p>
                <p>
                  Check <code>NEXT_PUBLIC_SUPABASE_URL</code> and{" "}
                  <code>NEXT_PUBLIC_SUPABASE_ANON_KEY</code> in <code>.env.local</code>, then
                  restart the dev server.
                </p>
              </div>
            )}

            {!error && !fixtures && (
              <div className="state">
                <h2>Loading matches…</h2>
              </div>
            )}

            {!error && fixtures?.length === 0 && (
              <div className="state">
                <h2>No matches yet</h2>
                <p>The database is reachable but empty. Pull a matchday in:</p>
                <p>
                  <code>npm run ingest -- --from 2024-08-16 --to 2024-08-19 --season 2024</code>
                </p>
              </div>
            )}

            {!error && fixtures && fixtures.length > 0 && (
              <>
                {!session && <SignIn />}
                {session && (
                  <>
                    <AccountBar email={session.user.email ?? ""} profile={profile} />
                    <FavouritePicker
                      teams={teams}
                      profile={profile}
                      onChange={() => setProfileNonce((n) => n + 1)}
                    />
                  </>
                )}

                <div className="deck-head">
                  <div className="deck-title">
                    Rating now in <b>the Premier League</b> · {index + 1} of {fixtures.length}
                  </div>
                  <div className="arrows">
                    <button
                      className="arrow"
                      onClick={() => goTo(index - 1)}
                      disabled={index === 0}
                      aria-label="Previous match"
                    >
                      ‹
                    </button>
                    <button
                      className="arrow"
                      onClick={() => goTo(index + 1)}
                      disabled={index === fixtures.length - 1}
                      aria-label="Next match"
                    >
                      ›
                    </button>
                  </div>
                </div>

                <div
                  className="deck"
                  ref={deckRef}
                  tabIndex={0}
                  onKeyDown={(e) => {
                    if ((e.target as HTMLElement).tagName === "INPUT") return;
                    if (e.key === "ArrowRight") goTo(index + 1);
                    if (e.key === "ArrowLeft") goTo(index - 1);
                  }}
                >
                  <div className="track animate" ref={trackRef}>
                    {fixtures.map((f) => (
                      <FixtureSlide
                        key={f.id}
                        fixture={f}
                        decisions={decisions[f.id]}
                        userId={session?.user.id ?? null}
                        allegiance={allegiances[f.id]}
                        ratings={ratings[f.id] ?? {}}
                        onDeclared={(row) =>
                          setAllegiances((prev) => ({ ...prev, [f.id]: row }))
                        }
                      />
                    ))}
                  </div>
                </div>

                <div className="dots">
                  {fixtures.map((f, i) => (
                    <button
                      key={f.id}
                      className="pdot"
                      aria-current={i === index}
                      aria-label={`Match ${i + 1}`}
                      onClick={() => goTo(i)}
                    />
                  ))}
                </div>
                <p className="swipe-hint">Swipe or drag the card to move between matches</p>

                {current && (
                  <div className="refcard">
                    <div className="rc-top">
                      <div>
                        <p className="rc-name">
                          {current.refereeId ? (
                            <Link href={`/referees/${current.refereeId}`} className="reflink">
                              {current.refereeName ?? "Referee unconfirmed"}
                            </Link>
                          ) : (
                            current.refereeName ?? "Referee unconfirmed"
                          )}
                        </p>
                        <p className="rc-meta">
                          {current.home} v {current.away} ·{" "}
                          {new Date(current.kickoff).toLocaleDateString("en-GB", {
                            day: "numeric",
                            month: "long",
                            year: "numeric",
                          })}
                        </p>
                      </div>
                      <div className="rc-score">
                        <span className="n">
                          {current.matchScore != null ? current.matchScore.toFixed(2) : "—"}
                        </span>
                        <span>match score / 5.00</span>
                      </div>
                    </div>
                    <div className="rc-stats">
                      <div>
                        <b>{current.decisionCount}</b>
                        <span>decisions in this match</span>
                      </div>
                      <div>
                        <b>{currentDecisions?.filter((d) => d.tier === 5).length ?? "—"}</b>
                        <span>match-changing calls</span>
                      </div>
                      <div>
                        <b>{currentDecisions?.filter((d) => d.varNote).length ?? "—"}</b>
                        <span>involving VAR</span>
                      </div>
                      <div>
                        <b>{current.status}</b>
                        <span>rating window</span>
                      </div>
                    </div>
                  </div>
                )}
              </>
            )}
          </div>
        </div>
      </main>

      <footer className="wrap">
        <p>
          refcentral analyses refereeing decisions. Weightings are derived from what happened in
          the match — the scoreline at the time, whether a player was already booked — and the
          reasoning is shown on every call.
        </p>
        <p>Built in Helsinki.</p>
      </footer>
    </>
  );
}

function FixtureSlide({
  fixture,
  decisions,
  userId,
  allegiance,
  ratings,
  onDeclared,
}: {
  fixture: FixtureSummary;
  decisions?: DecisionRow[];
  userId: string | null;
  allegiance?: AllegianceRow;
  ratings: Record<string, number>;
  onDeclared: (row: AllegianceRow) => void;
}) {
  const tierClass = (t: number) => (t === 5 ? "t5" : t === 3 ? "t3" : "");
  const canRate = Boolean(userId && allegiance);

  return (
    <div className="slide">
      <div className="fixture">
        <div className="comp">
          Premier League ·{" "}
          {new Date(fixture.kickoff).toLocaleDateString("en-GB", {
            weekday: "long",
            day: "numeric",
            month: "long",
          })}
        </div>
        <div className="teams">
          {fixture.home}
          <span className="score">
            {fixture.ftHome ?? "–"}–{fixture.ftAway ?? "–"}
          </span>
          {fixture.away}
        </div>
        <div className="ref-line">
          Referee: {fixture.refereeName ?? "unconfirmed"} · {fixture.decisionCount} decisions
          logged
        </div>
      </div>

      {userId && (
        <AllegiancePicker
          fixtureId={fixture.id}
          home={fixture.home}
          away={fixture.away}
          suggested="NEUTRAL"
          onDeclared={onDeclared}
        />
      )}

      <div className="decisions">
        {!decisions && <div className="dec">Loading decisions…</div>}
        {decisions?.map((d) => (
          <div className="dec" key={d.id}>
            <div className="dec-head">
              <span className="minute">{d.minute ? `${d.minute}'` : "—"}</span>
              <span className="dec-what">{d.label}</span>
              <span className={`tier ${tierClass(d.tier)}`}>{TIER_LABEL[d.tier] ?? d.tier}</span>
            </div>

            {d.tierReasons.length > 0 && (
              <div className="reasons">
                <ul>
                  {d.tierReasons.map((r, i) => (
                    <li key={i}>{r}</li>
                  ))}
                </ul>
              </div>
            )}

            {d.varNote && <div className="varnote">VAR: {d.varNote}</div>}

            {userId ? (
              <RatingSlider
                userId={userId}
                fixtureId={fixture.id}
                decisionId={d.id}
                initial={ratings[d.id]}
                disabled={!canRate}
              />
            ) : (
              <div className="unscored">Sign in to rate this decision.</div>
            )}
          </div>
        ))}
      </div>

      <div className="board">
        <div className="digits">
          {fixture.matchScore != null ? fixture.matchScore.toFixed(2) : "—"}
          <small>weighted match score</small>
        </div>
        <div className="math">
          {decisions?.map((d) => (
            <div className="row" key={d.id}>
              <span>
                {d.minute ? `${d.minute}'` : "overall"}{" "}
                <span style={{ color: "#5f665c" }}>×{d.tier}</span>
              </span>
              <b>{d.score != null ? d.score.toFixed(2) : "—"}</b>
            </div>
          ))}
          <div className="row" style={{ marginTop: 4 }}>
            <span>Scores publish with the next scoring run</span>
            <b>{fixture.status}</b>
          </div>
        </div>
      </div>
    </div>
  );
}
