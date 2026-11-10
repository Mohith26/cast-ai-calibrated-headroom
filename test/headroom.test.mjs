import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import * as H from '../src/headroom.js';
import { generate, makeRng } from '../scripts/generate.mjs';

const data = JSON.parse(readFileSync(new URL('../data/fleet.json', import.meta.url)));

test('generator is deterministic and matches the committed data', () => {
  const g = generate(data.seed);
  assert.equal(JSON.stringify(g), JSON.stringify(data));
  assert.equal(g.workloads.length, 12);
  for (const w of g.workloads) { assert.equal(w.cpu.length, 4032); assert.equal(w.mem.length, 4032); }
});

test('conformal quantile uses the ceil((n+1)(1-alpha)) order statistic', () => {
  const s = Array.from({ length: 99 }, (_, i) => i + 1); // 1..99
  assert.equal(H.conformalQuantile(s, 0.1), 90); // ceil(100*0.9)=90
  assert.equal(H.conformalQuantile(s, 0.01), 99);
  assert.equal(H.conformalQuantile(s, 0.005), Infinity); // cannot certify 99.5% with 99 scores
  assert.equal(H.percentile([1, 2, 3, 4, 5], 80), 4.2);
});

test('split conformal covers at 1 - alpha on exchangeable data (many seeds)', () => {
  const alpha = 0.05; let miss = 0, n = 0;
  for (let seed = 1; seed <= 400; seed++) {
    const r = makeRng(seed);
    const cal = Array.from({ length: 200 }, () => Math.exp(0.3 * r.normal())).sort((a, b) => a - b);
    const q = H.conformalQuantile(cal, alpha);
    for (let k = 0; k < 25; k++) { n++; if (Math.exp(0.3 * r.normal()) > q) miss++; }
  }
  const rate = miss / n; // theory: <= alpha, and >= alpha - 1/(n_cal+1)
  assert.ok(rate <= alpha + 0.01 && rate >= alpha - 0.015, `rate ${rate}`);
});

test('sorted window add/remove keeps order', () => {
  const w = new H.SortedWindow(); [5, 1, 3, 3, 9].forEach((x) => w.add(x)); w.remove(3);
  assert.deepEqual(w.a, [1, 3, 5, 9]); assert.equal(w.max(), 9);
});

test('ACI hits the target miss rate on every workload, within the finite-sample bound', () => {
  for (const w of data.workloads) {
    const a = H.analyze(w.cpu, 'cpu');
    const c = a.calibrated;
    assert.equal(c.capViolations, 0, w.name);
    // Gibbs & Candes Prop 4.1 over the whole adaptive run
    assert.ok(Math.abs(c.meanErr - 0.01) <= c.bound, `${w.name} meanErr ${c.meanErr}`);
    // and empirically much tighter on the 7-day replay
    assert.ok(Math.abs(c.missRate - 0.01) < 0.004, `${w.name} replay miss ${c.missRate}`);
  }
});

test('a fixed buffer gives very uneven risk across the fleet; calibrated does not', () => {
  const fixed = [], cal = [];
  for (const w of data.workloads) { const a = H.analyze(w.cpu, 'cpu'); fixed.push(a.fixed.missRate); cal.push(a.calibrated.missRate); }
  const spread = (x) => Math.max(...x) - Math.min(...x);
  assert.ok(spread(fixed) > 0.05, `fixed spread ${spread(fixed)}`);
  assert.ok(spread(cal) < 0.006, `cal spread ${spread(cal)}`);
});

test('frontier is monotone: looser targets request less', () => {
  const fr = H.frontier(data.workloads[0].cpu, 'cpu');
  for (let i = 1; i < fr.calibrated.length; i++) assert.ok(fr.calibrated[i].meanReq <= fr.calibrated[i - 1].meanReq + 1e-9);
  for (let i = 1; i < fr.fixed.length; i++) assert.ok(fr.fixed[i].meanReq >= fr.fixed[i - 1].meanReq);
});

test('calibrated matches a hindsight-tuned fixed buffer at equal risk on most workloads', () => {
  let close = 0;
  for (const w of data.workloads) {
    const a = H.analyze(w.cpu, 'cpu'); const fr = H.frontier(w.cpu, 'cpu', a.fc);
    const oracle = H.reqAtMiss(fr.fixed, a.calibrated.missRate);
    assert.ok(oracle !== null, w.name);
    if (Math.abs(a.calibrated.meanReq / oracle - 1) < 0.03) close++;
  }
  assert.ok(close >= 9, `close on ${close}/12`);
});

test('reqAtMiss interpolates and refuses to extrapolate', () => {
  const pts = [{ missRate: 0.1, meanReq: 100 }, { missRate: 0.02, meanReq: 150 }, { missRate: 0.0, meanReq: 300 }];
  assert.equal(H.reqAtMiss(pts, 0.06), 125);
  assert.equal(H.reqAtMiss(pts, 0.2), null);
});

test('standard policy is p80 of the last 24h plus 10%', () => {
  const s = Array.from({ length: 2000 }, (_, i) => (i % 100) + 1);
  const { req } = H.standardPolicy(s, { from: 1152 });
  const expect = H.percentile(s.slice(1152 - 288, 1152), 80) * 1.1;
  assert.ok(Math.abs(req[1152] - expect) < 1e-9);
});

test('budget allocator respects the weighted budget and never costs more than uniform on its training curves', () => {
  const grid = [0.002, 0.005, 0.01, 0.02, 0.05];
  const items = data.workloads.slice(0, 6).map((w, i) => ({ weight: i % 2 ? 2 : 1, pods: w.pods, curve: H.trainingCostCurve(w.cpu, 'cpu', w.pods, grid) }));
  const alloc = H.allocateBudget(items, 0.01);
  assert.ok(alloc.used <= alloc.budget + 1e-9);
  const uniform = items.reduce((t, it) => t + it.curve.find((p) => p.alpha === 0.01).cost, 0);
  assert.ok(alloc.cost <= uniform + 1e-9);
});
