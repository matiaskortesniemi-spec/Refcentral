import { AfEvent, AfFixtureResponse, FdMatchLite, Official } from "./types";
import { adaptApiFootball, classifyVar } from "./adapters/apifootball";
import { findOfficials, linkFixture } from "./adapters/footballdata";
import { runRules } from "./rules";
import { RefereeResolver, InMemoryRefereeStore } from "./referees";

const line = (s: string) => console.log(`\n${"=".repeat(68)}\n${s}\n${"=".repeat(68)}`);

// ---------------------------------------------------------------------------
line("1. VAR detail classification (keyword-based, unknowns surfaced)");

for (const d of [
  "Goal cancelled", "Penalty confirmed", "Goal confirmed", "Penalty cancelled",
  "Card upgrade", "Goal Disallowed - offside", "Goal under review",
  "Red card cancelled", "Something nobody has documented",
]) {
  const c = classifyVar(d);
  console.log(`  ${d.padEnd(34)} -> ${c.outcome.padEnd(14)} ${c.subject}`);
}

// ---------------------------------------------------------------------------
line("2. Rule engine on an API-Football fixture");

const events: AfEvent[] = [
  { time: { elapsed: 12, extra: null }, team: { id: 66, name: "Aston Villa" },
    player: { id: 1, name: "E. Konsa" }, type: "Card", detail: "Yellow Card", comments: null },
  { time: { elapsed: 26, extra: null }, team: { id: 51, name: "Brighton" },
    player: { id: 2, name: "J. Ferguson" }, type: "Goal", detail: "Penalty", comments: null },
  { time: { elapsed: 26, extra: null }, team: { id: 51, name: "Brighton" },
    player: { id: null, name: null }, type: "Var", detail: "Penalty confirmed", comments: null },
  { time: { elapsed: 54, extra: null }, team: { id: 66, name: "Aston Villa" },
    player: { id: 3, name: "O. Watkins" }, type: "Goal", detail: "Normal Goal", comments: null },
  { time: { elapsed: 55, extra: null }, team: { id: 66, name: "Aston Villa" },
    player: { id: null, name: null }, type: "Var", detail: "Goal cancelled", comments: null },
  { time: { elapsed: 71, extra: null }, team: { id: 51, name: "Brighton" },
    player: { id: 4, name: "P. Estupinan" }, type: "Goal", detail: "Missed Penalty", comments: null },
  { time: { elapsed: 84, extra: null }, team: { id: 66, name: "Aston Villa" },
    player: { id: 1, name: "E. Konsa" }, type: "Card", detail: "Second Yellow card", comments: null },
  { time: { elapsed: 88, extra: null }, team: { id: 51, name: "Brighton" },
    player: { id: 5, name: "L. Dunk" }, type: "Card", detail: "Yellow Card", comments: null },
  { time: { elapsed: 90, extra: 3 }, team: { id: 51, name: "Brighton" },
    player: { id: null, name: null }, type: "Var", detail: "Handball reviewed on the spot", comments: null },
];

const fixture: AfFixtureResponse = {
  fixture: { id: 1035037, referee: "Björn Kuipers, Netherlands",
    date: "2026-09-05T14:00:00+00:00", status: { long: "Match Finished", short: "FT", elapsed: 90 } },
  league: { id: 39, name: "Premier League", country: "England", season: 2026, round: "Regular Season - 4" },
  teams: { home: { id: 66, name: "Aston Villa" }, away: { id: 51, name: "Brighton" } },
  goals: { home: 0, away: 1 },
  score: { fulltime: { home: 0, away: 1 } },
};

const match = adaptApiFootball(fixture, events);
const result = runRules(match);

for (const d of result.decisions) {
  const t = d.minute ? `${String(d.minute).padStart(2)}'` : " — ";
  console.log(`  ${t} [tier ${d.tier}] ${d.type.padEnd(16)} ${d.label}`);
  console.log(`        ${d.ruleId}`);
  console.log(`        ${d.tierReasons.join("  ·  ")}`);
  if (d.varNote) console.log(`        VAR: ${d.varNote}`);
}
console.log(`\n  extracted ${result.stats.extracted}, VAR folded into host calls: ${result.stats.varFolded}, published ${result.stats.published}`);
if (result.warnings.length) console.log("  warnings:\n   -", result.warnings.join("\n   - "));

// ---------------------------------------------------------------------------
line("3. Referee identity — name normalization");

const store = new InMemoryRefereeStore();
const resolver = new RefereeResolver(store);

// Seed from football-data, the definitive source.
const seed: Official[] = [
  { providerId: 43918, name: "François Letexier", role: "REFEREE", nationality: "France" },
  { providerId: 11431, name: "Michael Oliver", role: "REFEREE", nationality: "England" },
  { providerId: 11445, name: "Michael Salisbury", role: "REFEREE", nationality: "England" },
  { providerId: 9200, name: "Björn Kuipers", role: "REFEREE", nationality: "Netherlands" },
];
for (const o of seed) resolver.resolveByOfficial(o);
console.log(`  seeded ${store.all().length} referees from football-data ids`);

const probes: [string, string][] = [
  ["Björn Kuipers, Netherlands", "exact, with country suffix"],
  ["Bjorn Kuipers", "diacritics stripped"],
  ["B. Kuipers", "initial form"],
  ["Francois Letexier, France", "accent dropped by provider"],
  ["M. Oliver", "initial that fits two Michaels"],
  ["Michael Oliver", "full name, unambiguous"],
  ["Michael Salisbury", "the other Michael"],
  ["Slavko Vincic, Slovenia", "never seen before"],
];

for (const [raw, why] of probes) {
  const r = resolver.resolveByName(raw);
  const name = r.referee ? r.referee.canonicalName : "—";
  const flag = r.blocked ? "BLOCKED" : "ok";
  console.log(`  ${raw.padEnd(30)} ${r.confidence.padEnd(14)} ${String(r.score.toFixed(3)).padStart(6)}  ${name.padEnd(20)} ${flag}`);
  console.log(`      ${why} :: ${r.reason}`);
  if (r.rivals.length) {
    console.log(`      rivals: ${r.rivals.map((x) => `${x.name} ${x.score.toFixed(3)}`).join(", ")}`);
  }
}

// ---------------------------------------------------------------------------
line("4. Cross-provider fixture linking");

const fdCandidates: FdMatchLite[] = [
  { id: 500001, utcDate: "2026-09-05T14:00:00Z", status: "FINISHED",
    competition: { name: "Premier League", code: "PL" }, season: { id: 2026 },
    homeTeam: { id: 58, name: "Aston Villa FC", shortName: "Aston Villa" },
    awayTeam: { id: 397, name: "Brighton & Hove Albion FC", shortName: "Brighton Hove" },
    score: { fullTime: { home: 0, away: 1 } },
    referees: [
      { id: 9200, name: "Björn Kuipers", type: "REFEREE", nationality: "Netherlands" },
      { id: 57073, name: "Jérémie Pignard", type: "VIDEO_ASSISTANT_REFEREE_N1", nationality: "France" },
    ] },
  { id: 500002, utcDate: "2026-09-05T14:00:00Z", status: "FINISHED",
    competition: { name: "Premier League", code: "PL" }, season: { id: 2026 },
    homeTeam: { id: 61, name: "Chelsea FC", shortName: "Chelsea" },
    awayTeam: { id: 397, name: "Brighton & Hove Albion FC", shortName: "Brighton Hove" },
    score: { fullTime: { home: 2, away: 2 } },
    referees: [{ id: 11431, name: "Michael Oliver", type: "REFEREE", nationality: "England" }] },
];

for (const fd of fdCandidates) {
  const l = linkFixture(match, fd);
  console.log(`  vs ${fd.homeTeam.shortName} v ${fd.awayTeam.shortName}: ${l.score.toFixed(3)} ${l.linked ? "LINKED" : "rejected"} (${l.reasons.join(", ")})`);
}

const found = findOfficials(match, fdCandidates);
console.log(`\n  officials attached: ${found.officials.map((o) => `${o.name} [${o.role}]`).join(", ") || "none"}`);

const main = found.officials.find((o) => o.role === "REFEREE");
if (main) {
  const r = resolver.resolveByOfficial(main, match.refereeRaw);
  console.log(`  resolved: ${r.referee!.canonicalName} (${r.confidence}) — ${r.reason}`);
  console.log(`  aliases now: ${r.referee!.aliases.join(" | ")}`);
}
