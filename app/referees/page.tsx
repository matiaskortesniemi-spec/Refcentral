"use client";

/**
 * refcentral — referee index
 *
 * Alphabetical, on purpose.
 *
 * Sorting this list by score would make it a leaderboard, and a leaderboard
 * of named officials is precisely the artefact this site exists not to
 * produce — it is the thing that turns analysis into a target list. The
 * ordering is the editorial position, so it is not a user preference.
 *
 * The column that earns its place is the divergence: how far neutrals and
 * supporters disagreed about the same referee. That is a fact about the
 * audience as much as the official, and it is the most genuinely interesting
 * number the site can produce.
 */

import { useEffect, useState } from "react";
import Link from "next/link";
import { allReferees, RefereeListEntry } from "@/lib/queries/read";

export default function RefereesPage() {
  const [refs, setRefs] = useState<RefereeListEntry[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    allReferees()
      .then(setRefs)
      .catch((e) => setError(String(e.message ?? e)));
  }, []);

  return (
    <>
      <header>
        <div className="wrap bar">
          <Link href="/" className="mark" style={{ textDecoration: "none" }}>
            <span className="whistle" />
            refcentral
          </Link>
          <span className="tagline">Premier League refereeing, one decision at a time</span>
        </div>
      </header>

      <main className="wrap">
        <div className="page-head">
          <h1 className="page-title">Referees</h1>
          <p className="lede">
            Listed alphabetically. Scores are built from individual decisions across every match
            on file, weighted by how much each call mattered, and they lean heavily on volume —
            one difficult afternoon barely moves a figure built from a season.
          </p>
        </div>

        {error && (
          <div className="state">
            <h2>Couldn&apos;t load referees</h2>
            <p>{error}</p>
          </div>
        )}

        {!error && !refs && (
          <div className="state">
            <h2>Loading…</h2>
          </div>
        )}

        {refs?.length === 0 && (
          <div className="state">
            <h2>No referees yet</h2>
            <p>Run the ingest to pull a matchday in.</p>
          </div>
        )}

        {refs && refs.length > 0 && (
          <table className="reftable">
            <thead>
              <tr>
                <th>Referee</th>
                <th className="num">Matches</th>
                <th className="num">Career</th>
                <th className="num">Neutrals</th>
                <th className="num">Supporters</th>
                <th className="num">Gap</th>
              </tr>
            </thead>
            <tbody>
              {refs.map((r) => (
                <tr key={r.id}>
                  <td>
                    <Link href={`/referees/${r.id}`}>{r.name}</Link>
                    {r.country && <span className="country"> · {r.country}</span>}
                  </td>
                  <td className="num">{r.matches}</td>
                  <td className="num strong">{r.career != null ? r.career.toFixed(2) : "—"}</td>
                  <td className="num">{r.neutral != null ? r.neutral.toFixed(2) : "—"}</td>
                  <td className="num">{r.partisan != null ? r.partisan.toFixed(2) : "—"}</td>
                  <td className={`num ${r.divergence != null && r.divergence > 0.5 ? "gap" : ""}`}>
                    {r.divergence != null ? r.divergence.toFixed(2) : "—"}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        )}

        <p className="note">
          &ldquo;Gap&rdquo; is how far neutral raters and supporters of the two clubs diverged on
          the same calls. A wide gap says more about how contested a referee&apos;s decisions
          were than about whether they were right.
        </p>
      </main>

      <footer className="wrap">
        <p>refcentral analyses refereeing decisions. Built in Helsinki.</p>
      </footer>
    </>
  );
}
