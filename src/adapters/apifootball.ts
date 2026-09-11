/**
 * Adapter: API-Football v3 -> NormalizedMatch
 *
 * The interesting part is classifyVar. API-Football exposes VAR through
 * `type: "Var"` with a free-text `detail` — "Goal cancelled", "Penalty
 * confirmed" and so on. That set is not formally enumerated in the docs and
 * has grown since VAR events were added for the 2020-21 season onward.
 *
 * So the classifier is keyword-based rather than an exhaustive map, and
 * anything it can't place comes back UNCLASSIFIED and is surfaced as a
 * warning rather than silently dropped or guessed at. Read those warnings
 * after your first backfill and extend the keyword lists — much cheaper than
 * discovering six months later that a detail string you never handled has
 * been quietly producing no decisions.
 */

import {
  AfEvent, AfFixtureResponse, NormalizedEvent, NormalizedMatch,
  EventKind, Side, VarOutcome, VarSubject,
} from "../types";

/** API-Football league ids for the top five plus UCL, with fd codes to join on. */
export const AF_LEAGUES: Record<string, { afId: number; name: string; fdCode: string }> = {
  PL:  { afId: 39,  name: "Premier League",   fdCode: "PL"  },
  PD:  { afId: 140, name: "La Liga",          fdCode: "PD"  },
  SA:  { afId: 135, name: "Serie A",          fdCode: "SA"  },
  BL1: { afId: 78,  name: "Bundesliga",       fdCode: "BL1" },
  FL1: { afId: 61,  name: "Ligue 1",          fdCode: "FL1" },
  CL:  { afId: 2,   name: "Champions League", fdCode: "CL"  },
};

// ---------------------------------------------------------------------------
// VAR classification
// ---------------------------------------------------------------------------

const OVERTURN_WORDS = ["cancel", "disallow", "overturn", "rescind", "chalked off", "annul", "upgrade", "reversed"];
const UPHELD_WORDS = ["confirm", "uphold", "stands", "awarded", "validated"];
const REVIEW_WORDS = ["under review", "checking", "reviewing", "check "];

const SUBJECT_WORDS: [VarSubject, string[]][] = [
  ["GOAL", ["goal"]],
  ["PENALTY", ["penalty", "pen "]],
  ["CARD", ["card", "red", "yellow"]],
];

export function classifyVar(detail: string): { outcome: VarOutcome; subject: VarSubject; raw: string } {
  const d = (detail || "").toLowerCase();

  let subject: VarSubject = "UNKNOWN";
  for (const [s, words] of SUBJECT_WORDS) {
    if (words.some((w) => d.includes(w))) {
      subject = s;
      break;
    }
  }

  let outcome: VarOutcome = "UNCLASSIFIED";
  if (REVIEW_WORDS.some((w) => d.includes(w))) outcome = "UNDER_REVIEW";
  else if (OVERTURN_WORDS.some((w) => d.includes(w))) outcome = "OVERTURNED";
  else if (UPHELD_WORDS.some((w) => d.includes(w))) outcome = "UPHELD";

  return { outcome, subject, raw: detail };
}

// ---------------------------------------------------------------------------
// Event mapping
// ---------------------------------------------------------------------------

function mapKind(type: string, detail: string): EventKind {
  const t = (type || "").toLowerCase();
  const d = (detail || "").toLowerCase();

  if (t === "var") return "VAR";
  if (t === "subst") return "SUBSTITUTION";

  if (t === "goal") {
    if (d.includes("missed penalty")) return "PENALTY_MISSED";
    if (d.includes("own goal")) return "GOAL_OWN";
    if (d.includes("penalty")) return "GOAL_PENALTY";
    return "GOAL";
  }

  if (t === "card") {
    if (d.includes("second yellow")) return "CARD_SECOND_YELLOW";
    if (d.includes("red")) return "CARD_RED";
    if (d.includes("yellow")) return "CARD_YELLOW";
  }

  return "UNKNOWN";
}

export function adaptApiFootball(res: AfFixtureResponse, events: AfEvent[] = []): NormalizedMatch {
  const warnings: string[] = [];
  const homeId = res.teams?.home.id ?? null;
  const awayId = res.teams?.away.id ?? null;

  const side = (teamId: number | null): Side =>
    teamId == null ? "NEUTRAL" : teamId === homeId ? "HOME" : teamId === awayId ? "AWAY" : "NEUTRAL";

  const normalized: NormalizedEvent[] = (events ?? []).map((e) => {
    const kind = mapKind(e.type, e.detail);
    const ev: NormalizedEvent = {
      kind,
      minute: e.time?.elapsed ?? 0,
      extra: e.time?.extra ?? null,
      side: side(e.team?.id ?? null),
      teamId: e.team?.id ?? null,
      playerId: e.player?.id ?? null,
      playerName: e.player?.name ?? null,
      raw: { type: e.type, detail: e.detail },
    };

    if (kind === "VAR") {
      ev.var = classifyVar(e.detail);
      if (ev.var.outcome === "UNCLASSIFIED") {
        warnings.push(`unclassified VAR detail: "${e.detail}" at ${ev.minute}'`);
      }
    }

    if (kind === "UNKNOWN") {
      warnings.push(`unmapped event type/detail: "${e.type}" / "${e.detail}" at ${ev.minute}'`);
    }

    return ev;
  });

  return {
    provider: "API_FOOTBALL",
    providerFixtureId: res.fixture.id,
    kickoff: res.fixture.date,
    finished: res.fixture.status?.short === "FT" || res.fixture.status?.short === "AET" || res.fixture.status?.short === "PEN",
    competition: {
      code: res.league ? (Object.entries(AF_LEAGUES).find(([, v]) => v.afId === res.league!.id)?.[0] ?? null) : null,
      name: res.league?.name ?? "",
      season: res.league?.season ?? null,
    },
    home: { id: homeId, name: res.teams?.home.name ?? "" },
    away: { id: awayId, name: res.teams?.away.name ?? "" },
    fullTime: {
      home: res.score?.fulltime.home ?? res.goals?.home ?? null,
      away: res.score?.fulltime.away ?? res.goals?.away ?? null,
    },
    events: normalized,
    officials: [],
    refereeRaw: res.fixture.referee ?? null,
    warnings,
  };
}
