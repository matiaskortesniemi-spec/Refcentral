/**
 * refcentral — persistence for the ingest job
 *
 * Everything here runs with the service role key, which bypasses RLS. That is
 * correct for a cron and wrong everywhere else — this module must never be
 * imported by anything that reaches the browser.
 *
 * The referee store is the interesting part. RefereeResolver was written
 * against an in-memory store; this loads the real table into that shape at
 * the start of a run and writes changes back, so the resolver logic is
 * identical whether it's running against Postgres or a test fixture.
 */

import { createClient, SupabaseClient } from "@supabase/supabase-js";
import { RefereeRecord } from "../../src/types";
import { RefereeStore } from "../../src/referees";

export function serviceClient(): SupabaseClient {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    throw new Error(
      "NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY must be set"
    );
  }
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false },
  });
}

// ---------------------------------------------------------------------------
// Referee store
// ---------------------------------------------------------------------------

/**
 * Loads every referee and alias once, resolves in memory during the run, and
 * flushes changed records at the end. A season of officials across six
 * competitions is a few hundred rows — small enough that per-lookup queries
 * would be pure overhead.
 */
export class DbRefereeStore implements RefereeStore {
  private records = new Map<string, RefereeRecord>();
  private aliasIndex = new Map<string, string>();
  private fdIndex = new Map<number, string>();
  private dirty = new Set<string>();

  private constructor(private db: SupabaseClient) {}

  static async load(db: SupabaseClient): Promise<DbRefereeStore> {
    const store = new DbRefereeStore(db);

    const { data: refs, error: refErr } = await db
      .from("referee")
      .select("id, fd_person_id, canonical_name, country");
    if (refErr) throw new Error(`loading referees: ${refErr.message}`);

    const { data: aliases, error: aliasErr } = await db
      .from("referee_alias")
      .select("alias, referee_id");
    if (aliasErr) throw new Error(`loading aliases: ${aliasErr.message}`);

    const byId = new Map<string, string[]>();
    for (const a of aliases ?? []) {
      (byId.get(a.referee_id) ?? byId.set(a.referee_id, []).get(a.referee_id)!).push(a.alias);
    }

    for (const r of refs ?? []) {
      const rec: RefereeRecord = {
        id: r.id,
        fdPersonId: r.fd_person_id,
        canonicalName: r.canonical_name,
        country: r.country,
        aliases: byId.get(r.id) ?? [r.canonical_name],
        matchesSeen: 0,
      };
      store.records.set(rec.id, rec);
      if (rec.fdPersonId != null) store.fdIndex.set(rec.fdPersonId, rec.id);
      for (const a of rec.aliases) store.aliasIndex.set(a.trim().toLowerCase(), rec.id);
    }

    return store;
  }

  all(): RefereeRecord[] {
    return [...this.records.values()];
  }
  byFdId(fdId: number): RefereeRecord | undefined {
    const id = this.fdIndex.get(fdId);
    return id ? this.records.get(id) : undefined;
  }
  byAlias(raw: string): RefereeRecord | undefined {
    const id = this.aliasIndex.get(raw.trim().toLowerCase());
    return id ? this.records.get(id) : undefined;
  }
  save(r: RefereeRecord): void {
    this.records.set(r.id, r);
    if (r.fdPersonId != null) this.fdIndex.set(r.fdPersonId, r.id);
    for (const a of r.aliases) this.aliasIndex.set(a.trim().toLowerCase(), r.id);
    this.dirty.add(r.id);
  }

  /** Writes changed referees and any aliases they've picked up. */
  async flush(): Promise<{ referees: number; aliases: number }> {
    if (this.dirty.size === 0) return { referees: 0, aliases: 0 };

    const changed = [...this.dirty].map((id) => this.records.get(id)!);

    const { error: refErr } = await this.db.from("referee").upsert(
      changed.map((r) => ({
        id: r.id,
        fd_person_id: r.fdPersonId,
        canonical_name: r.canonicalName,
        country: r.country,
      })),
      { onConflict: "id" }
    );
    if (refErr) throw new Error(`writing referees: ${refErr.message}`);

    const aliasRows = changed.flatMap((r) =>
      r.aliases.map((a) => ({
        alias: a.trim().toLowerCase(),
        referee_id: r.id,
        source: r.fdPersonId != null ? "FOOTBALL_DATA" : "API_FOOTBALL",
      }))
    );

    const { error: aliasErr } = await this.db
      .from("referee_alias")
      .upsert(aliasRows, { onConflict: "alias" });
    if (aliasErr) throw new Error(`writing aliases: ${aliasErr.message}`);

    const counts = { referees: changed.length, aliases: aliasRows.length };
    this.dirty.clear();
    return counts;
  }
}

// ---------------------------------------------------------------------------
// Teams
// ---------------------------------------------------------------------------

/**
 * Teams arrive from API-Football during ingest and from football-data during
 * linking. We key on af_team_id and fill fd_team_id opportunistically, so the
 * mapping table builds itself rather than needing a seeding script.
 */
export class TeamCache {
  private byAf = new Map<number, number>();

  constructor(private db: SupabaseClient) {}

  async preload(): Promise<void> {
    const { data, error } = await this.db.from("team").select("id, af_team_id");
    if (error) throw new Error(`loading teams: ${error.message}`);
    for (const t of data ?? []) {
      if (t.af_team_id != null) this.byAf.set(t.af_team_id, t.id);
    }
  }

  async ensure(afId: number, name: string): Promise<number> {
    const existing = this.byAf.get(afId);
    if (existing) return existing;

    const { data, error } = await this.db
      .from("team")
      .upsert({ af_team_id: afId, name }, { onConflict: "af_team_id" })
      .select("id")
      .single();
    if (error) throw new Error(`upserting team ${name}: ${error.message}`);

    this.byAf.set(afId, data.id);
    return data.id;
  }

  /** Records the football-data id once a fixture link tells us what it is. */
  async linkFd(afId: number, fdId: number): Promise<void> {
    const id = this.byAf.get(afId);
    if (!id) return;
    await this.db.from("team").update({ fd_team_id: fdId }).eq("id", id).is("fd_team_id", null);
  }
}

// ---------------------------------------------------------------------------
// Job runs
// ---------------------------------------------------------------------------

export async function startRun(
  db: SupabaseClient,
  job: string,
  from: string,
  to: string
): Promise<number | null> {
  const { data, error } = await db
    .from("job_run")
    .insert({ job, window_from: from, window_to: to })
    .select("id")
    .single();
  if (error) {
    console.warn(`could not record job_run: ${error.message}`);
    return null;
  }
  return data.id;
}

export async function finishRun(
  db: SupabaseClient,
  id: number | null,
  ok: boolean,
  stats: unknown,
  error?: string
): Promise<void> {
  if (id == null) return;
  await db
    .from("job_run")
    .update({ finished_at: new Date().toISOString(), ok, stats, error: error ?? null })
    .eq("id", id);
}
