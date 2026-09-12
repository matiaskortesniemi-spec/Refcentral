"use client";

/**
 * refcentral — rating UI
 *
 * Three components, in the order a user meets them: sign in, declare who they
 * were watching as, then rate each call.
 *
 * The ordering is enforced by the database, not by this file. A rating insert
 * without an allegiance row is rejected by the RLS policy in 0002, so the UI
 * can't accidentally create an unweighted vote even if it has a bug.
 */

import { useEffect, useState } from "react";
import { sendMagicLink, signInWithGoogle, signOut, Profile, setFavouriteTeam } from "@/lib/supabase/auth";
import {
  declareAllegiance, myAllegiance, submitRating, AllegianceRow, Side, TeamOption,
} from "@/lib/queries/write";
import { AverageMarker } from "./display";

// ---------------------------------------------------------------------------

export function SignIn() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  if (sent) {
    return (
      <div className="signin-box">
        <h2>Check your email</h2>
        <p>
          A sign-in link is on its way to {email}. It expires in an hour, and opening it signs
          you in on this device.
        </p>
      </div>
    );
  }

  return (
    <div className="signin-box">
      <h2>Sign in to rate</h2>
      <p>
        One account, one rating per decision. That constraint is what makes the weighting mean
        anything — without it, the loudest fanbase writes every score.
      </p>
      <button
        className="btn btn-google"
        disabled={busy}
        onClick={async () => {
          setError(null);
          try {
            await signInWithGoogle();
          } catch (e: any) {
            setError(e.message ?? String(e));
          }
        }}
      >
        <GoogleMark />
        Continue with Google
      </button>

      <div className="or-line">
        <span>or use email</span>
      </div>

      <div className="signin-row">
        <input
          type="email"
          value={email}
          onChange={(e) => setEmail(e.target.value)}
          placeholder="you@example.com"
          aria-label="Email address"
        />
        <button
          className="btn"
          disabled={busy || !email.includes("@")}
          onClick={async () => {
            setBusy(true);
            setError(null);
            try {
              await sendMagicLink(email);
              setSent(true);
            } catch (e: any) {
              setError(e.message ?? String(e));
            } finally {
              setBusy(false);
            }
          }}
        >
          {busy ? "Sending…" : "Email me a link"}
        </button>
      </div>
      <p className="fineprint">No password. We email a one-time link.</p>
      {error && <p className="err">{error}</p>}
    </div>
  );
}

function GoogleMark() {
  return (
    <svg viewBox="0 0 18 18" width="17" height="17" aria-hidden="true">
      <path fill="#4285F4" d="M17.64 9.2c0-.64-.06-1.25-.16-1.84H9v3.48h4.84a4.14 4.14 0 0 1-1.8 2.72v2.26h2.92c1.7-1.57 2.68-3.88 2.68-6.62z" />
      <path fill="#34A853" d="M9 18c2.43 0 4.47-.8 5.96-2.18l-2.92-2.26c-.8.54-1.84.86-3.04.86-2.34 0-4.32-1.58-5.03-3.7H.96v2.33A9 9 0 0 0 9 18z" />
      <path fill="#FBBC05" d="M3.97 10.72a5.4 5.4 0 0 1 0-3.44V4.95H.96a9 9 0 0 0 0 8.1l3.01-2.33z" />
      <path fill="#EA4335" d="M9 3.58c1.32 0 2.5.45 3.44 1.35l2.58-2.58A9 9 0 0 0 .96 4.95l3.01 2.33C4.68 5.16 6.66 3.58 9 3.58z" />
    </svg>
  );
}

export function AccountBar({ email, profile }: { email: string; profile: Profile | null }) {
  return (
    <div className="account-bar">
      <span>
        Signed in as {email}
        {profile?.favouriteTeamId == null && " · no club set"}
      </span>
      <button className="linkbtn" onClick={() => signOut()}>
        Sign out
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------

export function FavouritePicker({
  teams,
  profile,
  onChange,
}: {
  teams: TeamOption[];
  profile: Profile | null;
  onChange: () => void;
}) {
  const [error, setError] = useState<string | null>(null);
  const current = profile?.favouriteTeamId ?? "";

  return (
    <div className="fav">
      <label htmlFor="fav-select">Your club (optional)</label>
      <select
        id="fav-select"
        value={current}
        onChange={async (e) => {
          setError(null);
          const v = e.target.value ? Number(e.target.value) : null;
          try {
            await setFavouriteTeam(v);
            onChange();
          } catch (err: any) {
            setError(err.message ?? String(err));
          }
        }}
      >
        <option value="">Prefer not to say</option>
        {teams.map((t) => (
          <option key={t.id} value={t.id}>
            {t.name}
          </option>
        ))}
      </select>
      <p className="fineprint">
        Used to pre-select your side on your club&apos;s matches, so declaring honestly is the
        easy path rather than a cost. It never weights a match your club isn&apos;t in.
      </p>
      {error && <p className="err">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function AllegiancePicker({
  fixtureId,
  home,
  away,
  suggested,
  onDeclared,
}: {
  fixtureId: number;
  home: string;
  away: string;
  suggested: Side;
  onDeclared: (row: AllegianceRow) => void;
}) {
  const [row, setRow] = useState<AllegianceRow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    myAllegiance(fixtureId)
      .then((r) => {
        if (r) {
          setRow(r);
          onDeclared(r);
        }
      })
      .catch(() => undefined);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fixtureId]);

  const choose = async (side: Side) => {
    setBusy(true);
    setError(null);
    try {
      const r = await declareAllegiance(fixtureId, side);
      setRow(r);
      onDeclared(r);
    } catch (e: any) {
      setError(e.message ?? String(e));
    } finally {
      setBusy(false);
    }
  };

  const active = row?.declared ?? suggested;

  return (
    <div className="allegiance">
      <p>Before you rate, who were you watching as?</p>
      <div className="choices">
        {(["HOME", "AWAY", "NEUTRAL"] as Side[]).map((side) => (
          <button
            key={side}
            className="choice"
            aria-pressed={active === side}
            disabled={busy}
            onClick={() => choose(side)}
          >
            {side === "HOME" ? home : side === "AWAY" ? away : "Neither"}
          </button>
        ))}
      </div>

      {row && (
        <div className="weight-note">
          {row.effective === "NEUTRAL" ? (
            <>
              Your ratings count at <b>full weight</b>. Neutral ratings are the spine of every
              score here.
            </>
          ) : (
            <>
              Your ratings count at <b>0.4 weight</b> and are reported separately from the
              neutral figure.
            </>
          )}
          {row.overrideRule && (
            <div className="override">
              You declared {row.declared.toLowerCase()}, but your club is playing, so this is
              recorded as a supporter rating.
            </div>
          )}
        </div>
      )}

      {!row && <div className="weight-note">Pick one to start rating.</div>}
      {error && <p className="err">{error}</p>}
    </div>
  );
}

// ---------------------------------------------------------------------------

export function RatingSlider({
  userId,
  fixtureId,
  decisionId,
  initial,
  disabled,
  communityScore,
}: {
  userId: string;
  fixtureId: number;
  decisionId: string;
  initial: number | undefined;
  disabled: boolean;
  /** Shown as a grey marker on the track, so you can see the anchor. */
  communityScore: number | null;
}) {
  const [value, setValue] = useState<number | undefined>(initial);
  const [saved, setSaved] = useState(initial !== undefined);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    setValue(initial);
    setSaved(initial !== undefined);
  }, [initial, decisionId]);

  const commit = async (v: number) => {
    try {
      await submitRating(userId, decisionId, fixtureId, v);
      setSaved(true);
      setError(null);
    } catch (e: any) {
      setError(e.message ?? String(e));
      setSaved(false);
    }
  };

  return (
    <>
      <div className="slider-row">
        <span className="slider-stack">
          <AverageMarker score={communityScore} />
          <input
            type="range"
            min={0}
            max={5}
            step={0.1}
            value={value ?? 2.5}
            disabled={disabled}
            aria-label="Rate this decision from 0 to 5"
            onChange={(e) => {
              setValue(Number(e.target.value));
              setSaved(false);
            }}
            onPointerUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
            onKeyUp={(e) => commit(Number((e.target as HTMLInputElement).value))}
          />
        </span>
        <span className={`myval ${value === undefined ? "unset" : ""}`}>
          {value === undefined ? "–" : value.toFixed(1)}
        </span>
      </div>
      {disabled && <div className="unscored">Declare who you were watching as to rate.</div>}
      {!disabled && saved && value !== undefined && (
        <div className="saved">Saved. Publishes with the next scoring run.</div>
      )}
      {error && <p className="err">{error}</p>}
    </>
  );
}
