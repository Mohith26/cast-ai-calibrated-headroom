// Calibrated headroom: core algorithms (pure functions, no DOM). Runs in the browser and under `node --test`.
//
// A rightsizer turns a usage history into a request. Today's rules add a fixed safety margin
// (percentile + 10% overhead, or a forecast + fixed 15% buffer). The miss rate those margins
// produce is whatever the workload's noise happens to be. Here the user picks the miss rate
// (share of 5-minute samples where usage exceeds the request) and the buffer is sized per
// workload by adaptive conformal inference (Gibbs & Candes, NeurIPS 2021) on the forecaster's
// own multiplicative residuals, which keeps the long-run miss rate at the target even when the
// workload drifts or a deploy shifts its level.

export const SAMPLES_PER_DAY = 288; // 5-minute samples
export const BLOCK = 6; // recommendations re-applied every 30 minutes (6 samples)
export const PRICE = { vcpuHour: 0.031, gibHour: 0.0042, hoursPerMonth: 730 };

// Periods (sample indices) for a 14-day history.
export const PERIODS = {
  forecastFrom: 1 * SAMPLES_PER_DAY, // first day only feeds the seasonal profile
  calibrateFrom: 4 * SAMPLES_PER_DAY, // 3 days of residuals before buffers are trusted
  replayFrom: 7 * SAMPLES_PER_DAY, // last 7 days are the replay we score
};

// ---------- small statistics helpers ----------
export function median(arr) {
  if (!arr.length) return NaN;
  const s = Float64Array.from(arr).sort();
  const m = s.length >> 1;
  return s.length % 2 ? s[m] : 0.5 * (s[m - 1] + s[m]);
}

/** Type-7 percentile (what dashboards usually mean by p80). p in [0,100]. */
export function percentile(arr, p) {
  const s = Float64Array.from(arr).sort();
  if (!s.length) return NaN;
  if (p >= 100) return s[s.length - 1];
  const h = (s.length - 1) * (p / 100);
  const lo = Math.floor(h);
  return s[lo] + (h - lo) * ((s[Math.min(lo + 1, s.length - 1)]) - s[lo]);
}

/**
 * Split-conformal quantile with the finite-sample correction: the ceil((n+1)(1-alpha))-th
 * smallest score. Returns Infinity when alpha is too small for n scores to certify.
 */
export function conformalQuantile(sorted, alpha) {
  const n = sorted.length;
  if (n === 0) return Infinity;
  if (alpha >= 1) return -Infinity;
  const k = Math.ceil((n + 1) * (1 - alpha));
  if (k > n) return Infinity;
  if (k < 1) return sorted[0];
  return sorted[k - 1];
}

/** Sorted multiset with O(n) insert/remove; enough for 864-sample windows. */
export class SortedWindow {
  constructor() { this.a = []; }
  _idx(x) { let lo = 0, hi = this.a.length; while (lo < hi) { const m = (lo + hi) >> 1; if (this.a[m] < x) lo = m + 1; else hi = m; } return lo; }
  add(x) { this.a.splice(this._idx(x), 0, x); }
  remove(x) { const i = this._idx(x); if (this.a[i] === x) this.a.splice(i, 1); }
  get size() { return this.a.length; }
  max() { return this.a[this.a.length - 1]; }
}

// ---------- forecaster ----------
/**
 * Seasonal-profile x level forecaster, evaluated at block start s for samples s..s+BLOCK-1,
 * using only data before s. Profile = median of the same 5-minute slot over the previous
 * <=7 days; level = median(last 2h actual) / median(last 2h profile), clamped to [0.5, 2].
 * Returns the block's max forecast (requests are flat within a block).
 * This is a transparent stand-in for Cast AI's ML forecaster, not a reimplementation of it.
 */
export function blockForecast(series, s, opts = {}) {
  const days = opts.profileDays ?? 7;
  const levelWin = opts.levelWindow ?? 24;
  const prof = (j) => {
    const v = [];
    for (let k = 1; k <= days; k++) { const t = j - k * SAMPLES_PER_DAY; if (t >= 0) v.push(series[t]); }
    return v.length ? median(v) : series[Math.max(0, s - 1)];
  };
  const recentA = [], recentP = [];
  for (let j = Math.max(0, s - levelWin); j < s; j++) { recentA.push(series[j]); recentP.push(prof(j)); }
  let r = median(recentA) / median(recentP);
  if (!isFinite(r) || r <= 0) r = 1;
  r = Math.min(2, Math.max(0.5, r));
  let mx = 0;
  for (let j = s; j < s + BLOCK; j++) mx = Math.max(mx, prof(j) * r);
  return mx;
}

/** Precompute block forecasts for every block start from `from` (aligned to BLOCK). */
export function forecastBlocks(series, from = PERIODS.forecastFrom, opts) {
  const out = new Map();
  for (let s = from; s + BLOCK <= series.length; s += BLOCK) out.set(s, blockForecast(series, s, opts));
  return out;
}

// ---------- request policies (each returns requests per sample for [from, end)) ----------
function scoreBlock(series, req, s, misses) {
  let m = 0;
  for (let j = s; j < s + BLOCK; j++) if (series[j] > req) m++;
  if (misses) misses.push(m);
  return m;
}

/** Cast AI documented default: percentile of the last 24h (p80 CPU, max memory) x (1 + overhead). */
export function standardPolicy(series, { pct = 80, overhead = 0.10, lookback = SAMPLES_PER_DAY, from = PERIODS.calibrateFrom } = {}) {
  const req = new Float64Array(series.length).fill(NaN);
  for (let s = from; s + BLOCK <= series.length; s += BLOCK) {
    const r = percentile(series.slice(Math.max(0, s - lookback), s), pct) * (1 + overhead);
    for (let j = s; j < s + BLOCK; j++) req[j] = r;
  }
  return { req };
}

/** Forecast x fixed buffer (Cast AI predictive scaling documents a non-configurable 15%). */
export function fixedBufferPolicy(series, fc, { buffer = 0.15, from = PERIODS.calibrateFrom } = {}) {
  const req = new Float64Array(series.length).fill(NaN);
  for (let s = from; s + BLOCK <= series.length; s += BLOCK) {
    const r = fc.get(s) * (1 + buffer);
    for (let j = s; j < s + BLOCK; j++) req[j] = r;
  }
  return { req };
}

/**
 * Adaptive conformal headroom. Scores are usage / block forecast over a trailing window.
 * Each block: request = forecast x conformal (1 - alpha_t) quantile of recent scores;
 * then alpha_{t+1} = alpha_t + gamma (alpha - err_t), err_t = share of the block's samples missed.
 * When alpha_t is below what the window can certify, the request is capped at cap x (max score)
 * x forecast; the long-run guarantee needs those capped blocks to have zero misses, which we
 * count in `capViolations`.
 */
export function calibratedPolicy(series, fc, { alpha = 0.01, gamma = 0.01, window = 3 * SAMPLES_PER_DAY, cap = 1.5, from = PERIODS.calibrateFrom, floor = 1 } = {}) {
  const req = new Float64Array(series.length).fill(NaN);
  const q = new Float64Array(series.length).fill(NaN);
  const alphaPath = [];
  const win = new SortedWindow();
  const scoreAt = new Float64Array(series.length).fill(NaN);
  // scores from forecastFrom onward
  for (const [s, f] of fc) for (let j = s; j < s + BLOCK; j++) scoreAt[j] = series[j] / f;
  const firstScore = Math.max(fc.keys().next().value ?? 0, from - window);
  for (let j = firstScore; j < from; j++) if (!isNaN(scoreAt[j])) win.add(scoreAt[j]);
  let a = alpha, capViolations = 0, cappedBlocks = 0, errSum = 0, blocks = 0;
  for (let s = from; s + BLOCK <= series.length; s += BLOCK) {
    let qq = conformalQuantile(win.a, a);
    let capped = false;
    if (!isFinite(qq) || qq > cap * win.max()) { qq = cap * win.max(); capped = true; cappedBlocks++; }
    if (qq === -Infinity) qq = 0;
    const r = Math.max(floor, fc.get(s) * qq);
    for (let j = s; j < s + BLOCK; j++) { req[j] = r; q[j] = qq; }
    const m = scoreBlock(series, r, s);
    const err = m / BLOCK;
    if (capped && m > 0 && a <= 0) capViolations++;
    alphaPath.push({ s, alpha: a, q: qq, err });
    errSum += err; blocks++;
    a = a + gamma * (alpha - err);
    // slide window: add this block's scores, drop the oldest
    for (let j = s; j < s + BLOCK; j++) {
      win.add(scoreAt[j]);
      const old = j - window;
      if (old >= firstScore && !isNaN(scoreAt[old])) win.remove(scoreAt[old]);
    }
  }
  return { req, q, alphaPath, capViolations, cappedBlocks, meanErr: errSum / blocks, blocks };
}

/** ACI finite-sample bound on |mean err - alpha| after T blocks (Gibbs & Candes 2021, Prop. 4.1). */
export function aciBound(alpha, gamma, T) {
  return (Math.max(alpha, 1 - alpha) + gamma) / (gamma * T);
}

// ---------- scoring ----------
export function evaluate(series, req, from = PERIODS.replayFrom, to = series.length) {
  let miss = 0, n = 0, sumReq = 0, sumUse = 0, sumShort = 0, worstShort = 0;
  for (let j = from; j < to; j++) {
    if (isNaN(req[j])) continue;
    n++; sumReq += req[j]; sumUse += series[j];
    if (series[j] > req[j]) { miss++; sumShort += series[j] - req[j]; worstShort = Math.max(worstShort, series[j] / req[j] - 1); }
  }
  return { missRate: miss / n, misses: miss, samples: n, meanReq: sumReq / n, meanUse: sumUse / n,
    utilization: sumUse / sumReq, meanShortfall: miss ? sumShort / miss : 0, worstShortfall: worstShort };
}

export function monthlyCost(meanReq, pods, resource) {
  return resource === 'cpu'
    ? (meanReq / 1000) * pods * PRICE.hoursPerMonth * PRICE.vcpuHour
    : (meanReq / 1024) * pods * PRICE.hoursPerMonth * PRICE.gibHour;
}

/** Rolling miss rate (share of samples above request) over a trailing window, sampled per block. */
export function rollingMiss(series, req, from, win = SAMPLES_PER_DAY) {
  const out = [];
  for (let s = from; s + BLOCK <= series.length; s += BLOCK) {
    let m = 0, n = 0;
    for (let j = Math.max(from - win + BLOCK, s - win + BLOCK); j < s + BLOCK; j++) {
      if (j < 0 || isNaN(req[j])) continue; n++; if (series[j] > req[j]) m++;
    }
    out.push({ s, rate: n ? m / n : NaN });
  }
  return out;
}

// ---------- full analysis for one workload / resource ----------
export const DEFAULTS = {
  cpu: { alpha: 0.01, gamma: 0.01, stdPct: 80, stdOverhead: 0.10, fixedBuffer: 0.15 },
  mem: { alpha: 0.002, gamma: 0.004, stdPct: 100, stdOverhead: 0.10, fixedBuffer: 0.15 },
};

export function analyze(series, resource, opts = {}) {
  const d = { ...DEFAULTS[resource], ...opts };
  const fc = forecastBlocks(series);
  const std = standardPolicy(series, { pct: d.stdPct, overhead: d.stdOverhead });
  const fixed = fixedBufferPolicy(series, fc, { buffer: d.fixedBuffer });
  const cal = calibratedPolicy(series, fc, { alpha: d.alpha, gamma: d.gamma });
  return {
    fc, d,
    standard: { ...std, ...evaluate(series, std.req) },
    fixed: { ...fixed, ...evaluate(series, fixed.req) },
    calibrated: { ...cal, ...evaluate(series, cal.req), bound: aciBound(d.alpha, d.gamma, cal.blocks) },
  };
}

/** Risk/cost frontier on the replay window for the three policy families. */
export function frontier(series, resource, fc = forecastBlocks(series)) {
  const d = DEFAULTS[resource];
  const alphas = resource === 'cpu' ? [0.002, 0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.12] : [0.0005, 0.001, 0.002, 0.005, 0.01, 0.02, 0.05];
  const buffers = [0, 0.05, 0.1, 0.15, 0.2, 0.3, 0.4, 0.6, 0.8, 1.0, 1.25, 1.5, 2.0, 2.5, 3.0];
  const pcts = [50, 80, 90, 95, 99, 100];
  return {
    calibrated: alphas.map((alpha) => ({ alpha, ...evaluate(series, calibratedPolicy(series, fc, { alpha, gamma: d.gamma }).req) })),
    fixed: buffers.map((buffer) => ({ buffer, ...evaluate(series, fixedBufferPolicy(series, fc, { buffer }).req) })),
    standard: pcts.map((pct) => ({ pct, ...evaluate(series, standardPolicy(series, { pct, overhead: d.stdOverhead }).req) })),
  };
}

// ---------- fleet risk budget ----------
/**
 * Allocate per-workload miss targets alpha_i to minimise total monthly cost subject to a
 * weighted risk budget  sum_i w_i p_i alpha_i <= abar * sum_i w_i p_i  (w = tier weight,
 * p = pods). Cost curves c_i(alpha) come from the TRAINING window only (days 5-7), so the
 * replay (days 8-14) is an out-of-sample check. Lagrangian relaxation: for a multiplier
 * lambda each workload picks argmin_alpha c_i(alpha) + lambda w_i p_i alpha on its grid;
 * bisection on lambda finds the cheapest allocation that meets the budget.
 */
export function trainingCostCurve(series, resource, pods, grid) {
  const d = DEFAULTS[resource];
  const fc = forecastBlocks(series);
  return grid.map((alpha) => {
    const cal = calibratedPolicy(series, fc, { alpha, gamma: d.gamma });
    const ev = evaluate(series, cal.req, PERIODS.calibrateFrom, PERIODS.replayFrom);
    return { alpha, cost: monthlyCost(ev.meanReq, pods, resource), trainMiss: ev.missRate };
  });
}

export function allocateBudget(items, abar) {
  // items: [{ weight, pods, curve: [{alpha, cost}] }]
  const W = items.reduce((t, it) => t + it.weight * it.pods, 0);
  const budget = abar * W;
  const pick = (lambda) => items.map((it) => {
    let best = null;
    for (const pt of it.curve) {
      const v = pt.cost + lambda * it.weight * it.pods * pt.alpha;
      if (!best || v < best.v - 1e-12) best = { v, pt };
    }
    return best.pt;
  });
  const used = (sel) => sel.reduce((t, pt, i) => t + items[i].weight * items[i].pods * pt.alpha, 0);
  let lo = 0, hi = 1;
  while (used(pick(hi)) > budget && hi < 1e9) hi *= 2;
  for (let it = 0; it < 80; it++) {
    const mid = 0.5 * (lo + hi);
    if (used(pick(mid)) > budget) lo = mid; else hi = mid;
  }
  const sel = pick(hi);
  return { alphas: sel.map((p) => p.alpha), cost: sel.reduce((t, p) => t + p.cost, 0), used: used(sel), budget, lambda: hi };
}

/**
 * Mean request at which a policy family reaches `target` miss rate, by linear interpolation
 * along its sweep (points must bracket the target; returns null otherwise, never extrapolates).
 */
export function reqAtMiss(points, target) {
  const p = [...points].filter((x) => isFinite(x.missRate)).sort((a, b) => a.missRate - b.missRate || b.meanReq - a.meanReq);
  for (let i = 1; i < p.length; i++) {
    const a = p[i - 1], b = p[i];
    if (a.missRate <= target && target <= b.missRate) {
      const t = b.missRate === a.missRate ? 0 : (target - a.missRate) / (b.missRate - a.missRate);
      return a.meanReq + t * (b.meanReq - a.meanReq);
    }
  }
  return null;
}

/** Notable buffer moves for the event log: blocks where the calibrated multiplier changed most. */
export function bufferEvents(alphaPath, k = 6) {
  const ev = [];
  for (let i = 1; i < alphaPath.length; i++) {
    const d = alphaPath[i].q / alphaPath[i - 1].q - 1;
    if (isFinite(d)) ev.push({ s: alphaPath[i].s, from: alphaPath[i - 1].q, to: alphaPath[i].q, change: d, prevErr: alphaPath[i - 1].err });
  }
  return ev.sort((a, b) => Math.abs(b.change) - Math.abs(a.change)).slice(0, k).sort((a, b) => a.s - b.s);
}
