/**
 * refcentral — rule engine
 *
 * Runs on NormalizedMatch, so it is identical whichever provider fed it.
 *
 * Two layers, unchanged:
 *   1. EXTRACTORS  event shape -> candidate decision at a BASE tier
 *   2. ESCALATORS  match context raises or lowers that tier
 *
 * What's new now that API-Football is the event source:
 *   - VAR_OVERTURN / VAR_UPHELD are live rather than stubs
 *   - PENALTY_MISSED exists, which was invisible on football-data.org
 *   - a VAR review at the same minute as a card or penalty is FOLDED INTO
 *     that decision rather than published as a second rateable row
 *
 * That last one is a judgement call worth stating. If a penalty is given at
 * 26' and VAR confirms it at 26', those are one refereeing event, not two.
 * Publishing both asks the user to rate the same moment twice and double-
 * counts it in the weighted average. So the VAR outcome becomes a note on the
 * penalty and raises its tier if it was overturned. A VAR review with no
 * underlying event nearby stays a decision in its own right.
 */

import {
  Decision, DecisionType, Tier, Side, MatchClock,
  NormalizedMatch, NormalizedEvent,
} from "./types";

// ---------------------------------------------------------------------------
// 1. THE MAPPING TABLE
// ---------------------------------------------------------------------------

export const BASE_TIER: Record<Exclude<DecisionType, "GAME_MANAGEMENT" | "CROWD_INCIDENT">, Tier> = {
  PENALTY_AWARDED: 5,
  PENALTY_MISSED: 5,
  RED_CARD: 5,
  SECOND_YELLOW: 5,
  VAR_OVERTURN: 5,
  VAR_UPHELD: 3,
  YELLOW_CARD: 1,
};

export const GAME_MANAGEMENT_TIER: Tier = 2;

export const ENABLED: Record<DecisionType, boolean> = {
  PENALTY_AWARDED: true,
  PENALTY_MISSED: true,
  RED_CARD: true,
  SECOND_YELLOW: true,
  YELLOW_CARD: true,
  VAR_OVERTURN: true,   // live — API-Football emits VAR from 2020-21 onward
  VAR_UPHELD: true,     // live
  CROWD_INCIDENT: true,
  GAME_MANAGEMENT: true,
};

/** A VAR event within this many minutes of a call is about that call. */
const VAR_FOLD_WINDOW = 2;

// ---------------------------------------------------------------------------
// 2. ESCALATORS
// ---------------------------------------------------------------------------

interface Escalator {
  id: string;
  applies: DecisionType[];
  test: (d: Decision, clock: MatchClock) => { tier: Tier; reason: string } | null;
}

const LATE_MINUTE = 80;

export const ESCALATORS: Escalator[] = [
  {
    id: "yellow.player-already-booked",
    applies: ["YELLOW_CARD"],
    test: (d, clock) =>
      d.playerId != null && clock.bookedPlayers.has(d.playerId)
        ? { tier: 3, reason: "player was already booked" }
        : null,
  },
  {
    id: "yellow.late-and-tight",
    applies: ["YELLOW_CARD"],
    test: (d, clock) =>
      d.minute >= LATE_MINUTE && clock.margin <= 1
        ? { tier: 3, reason: `shown in the ${d.minute}' with ${clock.margin === 0 ? "scores level" : "one goal in it"}` }
        : null,
  },
  {
    id: "penalty.dead-rubber",
    applies: ["PENALTY_AWARDED", "PENALTY_MISSED"],
    test: (d, clock) =>
      clock.margin >= 3 ? { tier: 3, reason: `awarded with the match ${clock.margin} goals apart` } : null,
  },
  {
    id: "red.dead-rubber",
    applies: ["RED_CARD", "SECOND_YELLOW"],
    test: (d, clock) =>
      clock.margin >= 3 && d.minute >= LATE_MINUTE
        ? { tier: 3, reason: `shown late with the match ${clock.margin} goals apart` }
        : null,
  },
];

// ---------------------------------------------------------------------------
// 3. CLOCK
// ---------------------------------------------------------------------------

export function clockAt(match: NormalizedMatch, upToIndex: number): MatchClock {
  let homeGoals = 0;
  let awayGoals = 0;
  const bookedPlayers = new Set<number>();

  match.events.forEach((e, i) => {
    if (i >= upToIndex) return;
    if (e.kind === "GOAL" || e.kind === "GOAL_PENALTY") {
      if (e.side === "HOME") homeGoals++;
      else if (e.side === "AWAY") awayGoals++;
    }
    if (e.kind === "GOAL_OWN") {
      // Own goals credit the opposing side.
      if (e.side === "HOME") awayGoals++;
      else if (e.side === "AWAY") homeGoals++;
    }
    if (e.kind === "CARD_YELLOW" && e.playerId != null) bookedPlayers.add(e.playerId);
  });

  const minute = match.events[upToIndex]?.minute ?? 0;
  return { minute, homeGoals, awayGoals, margin: Math.abs(homeGoals - awayGoals), bookedPlayers };
}

// ---------------------------------------------------------------------------
// 4. EXTRACTION
// ---------------------------------------------------------------------------

const other = (s: Side): Side => (s === "HOME" ? "AWAY" : s === "AWAY" ? "HOME" : "NEUTRAL");

function teamLabel(m: NormalizedMatch, s: Side): string {
  return s === "HOME" ? m.home.name : s === "AWAY" ? m.away.name : "";
}

function did(fixtureId: number, type: DecisionType, minute: number, subject: string | number): string {
  return `${fixtureId}:${type}:${minute}:${subject}`;
}

interface Candidate {
  decision: Decision;
  eventIndex: number;
}

function extract(m: NormalizedMatch): Candidate[] {
  const out: Candidate[] = [];
  const now = new Date().toISOString();

  /**
   * Yellows already shown to each player.
   *
   * A 25-fixture Premier League sample contained 97 cards and not a single
   * "Second Yellow card" detail string, so we cannot rely on the provider
   * emitting one. Without this, a player booked twice produces two separate
   * tier-1/tier-3 cautions and the sending-off — the actual match-changing
   * call — never appears at all.
   */
  const yellowCount = new Map<number, number>();
  /**
   * Players already dismissed. A card after a sending-off is a provider data
   * error, and without this a stray yellow derives a second dismissal for a
   * player who is no longer on the pitch.
   */
  const sentOff = new Set<number>();

  m.events.forEach((e, i) => {
    const base = {
      fixtureId: m.providerFixtureId,
      minute: e.minute,
      extra: e.extra,
      playerId: e.playerId,
      playerName: e.playerName,
      teamId: e.teamId,
      source: "AUTO" as const,
      createdAt: now,
    };

    const push = (
      type: DecisionType,
      favours: Side,
      against: Side,
      label: string,
      ruleId: string,
      firstReason: string
    ) => {
      if (!ENABLED[type]) return;
      out.push({
        eventIndex: i,
        decision: {
          ...base,
          id: did(m.providerFixtureId, type, e.minute, e.playerId ?? e.raw.detail),
          type,
          tier: (BASE_TIER as Record<string, Tier>)[type] ?? 3,
          favours,
          against,
          label,
          ruleId,
          tierReasons: [firstReason],
        },
      });
    };

    switch (e.kind) {
      case "GOAL_PENALTY":
        push(
          "PENALTY_AWARDED", e.side, other(e.side),
          `Penalty awarded to ${teamLabel(m, e.side)}, converted by ${e.playerName ?? "unknown"}`,
          "extract.penalty.scored", "penalty awarded"
        );
        break;

      case "PENALTY_MISSED":
        push(
          "PENALTY_MISSED", e.side, other(e.side),
          `Penalty awarded to ${teamLabel(m, e.side)}, not converted by ${e.playerName ?? "unknown"}`,
          "extract.penalty.missed", "penalty awarded"
        );
        break;

      case "CARD_RED":
        push(
          "RED_CARD", other(e.side), e.side,
          `Straight red shown to ${e.playerName ?? "unknown"} (${teamLabel(m, e.side)})`,
          "extract.card.red", "sending-off"
        );
        if (e.playerId != null) sentOff.add(e.playerId);
        break;

      case "CARD_SECOND_YELLOW":
        push(
          "SECOND_YELLOW", other(e.side), e.side,
          `Second yellow and a sending-off for ${e.playerName ?? "unknown"} (${teamLabel(m, e.side)})`,
          "extract.card.second-yellow", "sending-off"
        );
        if (e.playerId != null) sentOff.add(e.playerId);
        break;

      case "CARD_YELLOW": {
        const prior = e.playerId != null ? (yellowCount.get(e.playerId) ?? 0) : 0;
        const alreadyOff = e.playerId != null && sentOff.has(e.playerId);
        if (alreadyOff) {
          // Provider data error. Publish it as an ordinary caution rather than
          // inventing a second dismissal, and say so in the warnings.
          m.warnings.push(
            `card at ${e.minute}' for player ${e.playerId} who was already sent off — treated as a caution`
          );
          push(
            "YELLOW_CARD", other(e.side), e.side,
            `Yellow shown to ${e.playerName ?? "unknown"} (${teamLabel(m, e.side)})`,
            "extract.card.yellow", "routine caution"
          );
        } else if (prior >= 1) {
          // Derived, not reported. Same tier and label as an explicit one, but
          // a distinct ruleId so you can audit how often this path fires.
          push(
            "SECOND_YELLOW", other(e.side), e.side,
            `Second yellow and a sending-off for ${e.playerName ?? "unknown"} (${teamLabel(m, e.side)})`,
            "extract.card.derived-second-yellow", "sending-off (derived from two cautions)"
          );
          if (e.playerId != null) sentOff.add(e.playerId);
        } else {
          push(
            "YELLOW_CARD", other(e.side), e.side,
            `Yellow shown to ${e.playerName ?? "unknown"} (${teamLabel(m, e.side)})`,
            "extract.card.yellow", "routine caution"
          );
        }
        if (e.playerId != null) yellowCount.set(e.playerId, prior + 1);
        break;
      }

      case "VAR": {
        const v = e.var!;
        if (v.outcome === "UNDER_REVIEW" || v.outcome === "UNCLASSIFIED") return;
        const type: DecisionType = v.outcome === "OVERTURNED" ? "VAR_OVERTURN" : "VAR_UPHELD";
        const subj = v.subject === "UNKNOWN" ? "decision" : v.subject.toLowerCase();
        push(
          type,
          v.outcome === "OVERTURNED" ? other(e.side) : e.side,
          v.outcome === "OVERTURNED" ? e.side : other(e.side),
          v.outcome === "OVERTURNED"
            ? `VAR overturned the on-field ${subj} decision`
            : `VAR reviewed the ${subj} decision and the on-field call stood`,
          `extract.var.${v.outcome.toLowerCase()}`,
          `VAR review: ${v.raw}`
        );
        break;
      }
    }
  });

  return out;
}

// ---------------------------------------------------------------------------
// 5. VAR FOLDING
// ---------------------------------------------------------------------------

const FOLDABLE: DecisionType[] = [
  "PENALTY_AWARDED", "PENALTY_MISSED", "RED_CARD", "SECOND_YELLOW", "YELLOW_CARD",
];

/**
 * Merges a VAR decision into the underlying call when they describe the same
 * moment, and returns the reduced set.
 */
function foldVar(cands: Candidate[]): { kept: Candidate[]; folded: number } {
  const vars = cands.filter((c) => c.decision.type === "VAR_OVERTURN" || c.decision.type === "VAR_UPHELD");
  const rest = cands.filter((c) => !vars.includes(c));
  const consumed = new Set<Candidate>();

  for (const v of vars) {
    const subject = v.decision.ruleId.includes("overturn") ? "OVERTURNED" : "UPHELD";
    const host = rest.find(
      (c) =>
        FOLDABLE.includes(c.decision.type) &&
        Math.abs(c.decision.minute - v.decision.minute) <= VAR_FOLD_WINDOW
    );
    if (!host) continue;

    consumed.add(v);
    host.decision.varNote = v.decision.label;
    host.decision.tierReasons.push(
      subject === "OVERTURNED" ? "on-field call overturned by VAR" : "confirmed by VAR"
    );
    // An overturned call is inherently match-changing regardless of type.
    if (subject === "OVERTURNED" && host.decision.tier < 5) {
      host.decision.tierReasons.push("raised to tier 5: overturned on review");
      host.decision.tier = 5;
    }
  }

  return {
    kept: [...rest, ...vars.filter((v) => !consumed.has(v))],
    folded: consumed.size,
  };
}

// ---------------------------------------------------------------------------
// 6. THE ENGINE
// ---------------------------------------------------------------------------

export interface EngineResult {
  decisions: Decision[];
  warnings: string[];
  stats: { extracted: number; varFolded: number; published: number };
}

export function runRules(m: NormalizedMatch): EngineResult {
  const warnings = [...m.warnings];

  if (!m.finished) {
    return {
      decisions: [],
      warnings: [...warnings, `fixture ${m.providerFixtureId} is not finished — skipping`],
      stats: { extracted: 0, varFolded: 0, published: 0 },
    };
  }

  const extracted = extract(m);
  const { kept, folded } = foldVar(extracted);

  const decisions = kept
    .map(({ decision, eventIndex }) => {
      const clock = clockAt(m, eventIndex);
      let tier = decision.tier;
      const reasons = [...decision.tierReasons];

      for (const esc of ESCALATORS) {
        if (!esc.applies.includes(decision.type)) continue;
        // A VAR overturn already pinned this at tier 5; don't undo that.
        if (reasons.some((r) => r.includes("overturned"))) continue;
        const hit = esc.test(decision, clock);
        if (!hit || hit.tier === tier) continue;
        reasons.push(`${hit.tier > tier ? "raised" : "lowered"} to tier ${hit.tier}: ${hit.reason}`);
        tier = hit.tier;
      }

      return { ...decision, tier, tierReasons: reasons };
    })
    .sort((a, b) => a.minute - b.minute || b.tier - a.tier);

  decisions.push({
    id: did(m.providerFixtureId, "GAME_MANAGEMENT", 0, "match"),
    fixtureId: m.providerFixtureId,
    type: "GAME_MANAGEMENT",
    tier: GAME_MANAGEMENT_TIER,
    minute: 0,
    extra: null,
    favours: "NEUTRAL",
    against: "NEUTRAL",
    playerId: null,
    playerName: null,
    teamId: null,
    label: "Overall game management — control, communication, consistency",
    ruleId: "synthetic.game-management",
    tierReasons: ["blended into every match score"],
    source: "AUTO",
    createdAt: new Date().toISOString(),
  });

  return {
    decisions,
    warnings,
    stats: { extracted: extracted.length, varFolded: folded, published: decisions.length },
  };
}
