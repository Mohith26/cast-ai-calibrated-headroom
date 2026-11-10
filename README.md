# Calibrated headroom for Cast AI's Workload Autoscaler (concept demo)

**Live demo:** https://mohith26.github.io/cast-ai-calibrated-headroom/

Unofficial concept demo by Mohith Gajjela. Not affiliated with Cast AI. Synthetic data from a seeded generator in this repo; every number on the page is computed in the browser from that data.

## What it is

A rightsizer turns usage history into a CPU/memory request. Today the safety margin is fixed: the Workload Autoscaler's standard rule is a percentile of the last 24h plus 10% overhead (p80 CPU, max memory by default), and predictive scaling adds a documented, non-configurable 15% buffer on top of its forecast. A fixed margin produces whatever miss rate the workload's noise happens to give.

**Calibrated headroom** flips that around. You choose the miss rate (the share of 5-minute samples allowed above the request, e.g. 1%), and each workload gets its own buffer, sized from the quantiles of its own recent forecast errors and corrected online so the long-run miss rate stays at the target through drift and rollouts.

The page rebuilds the Workload autoscaler workload view in the current Cast AI console and adds:

- a **Calibrated headroom** card (target selector, realized miss rate on a 7-day replay, current buffer),
- a **Calibrated** tab next to Standard and Predictive on the vertical optimization chart (usage, all three requests, and every sample that exceeded the selected request),
- a **risk vs. requested capacity** frontier for the three policy families,
- a **rolling 24h miss rate** chart around a rollout that raises CPU per request,
- a **policy-level table** across 12 workloads, plus a proposed `headroom` setting and event log entries.

## Why it matters (numbers from `node scripts/report.mjs`)

Synthetic fleet: 12 workloads, 264 pods, 14 days at 5-minute resolution; the last 7 days are the scored replay. CPU target 1%.

| | realized miss rate across the 12 workloads |
|---|---|
| Standard (p80 + 10%) | 3.27% to 16.91% (by design: p80 tolerates misses) |
| Forecast + fixed 15% buffer | 0.10% to 8.88% (8 of 12 above 1.5x a 1% target, 3 far below it) |
| **Calibrated, target 1%** | **0.79% to 1.19%** |

- **Same worst case, 46% less CPU than one fleet-wide buffer.** The smallest single buffer that keeps every workload at or under calibrated's worst case (1.19%) is +150%, costing $7,632/mo; calibrated costs $4,104/mo.
- **Matches a hindsight-tuned buffer without hindsight.** At the miss rate calibrated achieves, it requests within 3% of the best fixed buffer chosen after the fact on 11 of 12 workloads.
- **vs. tuning the percentile rule to the same risk:** $1,161/mo less across the policy (pricing at $0.031 per vCPU-hour, $0.0042 per GiB-hour; one workload is worse, see limitations).
- **Rollout response (checkout-api):** after a deploy raises CPU per request by 32%, the fixed buffer's 24h miss rate peaks at 7.3%; calibrated peaks at 2.4% and then widens until it is back under target.
- Memory (target 0.2% of samples): calibrated realizes 0.15% to 0.30% across the fleet.

## How it works

`src/headroom.js` (pure functions, used by both the page and the tests):

1. **Forecast.** A transparent seasonal-profile x level forecaster: median of the same 5-minute slot over the previous 7 days, scaled by the ratio of the last 2 hours of actual usage to the profile. Requests are flat within a 30-minute block, so the forecast used is the block maximum. This is a stand-in for Cast AI's ML forecaster, not a copy of it; the calibration layer only needs its residuals.
2. **Scores.** For every sample, score = usage / block forecast. A sliding window keeps the last 3 days of scores sorted.
3. **Conformal buffer.** Each block's request = forecast x the ceil((n+1)(1-a_t))-th smallest score (split-conformal quantile with the finite-sample correction).
4. **Adaptive correction.** After each block, a_(t+1) = a_t + gamma (a - err_t), where err_t is the share of that block's samples above the request (adaptive conformal inference, Gibbs and Candes, NeurIPS 2021). This keeps the long-run miss rate at the target for any usage sequence, with no exchangeability assumption; gamma trades reaction speed for stability (0.01 CPU, 0.004 memory).
5. **Replay.** The standard rule, forecast + fixed buffer, and calibrated are replayed on the last 7 days, and swept (percentile p50 to max, buffer 0 to 300%, target 0.2% to 12%) to draw the frontier. "Same risk" comparisons interpolate along a sweep and never extrapolate.

## Tests

```
node --test test/headroom.test.mjs     # 11 tests
node scripts/generate.mjs              # regenerates data/fleet.json (seed 20261019)
node scripts/report.mjs                # prints every headline number above
```

Tests cover: generator determinism against the committed data; the conformal order statistic; split-conformal coverage over 400 seeds; the sorted window; ACI hitting the target on all 12 workloads within the Gibbs-Candes bound (and within 0.4 pp on the replay); fixed-buffer vs calibrated spread; frontier monotonicity; near-equality with a hindsight-tuned buffer; interpolation without extrapolation; the standard p80 + 10% rule; and the budget allocator's constraint.

To run the page locally: `python3 -m http.server` in the repo root and open http://localhost:8000.

## Honest limitations

- **Synthetic data.** Patterns (daily/weekly cycles, rollout shift, batch jobs, heavy tails, growth, bursts, Markov regime switching, memory leak sawtooth) are generated, not real Cast AI telemetry. Real clusters will be noisier in other ways.
- **The forecaster is mine, not Cast AI's.** Calibration sits on top of any forecaster; with Cast AI's ML model the residuals would be smaller and the buffers tighter.
- **Not a win everywhere.** On `pricing-engine` (regime switching, 1.7x jumps) calibrated asks for more CPU than a percentile rule at the same risk, because it has to cover jumps the 2-hour level term cannot see in time. A regime-aware forecaster would fix the cause; calibration only prices it honestly.
- **Miss rate is not throttling.** CPU above request is only throttled under node contention; for memory, usage above request is eviction exposure, not an OOM unless a limit is set. The target is a knob on exposure, not a latency SLO.
- **ACI overshoots after shifts.** After the rollout the buffer widens, then sits slightly above target for about a day before loosening. A larger gamma reacts faster but oscillates more.
- **The guarantee is long-run.** The Gibbs-Candes bound is (max(a, 1-a) + gamma) / (gamma T), which is loose over one week; the empirical replay error is what the page shows.
- **Negative result kept on purpose:** a fleet risk-budget allocator (Lagrangian over per-workload cost curves) beat a uniform 1% target on its training days ($3,422 vs $3,594/mo) but lost out of sample on the replay ($4,290 vs $4,104/mo), so it is not in the UI. `allocateBudget` stays in the module with its constraint test.
- UI is a hand-built recreation of the console from public screenshots (Oct 2026 console blog post, docs.cast.ai); icons are Tabler stand-ins for Cast AI's own icon set.

## Novelty note

Checked on Nov 9-10, 2026: Cast AI docs (Workload Autoscaler overview, configuration, available settings, scaling policies, annotations reference), release notes Nov 2025 through Oct 2026, and the cast.ai blog. Cast AI ships percentile + overhead recommendations, data-sufficiency "confidence", reactive OOM overhead bumps, and predictive scaling with a fixed 15% buffer whose docs list "Fixed safety buffer - 15% overhead is non-configurable" and "Savings not yet tracked" as limitations. No page mentions a target miss rate, conformal or calibrated buffers, or a risk/cost frontier. Competitors expose a qualitative dial (StormForge's Savings / Balanced / Reliability optimization goal) rather than a calibrated miss-rate target.
