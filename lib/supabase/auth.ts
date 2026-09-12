"use client";

/**
 * refcentral — auth
 *
 * Magic link only. No passwords anywhere in this codebase — Supabase Auth
 * owns credentials, and the one thing we store is the uuid it gives back.
 *
 * Sign-in exists here for one reason: every anti-bias mechanism in the
 * project assumes one person is one rater. One vote per decision, allegiance
 * weighting, and the new-account signal in the brigade detector all need a
 * stable identity. Without it the loudest fanbase writes the scores.
 */

import { useEffect, useState } from "react";
import { Session } from "@supabase/supabase-js";
import { anonClient } from "./client";

export function useSession() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    const db = anonClient();
    db.auth.getSession().then(({ data }) => {
      setSession(data.session);
      setLoading(false);
    });
    const { data: sub } = db.auth.onAuthStateChange((_e, s) => setSession(s));
    return () => sub.subscription.unsubscribe();
  }, []);

  return { session, loading };
}

export async function sendMagicLink(email: string): Promise<void> {
  const db = anonClient();
  const { error } = await db.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: window.location.origin },
  });
  if (error) throw new Error(error.message);
}

export async function signOut(): Promise<void> {
  await anonClient().auth.signOut();
}

/** The user's own profile row, created by trigger at signup. */
export interface Profile {
  id: string;
  favouriteTeamId: number | null;
  favouriteChanges: number;
}

export async function loadProfile(): Promise<Profile | null> {
  const db = anonClient();
  const { data, error } = await db
    .from("app_user")
    .select("id, favourite_team_id, favourite_changes")
    .maybeSingle();
  if (error) throw new Error(error.message);
  if (!data) return null;
  return {
    id: data.id,
    favouriteTeamId: data.favourite_team_id,
    favouriteChanges: data.favourite_changes,
  };
}

export async function setFavouriteTeam(teamId: number | null): Promise<void> {
  const db = anonClient();
  const { error } = await db.rpc("set_favourite_team", { p_team_id: teamId });
  if (error) throw new Error(error.message);
}
