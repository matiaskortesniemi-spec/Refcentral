/**
 * Adapter: football-data.org v4 -> officials, plus cross-provider linking.
 *
 * We use this provider for exactly one thing: referee identity. Its free tier
 * covers the top competitions permanently, and unlike API-Football it returns
 * a referees[] array with stable integer ids, typed roles and nationality.
 *
 * Linking is where the risk sits. The two providers share no ids and don't
 * agree on team names ("ES Troyes AC" vs "Troyes", "Inter" vs
 * "Internazionale"), so fixtures are matched on evidence with a deliberately
 * high bar: attaching the wrong referee to a match is the same failure class
 * as merging two referees.
 */

import { FdMatchLite, Official, NormalizedMatch } from "../types";
import { jaroWinkler, normalize } from "../normalize";

const ROLE_MAP: Record<string, Official["role"]> = {
  REFEREE: "REFEREE",
  ASSISTANT_REFEREE_N1: "ASSISTANT_1",
  ASSISTANT_REFEREE_N2: "ASSISTANT_2",
  FOURTH_OFFICIAL: "FOURTH",
  VIDEO_ASSISTANT_REFEREE_N1: "VAR_1",
  VIDEO_ASSISTANT_REFEREE_N2: "VAR_2",
};

export function adaptFootballDataOfficials(m: FdMatchLite): Official[] {
  return (m.referees ?? [])
    .filter((r) => ROLE_MAP[r.type])
    .map((r) => ({
      providerId: r.id,
      name: r.name,
      role: ROLE_MAP[r.type],
      nationality: r.nationality,
    }));
}

// ---------------------------------------------------------------------------
// Linking
// ---------------------------------------------------------------------------

/** Providers occasionally disagree on kickoff by minutes; same-day is enough. */
const KICKOFF_TOLERANCE_MS = 8 * 60 * 60 * 1000;

/** Below this, refuse to link rather than attach a possibly-wrong referee. */
export const LINK_ACCEPT = 0.88;

export interface LinkResult {
  linked: boolean;
  score: number;
  reasons: string[];
}

/**
 * Scores an API-Football match against a football-data candidate.
 *
 * Kickoff and competition are hard filters, not scored inputs — a match on
 * the wrong day or in the wrong competition is not the same match no matter
 * how similar the team names are. Team names carry the score, and an
 * identical full-time score is strong confirmation on top.
 */
export function linkFixture(af: NormalizedMatch, fd: FdMatchLite): LinkResult {
  const reasons: string[] = [];

  const dt = Math.abs(new Date(af.kickoff).getTime() - new Date(fd.utcDate).getTime());
  if (!Number.isFinite(dt) || dt > KICKOFF_TOLERANCE_MS) {
    return { linked: false, score: 0, reasons: ["kickoff outside tolerance"] };
  }

  if (af.competition.code && fd.competition?.code && af.competition.code !== fd.competition.code) {
    return { linked: false, score: 0, reasons: ["different competition"] };
  }

  const homeScore = bestNameScore(af.home.name, [fd.homeTeam.name, fd.homeTeam.shortName]);
  const awayScore = bestNameScore(af.away.name, [fd.awayTeam.name, fd.awayTeam.shortName]);
  reasons.push(`home ${homeScore.toFixed(3)}`, `away ${awayScore.toFixed(3)}`);

  // Both sides must be plausible. One strong and one weak usually means we've
  // found a different fixture involving one of the same teams.
  const teamScore = Math.min(homeScore, awayScore);

  let score = teamScore;
  const afFt = af.fullTime;
  const fdFt = fd.score?.fullTime;
  if (afFt.home != null && fdFt?.home != null) {
    if (afFt.home === fdFt.home && afFt.away === fdFt.away) {
      score = Math.min(1, score + 0.06);
      reasons.push("full-time score matches");
    } else {
      score *= 0.7;
      reasons.push("full-time score differs");
    }
  }

  return { linked: score >= LINK_ACCEPT, score, reasons };
}

function bestNameScore(a: string, candidates: (string | undefined)[]): number {
  const na = normalize(a);
  let best = 0;
  for (const c of candidates) {
    if (!c) continue;
    best = Math.max(best, jaroWinkler(na, normalize(c)));
  }
  return best;
}

/** Picks the single best football-data candidate for an API-Football match. */
export function findOfficials(
  af: NormalizedMatch,
  candidates: FdMatchLite[]
): { officials: Official[]; link: LinkResult | null } {
  let best: { fd: FdMatchLite; link: LinkResult } | null = null;
  for (const fd of candidates) {
    const link = linkFixture(af, fd);
    if (!best || link.score > best.link.score) best = { fd, link };
  }
  if (!best || !best.link.linked) return { officials: [], link: best?.link ?? null };
  return { officials: adaptFootballDataOfficials(best.fd), link: best.link };
}
