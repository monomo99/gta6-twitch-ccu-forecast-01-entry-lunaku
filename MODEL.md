# MODEL.md — median launch-curve forecaster

## What is forecast

Twitch's concurrent viewers in the "Grand Theft Auto VI" category (Twitch game id
1867279146) for each hour h = 2..24 of release day, 2026-11-19 UTC, as five quantiles
(0.05 / 0.25 / 0.5 / 0.75 / 0.95). Scored by mean pinball loss on the log scale.
The program runs once per case, offline, with only the case file: hour 1's print,
the category's history, and the `comparables` — 38 past launches in a practice case,
42 in the final (the four practice launches included).

## Assumptions

1. **Launch-day shape transfers across big launches.** A launch day is driven by the
   same forces everywhere: a midnight-local rolling unlock, a diurnal Twitch cycle
   (trough ~04:00–08:00 UTC, peak ~19:00–23:00 UTC), and an evening peak when the
   biggest markets overlap. The *shape* (ratio to hour 1) is far more stable than the
   absolute level, so the model is scale-free: it never hard-codes a viewer count.
2. **Hour 1 is already a launch hour for GTA VI.** The UK unlocks at 00:00 UTC and
   New Zealand / Australia / Asia have been playing since 11:00 UTC on Nov 18, so
   hour 1 (00:00–01:00 UTC) holds real launch viewership — like the kept donors,
   unlike launches with a single global unlock later in the day.
3. **Console-only, rolling-midnight launches are the closest analogs.** GTA VI is
   PS5/Xbox Series only, single-player, midnight-local unlock. Console-only donors
   get weight ×3; PC/global-unlock launches still contribute at weight ×1.
4. **The median donor is the honest centre; the donor spread is the honest width.**
   No parametric curve is imposed on the shape — the median is read off the donors
   hour by hour, then lightly smoothed so the curve is graceful rather than jagged.

## Method (as implemented in `main.ts`)

1. **Donors.** For each comparable, build its release-day (UTC) hourly map, hours
   1..24, from `day_start`. Keep a donor only if hour 1 ≥ 15% of its own release-day
   peak and ≥ 18 of the 24 hours are present. (This is the key filter: without it,
   pre-unlock hour-1 prints of a few hundred viewers make ratios explode to 100×
   and the median curve meaningless.) If fewer than 5 donors survive, relax the
   fraction to 5%, then to any; if still none, fall back to the house baseline's
   persistence formula.
2. **Ratios.** Per hour h, r = ln(viewers_h / viewers_1) for every donor that has
   the hour.
3. **Median.** The weighted median of r per hour, smoothed with a 3-point moving
   average in log space. Forecast median = p1 × exp(smoothed median), p1 = hour-1
   print (a print below 1 counts as 1).
4. **Spread.** q25/q75 = weighted quartiles of r; q05/q95 = weighted 5%/95%
   quantiles, widened by 0.15 in log space. Quantiles are clamped to (0, 1e9],
   rounded to 2 decimals, and forced non-decreasing. A donor-missing hour borrows
   its neighbours' quantiles.

## The resulting curve (ratios to hour 1)

| hour (UTC) | 2 | 3 | 4 | 5 | 8 | 12 | 15 | 18 | 19 | 20 | 21 | 22 | 23 | 24 |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| median ratio | 0.79 | 0.74 | 0.72 | 0.75 | 0.78 | 0.93 | 1.28 | 1.53 | 1.64 | 1.69 | 1.78 | 1.78 | 1.61 | 1.42 |

Dip at hour 4 (03:00–04:00 UTC: US asleep, Europe asleep, only Oceania/Asia awake),
steady climb from hour 12 as Europe wakes and the US unlocks (05:00/08:00 UTC), peak
hours 21–22 (20:00–22:00 UTC: Europe prime evening + US afternoon), gentle decline
into hour 24. For an illustrative hour-1 print of 500,000: median peak ≈ 892,000
viewers at hour 21; 90% interval at the peak ≈ 370,000–2,610,000.

## Validation — leave-one-out over the kit's comparables

Each of the 37 distinct comparable launches was held out in turn, forecast from the
other 36 with the same code path, and scored by pinball loss against its actual
release-day hours 2–24 (SullyGnome hourly averages, as shipped in the kit).

| model | loss | typical miss | 90% coverage |
|---|---|---|---|
| **This model (min-frac 0.15, console ×3, widen 0.15)** | **0.23** | ~46% | ~0.94 |
| Median-ratio, no hour-1 filter (all donors) | 0.36 | ~54% | 0.92 |
| House baseline (persistence, σ=0.15) | 0.27 | — | — |

Scores above are on the 24 "GTA-like" targets (launches whose hour 1 was already
post-unlock, the regime GTA VI is in). Across all 37 targets the model scores 0.85
vs the baseline's 0.93 — the gap is the launches with a pre-unlock hour 1, which no
hour-1-anchored model can forecast well and which GTA VI is not. Variants tested:
evening-peak-only donors, no smoothing, wider/narrower spreads, shrinking the median
toward persistence — all within ±0.01 of the chosen design, so the simplest defensible
variant was kept; further tuning would be overfitting the 24-target set.

## What the model does NOT use

- `streams` (top-20 live streams at the checkpoint) and `categories_hourly`: a
  snapshot of who is streaming, not a curve — no signal for the day's shape beyond
  hour 1 itself.
- The GTA VI category's own pre-release history (Aug 27 – Nov 17): trailer-premiere
  spikes, not launch-day behaviour.
- Any hard-coded viewer count, peak, or date: the only scale input is the case's
  own hour-1 print, read at run time.

## Data source

All donor curves are SullyGnome.com hourly Twitch category averages, as shipped in
the kit's case files (`input/p00.in`–`p03.in`, `comparables`). No additional data
was fetched.
