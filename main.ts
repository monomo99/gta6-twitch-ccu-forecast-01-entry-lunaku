// gta6-twitch-ccu-forecast-01 — median launch-curve forecaster (Node 22, standard library only).
//
// Forecast: for each hour h = 2..24 of GTA VI's release day (2026-11-19 UTC), five quantiles
// of Twitch's concurrent viewers in the "Grand Theft Auto VI" category, as a ratio to hour 1's
// print. The program runs offline in the grader's sandbox: everything it knows is in the case
// file — above all the `comparables`, 38-42 past big game launches' hourly Twitch category
// averages (SullyGnome) from 14 days before to 3 days after their release day.
//
// MODEL (see MODEL.md for the full write-up and the leave-one-out validation)
// ---------------------------------------------------------------------------
// 1. DONORS. For every comparable, take its release-day (UTC) hourly curve, hours 1..24.
//    Keep a donor only when its launch had already started in hour 1: hour-1 viewers are at
//    least 15% of that launch's own release-day peak, and at least 18 of the 24 hours are
//    present. This drops launches whose hour 1 was still pre-unlock (a single global unlock
//    later in the day), where the ratio to hour 1 explodes to 100x and poisons the median.
//    GTA VI unlocks at midnight local, rolling (NZ 11:00Z Nov 18, UK 00:00Z, US East 05:00Z,
//    US West 08:00Z), so its hour 1 is already a real launch hour, like the kept donors'.
// 2. RATIO. For each hour h, work in log space: r = ln(viewers_h / viewers_1). The ratio is
//    scale-free, so the biggest launch ever can be forecast from the shape of smaller ones.
// 3. WEIGHTED MEDIAN. Per hour, the weighted median of r across donors, console-only
//    launches (PlayStation/Xbox, no PC) weighted x3 — they share GTA VI's console-only,
//    rolling-midnight-local unlock. The median is then lightly smoothed (3-point moving
//    average in log space) so the curve is graceful, not jagged.
// 4. SPREAD. The 5%/25%/75%/95% quantiles are the weighted quantiles of the same donor
//    distribution at that hour; the outer pair is widened by 0.15 in log space, which the
//    validation showed lifts 90% coverage to ~0.92 at no cost in pinball loss.
//    The resulting median curve: a dip to ~0.72x at hour 4 (the early-morning UTC trough,
//    US asleep, Europe asleep), a steady climb as Europe wakes and the US unlocks, a peak
//    of ~1.8x at hours 21-22 (20:00-22:00 UTC: Europe prime evening + US afternoon), then
//    a gentle decline into hour 24.
// 5. FALLBACKS. If fewer than 5 donors pass the filter, relax it (15% -> 5% -> any); if
//    still none, fall back to the house baseline's persistence formula. Hour 1's print
//    below 1 counts as 1, as the rules require.
//
// VALIDATION (leave-one-out over the 37 comparable launches in the kit; GTA-like targets
// only, i.e. launches whose hour 1 was already post-unlock): mean pinball loss 0.23,
// typical miss ~46%, 90% coverage ~0.94 — against the house baseline's 0.27 on the same
// targets. Full numbers in MODEL.md.
//
// I/O contract (RULES.txt): read every <id>.in in the input directory
// ($MAKEFUN_INPUT_DIR, else /input), write <id>.out to the output directory
// ($MAKEFUN_OUTPUT_DIR, else /output): {"hours":[{"hour":2,"q":[q05,q25,q50,q75,q95]}, ...]},
// exactly 23 rows, hours 2..24 each once, each q a finite number in (0, 1e9], non-decreasing.
// Deterministic: no randomness, no clock, no network; two runs write identical bytes.

import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const INPUT_DIR = process.env.MAKEFUN_INPUT_DIR ?? '/input';
const OUTPUT_DIR = process.env.MAKEFUN_OUTPUT_DIR ?? '/output';

/** The quantile levels the contest scores, in the order each row lists them. */
const LEVELS = [0.05, 0.25, 0.5, 0.75, 0.95];
/** The standard normal's quantile at each level (baseline fallback only). */
const Z = [-1.6448536269514722, -0.6744897501960817, 0, 0.6744897501960817, 1.6448536269514722];
/** Baseline fallback spread, in log units per square-root hour (the house baseline's 0.15). */
const BASELINE_SIGMA = 0.15;
/** A donor counts only when hour 1 is at least this share of its own release-day peak. */
const MIN_HOUR1_FRACTION = 0.15;
/** A donor counts only with at least this many valid release-day hours. */
const MIN_VALID_HOURS = 18;
/** Minimum donors before the filter is relaxed. */
const MIN_DONORS = 5;
/** Extra weight for console-only launches (PlayStation/Xbox, no PC). */
const CONSOLE_WEIGHT = 3;
/** Extra log-space widening of the 5% / 95% quantiles. */
const OUTER_WIDEN = 0.15;

interface CaseFile {
  id: string;
  levels: number[];
  known: Array<{ hour: number; viewers: number }>;
  forecast: Array<{ hour: number }>;
  comparables?: Array<{
    name: string;
    day_start: string;
    platforms: string;
    hourly: Array<{ from: string; viewers: number }>;
  }>;
}

interface Donor {
  /** Release-day viewers by UTC hour (1..24). */
  byHour: Map<number, number>;
  /** Hour-1 viewers as a share of the release-day peak. */
  hour1Fraction: number;
  /** Weight: console-only launches count extra. */
  weight: number;
}

/** x rounded to 2 decimals (half up). */
const round2 = (x: number): number => Math.round(x * 100) / 100;

/** Weighted quantile of [value, weight] pairs, with linear interpolation. */
function weightedQuantile(pairs: Array<[number, number]>, q: number): number {
  const sorted = [...pairs].sort((a, b) => a[0] - b[0]);
  const total = sorted.reduce((sum, [, w]) => sum + w, 0);
  const target = q * total;
  let acc = 0;
  for (let i = 0; i < sorted.length; i++) {
    acc += sorted[i][1];
    if (acc >= target) {
      if (i === 0) return sorted[0][0];
      const [prevValue] = sorted[i - 1];
      const frac = (target - (acc - sorted[i][1])) / sorted[i][1];
      return prevValue + (sorted[i][0] - prevValue) * frac;
    }
  }
  return sorted[sorted.length - 1][0];
}

/** 3-point moving average; the ends reuse their neighbour. */
function smooth(values: number[]): number[] {
  return values.map((v, i) => {
    const a = values[Math.max(0, i - 1)];
    const c = values[Math.min(values.length - 1, i + 1)];
    return (a + v + c) / 3;
  });
}

/** A comparable's release-day curve, or null when it cannot be read. */
function donorCurve(comp: NonNullable<CaseFile['comparables']>[number]): Donor | null {
  const dayStart = Date.parse(comp.day_start);
  if (Number.isNaN(dayStart)) return null;
  const byHour = new Map<number, number>();
  for (const point of comp.hourly ?? []) {
    if (typeof point.viewers !== 'number' || point.viewers <= 0) continue;
    const hour = Math.round((Date.parse(point.from) - dayStart) / 3600000) + 1;
    if (hour >= 1 && hour <= 24 && !byHour.has(hour)) byHour.set(hour, point.viewers);
  }
  if (!byHour.has(1) || byHour.size < MIN_VALID_HOURS) return null;
  const peak = Math.max(...byHour.values());
  const hour1Fraction = byHour.get(1)! / peak;
  const consoleOnly =
    /PS5|PS4|PlayStation|Xbox/i.test(comp.platforms ?? '') && !/\bPC\b/i.test(comp.platforms ?? '');
  return { byHour, hour1Fraction, weight: consoleOnly ? CONSOLE_WEIGHT : 1 };
}

/** Donors that pass the hour-1 filter, relaxing it when too few survive. */
function selectDonors(comps: NonNullable<CaseFile['comparables']>): Donor[] {
  const all = comps.map(donorCurve).filter((d): d is Donor => d !== null);
  for (const minFraction of [MIN_HOUR1_FRACTION, 0.05, 0]) {
    const kept = all.filter((d) => d.hour1Fraction >= minFraction);
    if (kept.length >= MIN_DONORS) return kept;
  }
  return all;
}

/**
 * The five log-ratio quantiles for one hour, from the donors' ratios to their hour 1.
 * Returns [q05, q25, q50, q75, q95] in log space, or null when no donor has this hour.
 */
function hourLogQuantiles(donors: Donor[], hour: number): number[] | null {
  const pairs: Array<[number, number]> = [];
  for (const d of donors) {
    const v1 = d.byHour.get(1)!;
    const vh = d.byHour.get(hour);
    if (vh !== undefined) pairs.push([Math.log(vh / v1), d.weight]);
  }
  if (pairs.length === 0) return null;
  return [
    weightedQuantile(pairs, 0.05) - OUTER_WIDEN,
    weightedQuantile(pairs, 0.25),
    weightedQuantile(pairs, 0.5),
    weightedQuantile(pairs, 0.75),
    weightedQuantile(pairs, 0.95) + OUTER_WIDEN,
  ];
}

/** The house baseline's persistence forecast, used only when no donor survives. */
function baselineQuantiles(p1: number, hour: number): number[] {
  return Z.map((z) => round2(p1 * Math.exp(z * BASELINE_SIGMA * Math.sqrt(hour - 1))));
}

/** Forecast one case: 23 rows of five quantiles, hours 2..24. */
function forecastCase(c: CaseFile): Array<{ hour: number; q: number[] }> {
  const first = c.known.find((k) => k.hour === 1);
  if (first === undefined) throw new Error(`${c.id} has no hour-1 print`);
  const p1 = Math.max(1, first.viewers);
  const donors = selectDonors(c.comparables ?? []);

  // Per-hour log quantiles from the donors; a missing hour borrows its neighbours.
  const raw: Array<number[] | null> = [];
  for (let h = 2; h <= 24; h++) raw.push(hourLogQuantiles(donors, h));
  for (let i = 0; i < raw.length; i++) {
    if (raw[i] !== null) continue;
    const prev = [...raw.slice(0, i)].reverse().find((r) => r !== null);
    const next = raw.slice(i + 1).find((r) => r !== null);
    raw[i] = prev !== undefined && prev !== null && next !== undefined && next !== null
      ? prev.map((v, j) => (v + next[j]) / 2)
      : prev ?? next ?? [0, 0, 0, 0, 0];
  }
  // Smooth only the median (index 2); the spread quantiles stay as measured.
  const medians = smooth((raw as number[][]).map((r) => r[2]));
  return c.forecast.map(({ hour }) => {
    const i = hour - 2;
    const logQ = raw[i] as number[];
    let q: number[];
    if (donors.length === 0) {
      q = baselineQuantiles(p1, hour);
    } else {
      q = [logQ[0], logQ[1], medians[i], logQ[3], logQ[4]].map((x) => p1 * Math.exp(x));
    }
    // Clamp to the legal range, round, and enforce non-decreasing quantiles.
    q = q.map((x) => Math.min(1e9, Math.max(0.01, round2(x))));
    for (let j = 1; j < q.length; j++) q[j] = Math.max(q[j], q[j - 1]);
    return { hour, q };
  });
}

mkdirSync(OUTPUT_DIR, { recursive: true });
// Every case file, in name order, so two runs write the same bytes.
const inputs = readdirSync(INPUT_DIR).filter((f) => f.endsWith('.in')).sort();
for (const file of inputs) {
  const id = file.slice(0, -'.in'.length);
  const c = JSON.parse(readFileSync(join(INPUT_DIR, file), 'utf8')) as CaseFile;
  if (c.levels.length !== LEVELS.length || c.levels.some((t, j) => t !== LEVELS[j])) {
    throw new Error(`${file} asks for levels ${JSON.stringify(c.levels)}, not ${JSON.stringify(LEVELS)}`);
  }
  const hours = forecastCase(c);
  if (hours.length !== 23) throw new Error(`${file}: forecast ${hours.length} rows, not 23`);
  writeFileSync(join(OUTPUT_DIR, `${id}.out`), `${JSON.stringify({ hours })}\n`);
}
