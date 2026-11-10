// Seeded synthetic fleet: 12 workloads, 14 days of per-pod CPU (millicores) and memory (MiB)
// at 5-minute resolution. Patterns mimic what a Kubernetes rightsizer actually sees:
// daily/weekly seasonality, deploy-driven regime shifts, batch spikes, heavy tails,
// growth trends, Markov regime switching and memory-leak sawtooth.
// Usage: node scripts/generate.mjs [seed]  -> writes data/fleet.json
import { writeFileSync } from 'node:fs';
import { createHash } from 'node:crypto';

export const STEP_MIN = 5;
export const DAYS = 14;
export const N = (DAYS * 24 * 60) / STEP_MIN; // 4032 samples

function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function makeRng(seed) {
  const u = mulberry32(seed);
  const normal = () => {
    let a = 0, b = 0;
    while (a === 0) a = u();
    while (b === 0) b = u();
    return Math.sqrt(-2 * Math.log(a)) * Math.cos(2 * Math.PI * b);
  };
  const studentT = (df) => {
    let chi = 0;
    for (let i = 0; i < df; i++) { const z = normal(); chi += z * z; }
    return normal() / Math.sqrt(chi / df);
  };
  return { u, normal, studentT };
}

// Start Monday 2026-10-19 00:00 UTC so weekdays line up with real dates.
export const START_ISO = '2026-10-19T00:00:00Z';

const hourOf = (i) => ((i * STEP_MIN) / 60) % 24;
const dayOf = (i) => Math.floor((i * STEP_MIN) / 1440);
const weekend = (i) => { const d = dayOf(i) % 7; return d === 5 || d === 6; };

// Smooth business-hours curve peaking ~14:00 UTC (US morning + EU afternoon).
const diurnal = (h) => 0.5 + 0.5 * Math.cos(((h - 14) / 24) * 2 * Math.PI);

function specFleet() {
  return [
    { name: 'checkout-api', ns: 'storefront', kind: 'Deployment', pods: 48,
      cpu: { base: 310, amp: 520, wk: 0.55, noise: 0.10, tail: 0, shiftDay: 10, shiftMul: 1.32 },
      mem: { base: 900, amp: 220, noise: 0.03 } },
    { name: 'payments-gateway', ns: 'payments', kind: 'Deployment', pods: 30,
      cpu: { base: 260, amp: 410, wk: 0.7, noise: 0.08, tail: 3 },
      mem: { base: 1250, amp: 160, noise: 0.025 } },
    { name: 'search-indexer', ns: 'search', kind: 'StatefulSet', pods: 12,
      cpu: { base: 420, amp: 120, wk: 0.95, noise: 0.07, batchEveryH: 6, batchLenMin: 40, batchMul: 2.3 },
      mem: { base: 3100, amp: 300, noise: 0.02, batchMem: 900 } },
    { name: 'recommendation-svc', ns: 'personalization', kind: 'Deployment', pods: 36,
      cpu: { base: 380, amp: 600, wk: 0.65, noise: 0.11, growthPerDay: 0.022 },
      mem: { base: 2200, amp: 180, noise: 0.02, growthPerDay: 0.012 } },
    { name: 'auth-service', ns: 'identity', kind: 'Deployment', pods: 20,
      cpu: { base: 140, amp: 90, wk: 0.8, noise: 0.05 },
      mem: { base: 420, amp: 30, noise: 0.015 } },
    { name: 'image-resizer', ns: 'media', kind: 'Deployment', pods: 24,
      cpu: { base: 150, amp: 260, wk: 0.6, noise: 0.14, burstRate: 0.018, burstMul: 2.6 },
      mem: { base: 700, amp: 140, noise: 0.05, burstMem: 450 } },
    { name: 'notifications-worker', ns: 'messaging', kind: 'Deployment', pods: 12,
      cpu: { base: 90, amp: 330, wk: 0.25, noise: 0.09 },
      mem: { base: 520, amp: 90, noise: 0.03 } },
    { name: 'inventory-sync', ns: 'catalog', kind: 'CronJob', pods: 6,
      cpu: { base: 70, amp: 40, wk: 0.9, noise: 0.06, hourlySpike: 520, hourlyLenMin: 10 },
      mem: { base: 610, amp: 40, noise: 0.02, hourlyMem: 380 } },
    { name: 'graphql-gateway', ns: 'storefront', kind: 'Deployment', pods: 40,
      cpu: { base: 240, amp: 380, wk: 0.6, noise: 0.09, tail: 5 },
      mem: { base: 980, amp: 140, noise: 0.025 } },
    { name: 'orders-consumer', ns: 'orders', kind: 'Deployment', pods: 18,
      cpu: { base: 200, amp: 300, wk: 0.6, noise: 0.06, hetero: 0.22 },
      mem: { base: 760, amp: 120, noise: 0.03 } },
    { name: 'pricing-engine', ns: 'catalog', kind: 'Deployment', pods: 12,
      cpu: { base: 330, amp: 210, wk: 0.85, noise: 0.08, regimes: [1, 1.7], pStay: 0.992 },
      mem: { base: 1500, amp: 120, noise: 0.02 } },
    { name: 'session-cache', ns: 'identity', kind: 'StatefulSet', pods: 6,
      cpu: { base: 160, amp: 120, wk: 0.8, noise: 0.06 },
      mem: { base: 2400, amp: 100, noise: 0.01, leakMiBPerH: 26, restartEveryH: 31 } },
  ];
}

function genCpu(rng, c) {
  const out = new Array(N);
  let regime = 0;
  for (let i = 0; i < N; i++) {
    const h = hourOf(i), d = dayOf(i);
    let level = c.base + c.amp * diurnal(h) * (weekend(i) ? c.wk : 1);
    if (c.shiftDay !== undefined && d >= c.shiftDay) level *= c.shiftMul;
    if (c.growthPerDay) level *= Math.pow(1 + c.growthPerDay, (i * STEP_MIN) / 1440);
    if (c.regimes) {
      if (rng.u() > c.pStay) regime = 1 - regime;
      level *= c.regimes[regime];
    }
    let mult = Math.exp(c.noise * (c.tail ? rng.studentT(c.tail) * 0.8 : rng.normal()));
    if (c.hetero) mult *= Math.exp(c.hetero * rng.normal() * diurnal(h));
    let v = level * mult;
    if (c.batchEveryH) {
      const minInCycle = (i * STEP_MIN) % (c.batchEveryH * 60);
      if (minInCycle < c.batchLenMin) v *= c.batchMul * (0.9 + 0.2 * rng.u());
    }
    if (c.burstRate && rng.u() < c.burstRate) v *= c.burstMul * (0.8 + 0.4 * rng.u());
    if (c.hourlySpike) {
      const m = (i * STEP_MIN) % 60;
      if (m < c.hourlyLenMin) v += c.hourlySpike * (0.85 + 0.3 * rng.u());
    }
    out[i] = Math.max(5, Math.round(v));
  }
  return out;
}

function genMem(rng, m) {
  const out = new Array(N);
  for (let i = 0; i < N; i++) {
    const h = hourOf(i);
    let v = m.base + m.amp * diurnal(h);
    if (m.growthPerDay) v *= Math.pow(1 + m.growthPerDay, (i * STEP_MIN) / 1440);
    if (m.leakMiBPerH) {
      const hoursSinceRestart = ((i * STEP_MIN) / 60) % m.restartEveryH;
      v += m.leakMiBPerH * hoursSinceRestart;
    }
    if (m.batchMem) { const mc = (i * STEP_MIN) % 360; if (mc < 40) v += m.batchMem * (0.9 + 0.2 * rng.u()); }
    if (m.burstMem && rng.u() < 0.018) v += m.burstMem * (0.7 + 0.6 * rng.u());
    if (m.hourlyMem) { const mm = (i * STEP_MIN) % 60; if (mm < 10) v += m.hourlyMem * (0.9 + 0.2 * rng.u()); }
    v *= Math.exp(m.noise * rng.normal());
    out[i] = Math.max(16, Math.round(v));
  }
  return out;
}

export function generate(seed = 20261019) {
  const rng = makeRng(seed);
  const workloads = specFleet().map((s) => ({
    name: s.name, namespace: s.ns, kind: s.kind, pods: s.pods,
    cpu: genCpu(rng, s.cpu), mem: genMem(rng, s.mem),
    notes: describe(s),
    events: s.cpu.shiftDay !== undefined ? [{ i: s.cpu.shiftDay * 288, label: 'Rollout v2.41' }] : [],
  }));
  return { seed, start: START_ISO, stepMinutes: STEP_MIN, days: DAYS, cluster: 'prod-us-east-1', workloads };
}

function describe(s) {
  const c = s.cpu, m = s.mem, n = [];
  if (c.shiftDay !== undefined) n.push(`deploy on day ${c.shiftDay + 1} raises CPU ${Math.round((c.shiftMul - 1) * 100)}%`);
  if (c.tail) n.push(`heavy-tailed noise (t, df=${c.tail})`);
  if (c.batchEveryH) n.push(`batch job every ${c.batchEveryH}h`);
  if (c.growthPerDay) n.push(`traffic growth ${(c.growthPerDay * 100).toFixed(1)}%/day`);
  if (c.burstRate) n.push('random bursts');
  if (c.hourlySpike) n.push('hourly sync spike');
  if (c.hetero) n.push('noise grows with load');
  if (c.regimes) n.push('Markov regime switching');
  if (m.leakMiBPerH) n.push(`memory leak ${m.leakMiBPerH} MiB/h, restart every ${m.restartEveryH}h`);
  if (c.wk < 0.4) n.push('strong weekly cycle');
  if (!n.length) n.push('steady daily cycle');
  return n.join('; ');
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const seed = Number(process.argv[2] || 20261019);
  const data = generate(seed);
  const json = JSON.stringify(data);
  writeFileSync(new URL('../data/fleet.json', import.meta.url), json);
  console.log('wrote data/fleet.json', (json.length / 1024).toFixed(0) + ' KB',
    'sha256', createHash('sha256').update(json).digest('hex').slice(0, 16));
}
