"use client";

/**
 * refcentral — referee profile
 *
 * The page leads with where opinion divided, not with a verdict.
 *
 * A single career number invites the reading "this referee is a 3.1, which is
 * bad". The category breakdown invites a better one: penalties split the room
 * by 0.78 while game management split it by 0.09, so the disagreement is
 * about a specific kind of call rather than about the official. That is the
 * difference between analysis and a scoreboard of blame, and it is why the
 * category bars sit above the match list rather than below it.
 *
 * Career figures are shown three ways because they measure different things,
 * and hiding the disagreement between them would be a claim to more certainty
 * than the data supports.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { use } from "react";
import {
  refereeProfile, refereeMatches, RefereeProfile, RefereeMatch,
} from "@/lib/queries/read";

const CATEGORY_LABEL: Record<string, string> = {
  PENALTIES: "Penalty decisions",
  DISCIPLINE: "Cards and discipline",
  VAR: "VAR involvement",
  GAME_MANAGEMENT: "Game management",
  OTHER: "Crowd-flagged incidents",
};

export default function RefereePage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = use(params);
  const [profile, setProfile] = useState<RefereeProfile | null>(null);
  const [matches, setMatches] = useState<RefereeMatch[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);

  useEffect(() => {
    Promise.all([refereeProfile(id), refereeMatches(id)])
      .then(([p, m]) => {
        setProfile(p);
        setMatches(m);
        setLoaded(true);
      })
      .catch((e) => setError(String(e.message ?? e)));
  }, [id]);

  const scored = matches.filter((m) => m.score != null);

  return (
    <>
      <header>
        <div className="wrap bar">
          <Link href="/" className="mark" style={{ textDecoration: "none" }}>
            <span className="whistle" />
            refcentral
          </Link>
          <Link href="/referees" className="navbtn">
            All referees
          </Link>
        </div>
      </header>

      <main className="wrap">
        {error && (
          <div className="state">
            <h2>Couldn&apos;t load this referee</h2>
            <p>{error}</p>
          </div>
        )}

        {!error && !loaded && (
          <div className="state">
            <h2>Loading…</h2>
          </div>
        )}

        {loaded && !profile && (
          <div className="state">
            <h2>Not found</h2>
            <p>No referee with that id.</p>
          </div>
        )}

        {profile && (
          <>
            <div className="page-head">
              <h1 className="page-title">{profile.name}</h1>
              <p className="lede">
                {profile.country ? `${profile.country} · ` : ""}
                {profile.matches || matches.length} match
                {(profile.matches || matches.length) === 1 ? "" : "es"} on file
                {scored.length < matches.length && (
                  <>
                    {" "}
                    · {scored.length} rated so far
                  </>
                )}
              </p>
            </div>

            {profile.career == null ? (
              <div className="state">
                <h2>Not enough ratings yet</h2>
                <p>
                  Decisions from {matches.length} match
                  {matches.length === 1 ? " are" : "es are"} logged, but nothing has been rated
                  and scored. Career figures appear once the scoring job has something to work
                  with.
                </p>
              </div>
            ) : (
              <>
                <div className="career-row">
                  <div className="career-main">
                    <span className="n">{profile.career.toFixed(2)}</span>
                    <span className="lbl">career score / 5.00</span>
                    <p className="explain">
                      Pulled toward the referee-population average until enough matches accumulate
                      to earn its own position. With a small sample it stays close to the middle
                      on purpose.
                    </p>
                  </div>
                  <div className="career-side">
                    <div>
                      <b>{profile.careerRaw != null ? profile.careerRaw.toFixed(2) : "—"}</b>
                      <span>unadjusted mean of match scores</span>
                    </div>
                    <div>
                      <b>{profile.neutral != null ? profile.neutral.toFixed(2) : "—"}</b>
                      <span>from raters with no stake</span>
                    </div>
                    <div>
                      <b>{profile.partisan != null ? profile.partisan.toFixed(2) : "—"}</b>
                      <span>from supporters of either club</span>
                    </div>
                    <div>
                      <b>
                        {profile.form != null
                          ? `${profile.form >= 0 ? "+" : ""}${profile.form.toFixed(2)}`
                          : "—"}
                      </b>
                      <span>last 10 against career</span>
                    </div>
                  </div>
                </div>

                {profile.categories.length > 0 && (
                  <section className="cats">
                    <h2 className="sec-title">Where opinion divided</h2>
                    <p className="sec-lede">
                      The same raters, on the same matches, split differently depending on the
                      kind of call. A wide gap means the decision was contested, not that it was
                      wrong.
                    </p>

                    {[...profile.categories]
                      .sort((a, b) => (b.divergence ?? 0) - (a.divergence ?? 0))
                      .map((c) => (
                        <div className="bar-row" key={c.category}>
                          <div className="bar-label">
                            <span>{CATEGORY_LABEL[c.category] ?? c.category}</span>
                            <b>{c.score.toFixed(2)}</b>
                          </div>
                          <div className="track-bar">
                            <div
                              className={`fill ${
                                (c.divergence ?? 0) > 0.5 ? "d" : "n"
                              }`}
                              style={{ width: `${Math.max(0, Math.min(100, (c.score / 5) * 100))}%` }}
                            />
                          </div>
                          <div className="catmeta">
                            <span>
                              <i className="dot n" />
                              neutrals {c.neutral != null ? c.neutral.toFixed(2) : "—"}
                            </span>
                            <span>
                              <i className="dot p" />
                              supporters {c.partisan != null ? c.partisan.toFixed(2) : "—"}
                            </span>
                            <span className={(c.divergence ?? 0) > 0.5 ? "gap" : ""}>
                              {c.divergence != null ? `${c.divergence.toFixed(2)} apart` : ""}
                            </span>
                            <span className="dim">
                              {c.decisions} decision{c.decisions === 1 ? "" : "s"}
                            </span>
                          </div>
                        </div>
                      ))}
                  </section>
                )}
              </>
            )}

            <section className="cats">
              <h2 className="sec-title">Matches</h2>
              <table className="reftable">
                <thead>
                  <tr>
                    <th>Match</th>
                    <th className="num">Decisions</th>
                    <th className="num">Score</th>
                    <th className="num">Neutrals</th>
                    <th className="num">Supporters</th>
                  </tr>
                </thead>
                <tbody>
                  {matches.map((m) => (
                    <tr key={m.fixtureId}>
                      <td>
                        {m.home} {m.ftHome ?? "–"}–{m.ftAway ?? "–"} {m.away}
                        <span className="country">
                          {" "}
                          ·{" "}
                          {new Date(m.kickoff).toLocaleDateString("en-GB", {
                            day: "numeric",
                            month: "short",
                            year: "numeric",
                          })}
                        </span>
                      </td>
                      <td className="num" data-label="Decisions">{m.decisionCount}</td>
                      <td className="num strong" data-label="Score">
                        {m.score != null ? m.score.toFixed(2) : "—"}
                      </td>
                      <td className="num" data-label="Neutrals">
                        {m.neutralScore != null ? m.neutralScore.toFixed(2) : "—"}
                      </td>
                      <td className="num" data-label="Supporters">
                        {m.partisanScore != null ? m.partisanScore.toFixed(2) : "—"}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </section>
          </>
        )}
      </main>

      <footer className="wrap">
        <p>
          Scores are built from individual decisions, weighted by how much each call affected the
          match, and reported separately for raters with and without a stake in the result.
        </p>
        <p>Built in Helsinki.</p>
      </footer>
    </>
  );
}
