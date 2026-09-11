/**
 * refcentral — domain types
 *
 * The rules never read a provider payload directly. Each provider is
 * flattened by an adapter into NormalizedMatch, and the engine runs on that.
 *
 * Why: API-Football has VAR events and missed penalties but returns the
 * referee as an unstructured string with no id. football-data.org has a
 * proper referees[] array with stable ids, free forever for the top
 * competitions, but emits no VAR. Neither is sufficient alone, so neither
 * should be load-bearing.
 */

// ===========================================================================
// Internal model — what the rules see
// ===========================================================================

export type EventKind =
  | "GOAL" | "GOAL_PENALTY" | "GOAL_OWN" | "PENALTY_MISSED"
  | "CARD_YELLOW" | "CARD_SECOND_YELLOW" | "CARD_RED"
  | "VAR" | "SUBSTITUTION" | "UNKNOWN";

export type Side = "HOME" | "AWAY" | "NEUTRAL";

/** What a VAR review concluded. */
export type VarOutcome = "OVERTURNED" | "UPHELD" | "UNDER_REVIEW" | "UNCLASSIFIED";

/** What the VAR review was about. */
export type VarSubject = "GOAL" | "PENALTY" | "CARD" | "UNKNOWN";

export interface NormalizedEvent {
  kind: EventKind;
  minute: number;
  extra: number | null;
  side: Side;
  teamId: number | null;
  playerId: number | null;
  playerName: string | null;
  /** VAR only. */
  var?: { outcome: VarOutcome; subject: VarSubject; raw: string };
  /** Original provider strings, kept for debugging and warnings. */
  raw: { type: string; detail: string };
}

export interface Official {
  providerId: number | null;
  name: string;
  role: "REFEREE" | "ASSISTANT_1" | "ASSISTANT_2" | "FOURTH" | "VAR_1" | "VAR_2";
  nationality: string | null;
}

export interface NormalizedMatch {
  provider: "API_FOOTBALL" | "FOOTBALL_DATA";
  providerFixtureId: number;
  kickoff: string;
  finished: boolean;
  competition: { code: string | null; name: string; season: number | null };
  home: { id: number | null; name: string };
  away: { id: number | null; name: string };
  fullTime: { home: number | null; away: number | null };
  events: NormalizedEvent[];
  /** Structured officials when the provider gives them (football-data only). */
  officials: Official[];
  /** Raw referee text when that's all the provider gives (API-Football). */
  refereeRaw: string | null;
  warnings: string[];
}

// ===========================================================================
// Decisions
// ===========================================================================

export type DecisionType =
  | "PENALTY_AWARDED" | "PENALTY_MISSED"
  | "RED_CARD" | "SECOND_YELLOW" | "YELLOW_CARD"
  | "VAR_OVERTURN" | "VAR_UPHELD"
  | "CROWD_INCIDENT" | "GAME_MANAGEMENT";

export type Tier = 1 | 2 | 3 | 5;

export const TIER_LABEL: Record<Tier, string> = {
  5: "Match-changing", 3: "Significant", 2: "Blended in", 1: "Routine",
};

export interface Decision {
  id: string;
  fixtureId: number;
  type: DecisionType;
  tier: Tier;
  minute: number;
  extra: number | null;
  favours: Side;
  against: Side;
  playerId: number | null;
  playerName: string | null;
  teamId: number | null;
  label: string;
  ruleId: string;
  tierReasons: string[];
  source: "AUTO" | "CROWD";
  /** Set when a VAR review was folded into this decision. */
  varNote?: string;
  createdAt: string;
}

export interface MatchClock {
  minute: number;
  homeGoals: number;
  awayGoals: number;
  margin: number;
  bookedPlayers: Set<number>;
}

// ===========================================================================
// Referee identity
// ===========================================================================

export interface RefereeRecord {
  /** refcentral's own id, never a provider's. */
  id: string;
  /** football-data.org person id when known — the strongest key available. */
  fdPersonId: number | null;
  canonicalName: string;
  country: string | null;
  /** Every raw provider string that has resolved to this person. */
  aliases: string[];
  matchesSeen: number;
}

export type Confidence = "EXACT_ID" | "KNOWN_ALIAS" | "FUZZY_ACCEPT" | "QUARANTINE" | "NEW";

export interface ResolveResult {
  referee: RefereeRecord | null;
  confidence: Confidence;
  score: number;
  rivals: { id: string; name: string; score: number }[];
  reason: string;
  /** True when the match must not publish until a human resolves it. */
  blocked: boolean;
}

// ===========================================================================
// Provider payload shapes (only what we consume)
// ===========================================================================

export interface AfEvent {
  time: { elapsed: number; extra: number | null };
  team: { id: number; name: string };
  player: { id: number | null; name: string | null };
  assist?: { id: number | null; name: string | null };
  type: string;
  detail: string;
  comments: string | null;
}

export interface AfFixtureResponse {
  fixture: {
    id: number;
    referee: string | null;
    date: string;
    status: { long: string; short: string; elapsed: number | null };
  };
  league?: { id: number; name: string; country: string; season: number; round: string };
  teams?: { home: { id: number; name: string }; away: { id: number; name: string } };
  goals?: { home: number | null; away: number | null };
  score?: { fulltime: { home: number | null; away: number | null } };
  events?: AfEvent[];
}

export interface FdMatchLite {
  id: number;
  utcDate: string;
  status: string;
  competition?: { name: string; code: string };
  season?: { id: number };
  homeTeam: { id: number; name: string; shortName?: string };
  awayTeam: { id: number; name: string; shortName?: string };
  score?: { fullTime: { home: number | null; away: number | null } };
  referees: { id: number; name: string; type: string; nationality: string | null }[];
}
