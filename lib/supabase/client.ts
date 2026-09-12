/**
 * refcentral — Supabase clients
 *
 * Two clients, and the distinction matters:
 *
 *   anonClient    the anon key, safe in the browser. Every query it makes goes
 *                 through the RLS policies in 0002_rls.sql. This is the only
 *                 client the frontend ever uses.
 *
 *   serviceClient in lib/ingest/store.ts. Bypasses RLS entirely. Cron jobs
 *                 only — it must never be imported from anything under app/.
 *
 * If you ever find yourself reaching for the service role key to make a page
 * work, the answer is a new RLS policy, not a more powerful client.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";

let cached: SupabaseClient | null = null;

export function anonClient(): SupabaseClient {
  if (cached) return cached;

  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_ANON_KEY must be set"
    );
  }

  cached = createClient(url, key, {
    auth: { persistSession: true, autoRefreshToken: true },
  });
  return cached;
}
