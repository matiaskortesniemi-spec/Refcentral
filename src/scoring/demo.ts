import { Decision, DecisionType, Tier } from "../types";
import { Rating, ScoredDecision } from "./types";
import { UserMeta } from "./brigade";
import { buildPriors, runScoringJob, FixtureMeta, JobInput } from "./job";

const line = (s: string) => console.log(`\n${"=".repeat(72)}\n${s}\n${"=".repeat(72)}`);
const f2 = (n: number | null) => (n === null ? "  —  " : n.toFixed(2).padStart(5));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

let uid = 0;
const users = new Map<string, UserMeta>();
function user(fresh = false): string {
  const id = `u${uid++}`;
  users.set(id, {
    userId: id,
    createdAt: fresh ? "2026-09-05T17:00:00Z" : "2024-01-01T00:00:00Z",
    priorRatings: fresh ? 0 : 50,
  });
  return id;
}

function decision(fixtureId: number, id: string, type: DecisionType, tier: Tier, minute: number): Decision {
  return {
    id, fixtureId, type, tier, minute, extra: null,
    favours: "AWAY", against: "HOME",
    playerId: null, playerName: null, teamId: null,
    label: id, ruleId: "demo", tierReasons: [], source: "AUTO",
    createdAt: "2026-09-05T16:00:00Z",
  };
}

/** Generates ratings with a given mean/spread per bucket. */
function rate(
  decisionId: string, fixtureId: number,
  spec: { allegiance: Rating["allegiance"]; n: number; value: number; jitter?: number; fresh?: boolean; withinMinutes?: number }[]
): Rating[] {
  const out: Rating[] = [];
  const base = new Date("2026-09-05T17:30:00Z").getTime();
  for (const s of spec) {
    for (let i = 0; i < s.n; i++) {
      const jitter = s.jitter ?? 0.6;
      // Deterministic pseudo-spread so runs are reproducible.
      const offset = ((i * 2654435761) % 1000) / 1000 - 0.5;
      const value = Math.max(0, Math.min(5, s.value + offset * jitter * 2));
      const spreadMs = (s.withinMinutes ?? 600) * 60_000;
      out.push({
        decisionId, fixtureId, userId: user(s.fresh),
        value: Math.round(value * 10) / 10,
        allegiance: s.allegiance,
        createdAt: new Date(base + ((i * 7919) % spreadMs)).toISOString(),
      });
    }
  }
  return out;
}

const fixtures = new Map<number, FixtureMeta>([
  [1, { fixtureId: 1, refereeId: "ref_A", refereeName: "M. Halloran", competition: "PL",
        kickoff: "2026-09-05T14:00:00Z", ratingOpenedAt: "2026-09-05T17:15:00Z" }],
  [2, { fixtureId: 2, refereeId: "ref_A", refereeName: "M. Halloran", competition: "CL",
        kickoff: "2026-09-16T19:00:00Z", ratingOpenedAt: "2026-09-16T22:15:00Z" }],
  [3, { fixtureId: 3, refereeId: "ref_B", refereeName: "D. Castellani", competition: "SA",
        kickoff: "2026-09-06T16:00:00Z", ratingOpenedAt: "2026-09-06T19:15:00Z" }],
]);

const decisions: Decision[] = [
  decision(1, "d1-pen", "PENALTY_AWARDED", 5, 26),
  decision(1, "d1-yel", "YELLOW_CARD", 1, 38),
  decision(1, "d1-gm", "GAME_MANAGEMENT", 2, 0),
  decision(2, "d2-red", "RED_CARD", 5, 71),
  decision(2, "d2-gm", "GAME_MANAGEMENT", 2, 0),
  decision(3, "d3-pen", "PENALTY_AWARDED", 5, 9),
  decision(3, "d3-gm", "GAME_MANAGEMENT", 2, 0),
];

const ratings: Rating[] = [
  // Fixture 1 — an honest sample. Partisans unhappy, neutrals lukewarm.
  ...rate("d1-pen", 1, [
    { allegiance: "NEUTRAL", n: 420, value: 3.1 },
    { allegiance: "HOME",    n: 900, value: 1.6 },
    { allegiance: "AWAY",    n: 700, value: 4.1 },
  ]),
  ...rate("d1-yel", 1, [
    { allegiance: "NEUTRAL", n: 200, value: 3.6 },
    { allegiance: "HOME",    n: 320, value: 3.0 },
    { allegiance: "AWAY",    n: 260, value: 3.8 },
  ]),
  ...rate("d1-gm", 1, [
    { allegiance: "NEUTRAL", n: 350, value: 3.5 },
    { allegiance: "HOME",    n: 640, value: 2.6 },
    { allegiance: "AWAY",    n: 520, value: 3.7 },
  ]),

  // Fixture 2 — Champions League, thin sample on the red card.
  ...rate("d2-red", 2, [
    { allegiance: "NEUTRAL", n: 40, value: 3.9 },
    { allegiance: "HOME",    n: 55, value: 2.9 },
    { allegiance: "AWAY",    n: 50, value: 4.2 },
  ]),
  ...rate("d2-gm", 2, [
    { allegiance: "NEUTRAL", n: 90, value: 3.8 },
    { allegiance: "HOME",    n: 120, value: 3.2 },
    { allegiance: "AWAY",    n: 110, value: 4.0 },
  ]),

  // Fixture 3 — a brigade. Almost all one fanbase, nearly all on the rail,
  // arriving in a 20-minute burst, mostly from accounts made after the window
  // opened.
  ...rate("d3-pen", 3, [
    { allegiance: "HOME", n: 1400, value: 0.15, jitter: 0.12, fresh: true, withinMinutes: 20 },
    { allegiance: "NEUTRAL", n: 40, value: 3.0, withinMinutes: 20 },
  ]),
  ...rate("d3-gm", 3, [
    { allegiance: "NEUTRAL", n: 160, value: 3.1 },
    { allegiance: "HOME",    n: 300, value: 2.2 },
    { allegiance: "AWAY",    n: 180, value: 3.4 },
  ]),
];

// ---------------------------------------------------------------------------
line("Pass 1 — cold start, no priors yet");
// ---------------------------------------------------------------------------

const coldPriors = buildPriors([], []);
const input: JobInput = { decisions, ratings, fixtures, users };
const pass1 = runScoringJob(input, coldPriors);

console.log("  decision      tier  score   raw   effN  prior(src)        neutral partisan  div   flags");
for (const d of pass1.decisions) {
  console.log(
    `  ${d.decisionId.padEnd(12)} ${d.tier}    ${f2(d.score)} ${f2(d.rawCombined)} ${String(Math.round(d.effectiveN)).padStart(5)}  ${d.prior.value.toFixed(2)} ${d.prior.source.padEnd(12)} ${f2(d.neutralMean)}  ${f2(d.partisanMean)}  ${f2(d.divergence)}  ${d.flags.join(",") || "-"}`
  );
}

// ---------------------------------------------------------------------------
line("Brigade detection");
// ---------------------------------------------------------------------------

if (pass1.alerts.length === 0) console.log("  no alerts");
for (const a of pass1.alerts) {
  const d = pass1.decisions.find((x) => x.decisionId === a.decisionId)!;
  console.log(`  ${a.decisionId}  ${d.held ? "HELD (published previous value)" : "flagged, published"}`);
  console.log(`     flags: ${a.flags.join(", ")}`);
  for (const dl of a.detail) console.log(`     - ${dl}`);
}

// ---------------------------------------------------------------------------
line("Match scores");
// ---------------------------------------------------------------------------

console.log("  fixture  comp  score  neutral partisan  decisions  effN   held");
for (const m of pass1.matches) {
  console.log(
    `  ${String(m.fixtureId).padEnd(8)} ${m.competition.padEnd(5)} ${f2(m.score)} ${f2(m.neutralScore)}  ${f2(m.partisanScore)}    ${String(m.decisionCount).padStart(4)}    ${String(Math.round(m.effectiveN)).padStart(5)}  ${m.held}`
  );
}

// ---------------------------------------------------------------------------
line("Pass 2 — priors rebuilt from pass 1, then rescored");
// ---------------------------------------------------------------------------

const warmPriors = buildPriors(
  pass1.decisions.map((d) => ({
    competition: fixtures.get(d.fixtureId)!.competition,
    type: d.type,
    rawCombined: d.held ? null : d.rawCombined,
    effectiveN: d.effectiveN,
  })),
  pass1.matches.map((m) => ({ competition: m.competition, score: m.score }))
);

console.log("  league|type priors with enough history:");
let shown = 0;
for (const [k, v] of warmPriors.leagueType) {
  if (v.n >= 200) {
    console.log(`    ${k.padEnd(28)} mean ${v.mean.toFixed(3)}  n ${Math.round(v.n)}`);
    shown++;
  }
}
if (!shown) console.log("    (none yet — a single matchday is not enough history)");
console.log(`  global referee mean: ${warmPriors.globalReferee.mean.toFixed(3)} over ${warmPriors.globalReferee.n} matches`);

const previous = new Map<string, ScoredDecision>(pass1.decisions.map((d) => [d.decisionId, d]));
const pass2 = runScoringJob({ ...input, previous }, warmPriors);

console.log("\n  decision      pass1  pass2   delta  prior source");
for (const d of pass2.decisions) {
  const p1 = previous.get(d.decisionId)!;
  console.log(
    `  ${d.decisionId.padEnd(12)} ${f2(p1.score)}  ${f2(d.score)}  ${(d.score - p1.score >= 0 ? "+" : "")}${(d.score - p1.score).toFixed(3)}  ${d.prior.source}${d.held ? "  [HELD]" : ""}`
  );
}

// ---------------------------------------------------------------------------
line("Referee aggregates");
// ---------------------------------------------------------------------------

for (const r of pass2.referees) {
  console.log(`\n  ${r.canonicalName}  (${r.matches} matches)`);
  console.log(`    career ${r.career.toFixed(3)}   raw ${r.careerRaw.toFixed(3)}   league-adjusted ${r.careerAdjusted.toFixed(3)}`);
  console.log(`    neutrals ${f2(r.neutral)}   partisans ${f2(r.partisan)}   form ${r.form >= 0 ? "+" : ""}${r.form.toFixed(3)}`);
  console.log(`    by competition: ${r.perCompetition.map((c) => `${c.competition} ${c.score.toFixed(2)} (${c.matches})`).join("  ")}`);
  for (const c of r.categories) {
    console.log(`      ${c.category.padEnd(16)} ${f2(c.score)}  neutrals ${f2(c.neutral)}  partisans ${f2(c.partisan)}  div ${f2(c.divergence)}  (${c.decisions})`);
  }
}
