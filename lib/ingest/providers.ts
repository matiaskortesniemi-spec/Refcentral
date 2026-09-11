/**
 * refcentral — provider clients
 *
 * Separate throttles per provider, because their limits differ and a shared
 * queue would pace both at the slower one.
 *
 *   API-Football   ~10/min on free, far higher on Pro. Answers HTTP 200 with
 *                  an `errors` object rather than an error status, so every
 *                  response is inspected rather than trusted.
 *   football-data  10/min on free. Answers a real 429.
 *
 * Both retry a rate limit with backoff instead of throwing, because a cron
 * that dies halfway through a matchday leaves the database in a partial state
 * that someone has to reason about later.
 */

const AF_BASE = "https://v3.football.api-sports.io";
const FD_BASE = "https://api.football-data.org/v4";

export interface Throttle {
  <T>(fn: () => Promise<T>): Promise<T>;
}

export function makeThrottle(rpm: number): Throttle {
  const gap = Math.ceil(60_000 / rpm);
  let chain: Promise<unknown> = Promise.resolve();
  return <T>(fn: () => Promise<T>): Promise<T> => {
    const run = chain.then(async () => {
      const started = Date.now();
      try {
        return await fn();
      } finally {
        const elapsed = Date.now() - started;
        if (elapsed < gap) await sleep(gap - elapsed);
      }
    });
    chain = run.catch(() => undefined);
    return run as Promise<T>;
  };
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// ---------------------------------------------------------------------------
// API-Football
// ---------------------------------------------------------------------------

interface AfEnvelope<T> {
  get: string;
  parameters: unknown;
  errors: unknown;
  results: number;
  response: T;
}

function afErrors(env: AfEnvelope<unknown>): string[] {
  const e = env.errors;
  if (!e) return [];
  if (Array.isArray(e)) return e.map(String);
  if (typeof e === "object") {
    return Object.entries(e as Record<string, unknown>).map(([k, v]) => `${k}: ${v}`);
  }
  return [String(e)];
}

export class ApiFootball {
  private throttle: Throttle;

  constructor(private key: string, rpm = Number(process.env.AF_RPM ?? 8)) {
    this.throttle = makeThrottle(rpm);
  }

  async get<T>(path: string, attempt = 0): Promise<T> {
    const { status, body } = await this.throttle(async () => {
      const res = await fetch(`${AF_BASE}${path}`, {
        headers: { "x-apisports-key": this.key },
      });
      return { status: res.status, body: (await res.json()) as AfEnvelope<T> };
    });

    const errs = afErrors(body);
    const limited =
      status === 429 || errs.some((e) => e.toLowerCase().includes("ratelimit"));

    if (limited) {
      if (attempt >= 3) throw new Error(`API-Football rate limited 4x on ${path}`);
      await sleep((attempt + 1) * 20_000);
      return this.get<T>(path, attempt + 1);
    }

    if (errs.length) {
      // Plan restrictions and bad parameters arrive here, not as HTTP errors.
      throw new Error(`API-Football ${path}: ${errs.join("; ")}`);
    }
    if (status !== 200) throw new Error(`API-Football HTTP ${status} on ${path}`);

    return body.response;
  }

  fixtures(league: number, season: number, from: string, to: string) {
    return this.get<any[]>(
      `/fixtures?league=${league}&season=${season}&from=${from}&to=${to}&status=FT`
    );
  }

  events(fixtureId: number) {
    return this.get<any[]>(`/fixtures/events?fixture=${fixtureId}`);
  }
}

// ---------------------------------------------------------------------------
// football-data.org — identity only
// ---------------------------------------------------------------------------

export class FootballData {
  private throttle: Throttle;

  constructor(private token: string, rpm = Number(process.env.FD_RPM ?? 8)) {
    this.throttle = makeThrottle(rpm);
  }

  private async get<T>(path: string, attempt = 0): Promise<T> {
    const { status, body } = await this.throttle(async () => {
      const res = await fetch(`${FD_BASE}${path}`, {
        headers: { "X-Auth-Token": this.token },
      });
      const text = await res.text();
      let parsed: unknown = null;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = { raw: text.slice(0, 200) };
      }
      return { status: res.status, body: parsed as T };
    });

    if (status === 429) {
      if (attempt >= 3) throw new Error(`football-data rate limited 4x on ${path}`);
      await sleep((attempt + 1) * 20_000);
      return this.get<T>(path, attempt + 1);
    }
    if (status !== 200) {
      throw new Error(`football-data HTTP ${status} on ${path}`);
    }
    return body;
  }

  /** One call per competition per window — cheap. */
  async finishedMatches(code: string, from: string, to: string) {
    const data = await this.get<{ matches: any[] }>(
      `/competitions/${code}/matches?status=FINISHED&dateFrom=${from}&dateTo=${to}`
    );
    return data.matches ?? [];
  }

  /** Needed per match, because referees[] isn't in the list representation. */
  match(id: number) {
    return this.get<any>(`/matches/${id}`);
  }
}
