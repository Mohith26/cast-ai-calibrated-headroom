// Prints every headline number shown on the page and in the README, computed from data/fleet.json.
// Usage: node scripts/report.mjs
import { readFileSync } from 'node:fs';
import * as H from '../src/headroom.js';
const data = JSON.parse(readFileSync(new URL('../data/fleet.json', import.meta.url)));
const pct = (x) => (x * 100).toFixed(2) + '%';
let calCost = 0, saveStd = 0; const rows = [];
for (const w of data.workloads) {
  const a = H.analyze(w.cpu, 'cpu'); const fr = H.frontier(w.cpu, 'cpu', a.fc);
  const std = H.reqAtMiss(fr.standard, a.calibrated.missRate), fix = H.reqAtMiss(fr.fixed, a.calibrated.missRate);
  calCost += H.monthlyCost(a.calibrated.meanReq, w.pods, 'cpu');
  if (std) saveStd += H.monthlyCost(std, w.pods, 'cpu') - H.monthlyCost(a.calibrated.meanReq, w.pods, 'cpu');
  rows.push({ w, a, fr, std, fix });
  console.log(w.name.padEnd(21), 'std p80+10%', pct(a.standard.missRate).padStart(7), '| +15%', pct(a.fixed.missRate).padStart(7), '| calibrated', pct(a.calibrated.missRate).padStart(6),
    '| req/pod cal', (a.calibrated.meanReq / 1000).toFixed(3), 'std@same', std ? (std / 1000).toFixed(3) : 'n/a', 'fixed(hindsight)@same', fix ? (fix / 1000).toFixed(3) : 'n/a');
}
const worst = Math.max(...rows.map((r) => r.a.calibrated.missRate));
for (const b of rows[0].fr.fixed.map((p) => p.buffer)) {
  const ws = Math.max(...rows.map((r) => r.fr.fixed.find((p) => p.buffer === b).missRate));
  if (ws <= worst) { const c = rows.reduce((t, r) => t + H.monthlyCost(r.fr.fixed.find((p) => p.buffer === b).meanReq, r.w.pods, 'cpu'), 0); console.log(`\nfleet-wide fixed buffer with worst-case miss <= ${pct(worst)}: +${b * 100}% -> $${c.toFixed(0)}/mo vs calibrated $${calCost.toFixed(0)}/mo (${pct(1 - calCost / c)} less)`); break; }
}
console.log(`savings vs percentile rule tuned to the same miss rate: $${saveStd.toFixed(0)}/mo`);
const close = rows.filter((r) => Math.abs(r.a.calibrated.meanReq / r.fix - 1) < 0.03).length;
console.log(`calibrated within 3% of a hindsight-tuned fixed buffer at equal risk on ${close}/12 workloads`);
// fleet budget allocator (negative result, kept for honesty)
const grid = [0.002, 0.005, 0.01, 0.02, 0.03, 0.05, 0.08];
const tiers = { 'payments-gateway': 2, 'checkout-api': 2, 'auth-service': 2, 'session-cache': 2, 'image-resizer': 0.5, 'inventory-sync': 0.5, 'search-indexer': 0.5, 'notifications-worker': 0.5 };
const items = data.workloads.map((w) => ({ weight: tiers[w.name] ?? 1, pods: w.pods, curve: H.trainingCostCurve(w.cpu, 'cpu', w.pods, grid) }));
const alloc = H.allocateBudget(items, 0.01);
let cu = 0, ca = 0, mu = 0, ma = 0, W = 0;
data.workloads.forEach((w, i) => {
  const fc = H.forecastBlocks(w.cpu);
  const eu = H.evaluate(w.cpu, H.calibratedPolicy(w.cpu, fc, { alpha: 0.01, gamma: 0.01 }).req);
  const ea = H.evaluate(w.cpu, H.calibratedPolicy(w.cpu, fc, { alpha: alloc.alphas[i], gamma: 0.01 }).req);
  cu += H.monthlyCost(eu.meanReq, w.pods, 'cpu'); ca += H.monthlyCost(ea.meanReq, w.pods, 'cpu');
  const wt = items[i].weight * w.pods; mu += wt * eu.missRate; ma += wt * ea.missRate; W += wt;
});
const uniTrain = items.reduce((t, it) => t + it.curve.find((p) => p.alpha === 0.01).cost, 0);
console.log(`\nbudget allocator: training $${alloc.cost.toFixed(0)} vs uniform $${uniTrain.toFixed(0)}; replay $${ca.toFixed(0)} (weighted miss ${pct(ma / W)}) vs uniform $${cu.toFixed(0)} (${pct(mu / W)})`);
for (const r of ['mem']) {
  let m = [];
  for (const w of data.workloads) { const a = H.analyze(w.mem, 'mem'); m.push(a.calibrated.missRate); }
  console.log(`memory, target 0.2%: calibrated realized ${pct(Math.min(...m))} - ${pct(Math.max(...m))}`);
}
