"use client";

/**
 * refcentral — write queries
 *
 * Two very different shapes, and the difference is deliberate.
 *
 * Allegiance goes through an RPC because `effective` must be computed from
 * the database's copy of the user's favourite team, never from anything the
 * browser sends. See migration 0003 — if the client could write `effective`,
 * a user would declare NEUTRAL on their own club's match and keep full 1.0
 * weight, and the whole allegiance system would be decorative.
 *
 * Ratings are a plain insert, because there is nothing to compute: the value
 * is the user's own judgement. RLS does the guarding — it requires an
 * allegiance row to already exist, the window to be open, and the account not
 * to be suspended. The primary key on (user_id, decision_id) is what makes
 * one-vote-per-person true rather than aspirational.
 */

import { anonClient } from "../supabase/client";

export type Side = "HOME" | "AWAY" | "NEUTRAL";

export interface AllegianceRow {
  fixtureId: number;
  declared: Side;
  effective: Side;
  overrideRule: string | null;
}

export async function declareAllegiance(
  fixtureId: number,
  declared: Side
): Promise<AllegianceRow> {
  const db = anonClient();
  const { data, error } = await db.rpc("declare_allegiance", {
    p_fixture_id: fixtureId,
    p_declared: declared,
  });
  if (error) throw new Error(error.message);

  const row = Array.isArray(data) ? data[0] : data;
  return {
    fixtureId: row.fixture_id,
    declared: row.declared,
    effective: row.effective,
    overrideRule: row.override_rule,
  };
}

export async function myAllegiance(fixtureId: number): Promise<AllegianceRow | null> {
  const db = anonClient();
  const { data, error } = await db
    .from("allegiance")
    .select("fixture_id, declared, effective, override_rule")
    .eq("fixture_id", fixtureId)
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    fixtureId: data.fixture_id,
    declared: data.declared,
    effective: data.effective,
    overrideRule: data.override_rule,
  };
}

export async function submitRating(
  userId: string,
  decisionId: string,
  fixtureId: number,
  value: number
): Promise<void> {
  const db = anonClient();
  const { error } = await db.from("rating").upsert(
    {
      user_id: userId,
      decision_id: decisionId,
      fixture_id: fixtureId,
      value: Math.round(value * 10) / 10,
      updated_at: new Date().toISOString(),
    },
    { onConflict: "user_id,decision_id" }
  );
  if (error) throw new Error(error.message);
}

/** The user's own ratings for a fixture, so sliders restore on return. */
export async function myRatings(fixtureId: number): Promise<Record<string, number>> {
  const db = anonClient();
  const { data, error } = await db
    .from("rating")
    .select("decision_id, value")
    .eq("fixture_id", fixtureId);
  if (error) throw new Error(error.message);

  const out: Record<string, number> = {};
  for (const r of data ?? []) out[r.decision_id] = Number(r.value);
  return out;
}

export interface TeamOption {
  id: number;
  name: string;
}

export async function allTeams(): Promise<TeamOption[]> {
  const db = anonClient();
  const { data, error } = await db.from("team").select("id, name").order("name");
  if (error) throw new Error(error.message);
  return data ?? [];
}
