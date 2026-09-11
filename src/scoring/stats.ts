/**
 * refcentral — statistical primitives
 *
 * Three operations, applied in this order, and the order is the design:
 *
 *   1. TRIM   per bucket, not on the pooled votes
 *   2. WEIGHT combine buckets by allegiance weight × sample size
 *   3. SHRINK pull toward a prior until the sample earns its position
 *
 * Trimming per bucket rather than pooled is the part worth defending. If
 * 4,000 home fans rate a penalty 0 and 300 neutrals rate it 3.5, trimming the
 * pooled set at 8% removes 340 votes off each end and leaves the result still
 * dominated by the pile. Trimming inside each bucket removes the extremists
 * from each group separately, and then the weighting does the work it was
 * designed to do. Pooled trimming would quietly undo the neutral weighting.
 */

/**
 * Symmetric trimmed mean. `proportion` is dropped from each end.
 *
 * Below `minN` no trimming happens — dropping 8% of 6 votes rounds to zero
 * anyway, and pretending otherwise just adds a branch that never fires.
 */
export function trimmedMean(
  values: number[],
  proportion = 0.08,
  minN = 25
): { mean: number | null; nTrimmed: number } {
  if (values.length === 0) return { mean: null, nTrimmed: 0 };

  if (values.length < minN) {
    const mean = values.reduce((a, b) => a + b, 0) / values.length;
    return { mean, nTrimmed: values.length };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const cut = Math.floor(sorted.length * proportion);
  const kept = cut > 0 ? sorted.slice(cut, sorted.length - cut) : sorted;
  if (kept.length === 0) {
    const mean = sorted.reduce((a, b) => a + b, 0) / sorted.length;
    return { mean, nTrimmed: sorted.length };
  }
  return { mean: kept.reduce((a, b) => a + b, 0) / kept.length, nTrimmed: kept.length };
}

/**
 * Shrinks an observed mean toward a prior.
 *
 *   result = (observed × n + prior × m) / (n + m)
 *
 * `m` is the number of notional prior observations — how many real votes it
 * takes before the observed mean carries as much weight as the prior. At
 * m = 40, a decision with 40 effective votes sits halfway between its own
 * mean and the prior; at 400 it's 91% its own.
 */
export function shrink(observed: number | null, n: number, prior: number, m: number): number {
  if (observed === null || n <= 0) return prior;
  return (observed * n + prior * m) / (n + m);
}

/** Share of values sitting on the extreme rails of the scale. */
export function railShare(values: number[], lo = 0.25, hi = 4.75): number {
  if (values.length === 0) return 0;
  const rail = values.filter((v) => v <= lo || v >= hi).length;
  return rail / values.length;
}

/**
 * Combines bucket means into one number, weighting each bucket by
 * allegiance weight × the number of people in it.
 *
 * A bucket with 3,000 partisans at weight 0.4 contributes 1,200 effective
 * votes; 300 neutrals at 1.0 contribute 300. The partisans still win on raw
 * mass — the weighting narrows the gap, it doesn't erase it. That's
 * deliberate. Erasing it would mean the site reports what 300 people think
 * and calls it the crowd.
 */
export function combineBuckets(
  entries: { mean: number | null; n: number; weight: number }[]
): { combined: number | null; effectiveN: number } {
  let num = 0;
  let den = 0;
  for (const e of entries) {
    if (e.mean === null || e.n <= 0) continue;
    const w = e.weight * e.n;
    num += e.mean * w;
    den += w;
  }
  return den > 0 ? { combined: num / den, effectiveN: den } : { combined: null, effectiveN: 0 };
}

/** Last-write-wins dedupe by user. */
export function dedupeByUser<T extends { userId: string; createdAt: string }>(rows: T[]): T[] {
  const latest = new Map<string, T>();
  for (const r of rows) {
    const prev = latest.get(r.userId);
    if (!prev || r.createdAt > prev.createdAt) latest.set(r.userId, r);
  }
  return [...latest.values()];
}

export function mean(values: number[]): number | null {
  if (!values.length) return null;
  return values.reduce((a, b) => a + b, 0) / values.length;
}
