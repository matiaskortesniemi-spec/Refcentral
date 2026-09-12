"use client";

/**
 * refcentral — small display components
 *
 * Three things that carry meaning rather than decoration:
 *
 *   MatchState    whether the match is being played right now. Motion is
 *                 reserved for this and nothing else on the page, so a
 *                 pulsing mark always means "still happening".
 *
 *   GameManagementMark  the game-management row is blended into every match
 *                 score rather than being one call among several, so it gets
 *                 a mark that says "counts toward everything" rather than a
 *                 tier badge that would imply it sits on the same ladder.
 *
 *   CommunityAverage  what everyone else concluded, shown whether or not the
 *                 reader is signed in. The average is the product. Putting it
 *                 behind an account would withhold the thing people came for
 *                 and make signing in feel like a toll rather than a way to
 *                 take part.
 */

export type MatchPhase = "LIVE" | "FINISHED" | "UPCOMING";

/**
 * Derived rather than stored, because the ingest only ever writes finished
 * matches today. When live ingest arrives this reads the real state without
 * the callers changing.
 */
export function matchPhase(
  kickoff: string,
  ftHome: number | null,
  ftAway: number | null
): MatchPhase {
  const start = new Date(kickoff).getTime();
  const now = Date.now();
  if (now < start) return "UPCOMING";
  // A match plus stoppages and half time runs a little under two hours.
  const likelyOver = now > start + 115 * 60_000;
  if (ftHome !== null && ftAway !== null && likelyOver) return "FINISHED";
  if (!likelyOver) return "LIVE";
  return "FINISHED";
}

export function MatchState({ phase }: { phase: MatchPhase }) {
  if (phase === "LIVE") {
    return (
      <span className="state-dot live">
        <span className="ball" />
        Live
      </span>
    );
  }
  if (phase === "UPCOMING") {
    return <span className="state-dot">Not started</span>;
  }
  return (
    <span className="state-dot">
      <WhistleIcon />
      Full time
    </span>
  );
}

function WhistleIcon() {
  return (
    <svg className="whistle-icon" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <path
        d="M1 6.5h6.2L9 4.6a4 4 0 1 1 0 6.8L7.2 9.5H1z"
        stroke="currentColor"
        strokeWidth="1.3"
        strokeLinejoin="round"
      />
      <circle cx="11.4" cy="8" r="1.5" fill="currentColor" />
    </svg>
  );
}

export function GameManagementMark() {
  return (
    <span className="gm-mark">
      <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        {/* Concentric rings: this rating feeds every layer above it. */}
        <circle cx="8" cy="8" r="6.2" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="8" cy="8" r="3.2" stroke="currentColor" strokeWidth="1.2" />
        <circle cx="8" cy="8" r="1" fill="currentColor" />
      </svg>
      Counts toward every match score
    </span>
  );
}

/**
 * The community average, as a marker on a track.
 *
 * A number alone ("3.41") is hard to place; the same value as a position on
 * the 0–5 track people are about to drag is immediately legible, and it sets
 * an anchor before they choose. That anchoring is a real effect and worth
 * being deliberate about — it is shown because hiding what others thought
 * would make the site feel like a poll rather than an analysis, and the
 * neutral/supporter split is published alongside so the number is never a
 * single authoritative verdict.
 */
export function CommunityAverage({
  score,
  neutral,
  partisan,
  effectiveN,
}: {
  score: number | null;
  neutral: number | null;
  partisan: number | null;
  effectiveN: number;
}) {
  if (score == null) {
    return <div className="avg-none">No ratings yet — be the first.</div>;
  }

  const pct = Math.max(0, Math.min(100, (score / 5) * 100));

  return (
    <div className="rate-wrap">
      <div className="avg-track">
        <span className="avg-dot" style={{ left: `${pct}%` }} />
      </div>
      <div className="avg-legend">
        <span className="swatch" />
        <span>
          community <b>{score.toFixed(2)}</b>
        </span>
        {neutral != null && <span>neutrals {neutral.toFixed(2)}</span>}
        {partisan != null && <span>supporters {partisan.toFixed(2)}</span>}
        {effectiveN > 0 && <span>{Math.round(effectiveN)} weighted votes</span>}
      </div>
    </div>
  );
}

/** The same average, positioned on the live slider track behind the thumb. */
export function AverageMarker({ score }: { score: number | null }) {
  if (score == null) return null;
  const pct = Math.max(0, Math.min(100, (score / 5) * 100));
  return <span className="slider-marker" style={{ left: `${pct}%` }} aria-hidden="true" />;
}
