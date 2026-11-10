import * as H from './src/headroom.js';

const $ = (id) => document.getElementById(id);
const C = { usage: '#26bb74', standard: '#051922', fixed: '#7f61f0', calibrated: '#417ae9', miss: '#c93636', grid: '#e1e7ea', axis: '#5d6e75', faint: '#bac3c8' };
const TARGETS = { cpu: [0.005, 0.01, 0.02, 0.05], mem: [0.0005, 0.001, 0.002, 0.005] };
const STRAT_NAME = { standard: 'Standard', fixed: 'Predictive', calibrated: 'Calibrated' };
const state = { wl: 0, res: 'cpu', strat: 'calibrated', tab: 'charts', target: { cpu: 0.01, mem: 0.002 } };
let DATA;
const cache = new Map();

const pct = (x, d = 2) => (x * 100).toFixed(x !== 0 && x < 0.001 ? 3 : d) + '%';
const money = (x) => (x < 0 ? '−$' : '$') + Math.abs(x).toLocaleString('en-US', { maximumFractionDigits: 0 });
const unit = (r) => (r === 'cpu' ? 'CPU' : 'GiB');
const toU = (v, r) => (r === 'cpu' ? v / 1000 : v / 1024);
const fmtU = (v, r, d = 3) => toU(v, r).toFixed(d);
const tsOf = (i) => new Date(Date.parse(DATA.start) + i * DATA.stepMinutes * 60000);
const dfmt = (i, withTime) => {
  const d = tsOf(i); const m = d.toLocaleString('en-US', { month: 'short', timeZone: 'UTC' });
  const s = `${m} ${d.getUTCDate()}`;
  return withTime ? `${s}, ${String(d.getUTCHours()).padStart(2, '0')}:${String(d.getUTCMinutes()).padStart(2, '0')} UTC` : s;
};

function get(wlIdx, res) {
  const alpha = state.target[res];
  const key = `${wlIdx}|${res}|${alpha}`;
  if (cache.has(key)) return cache.get(key);
  const w = DATA.workloads[wlIdx]; const s = w[res];
  const a = H.analyze(s, res, { alpha });
  const fr = H.frontier(s, res, a.fc);
  const stdAtRisk = H.reqAtMiss(fr.standard, a.calibrated.missRate);
  const fixedAtRisk = H.reqAtMiss(fr.fixed, a.calibrated.missRate);
  const out = { a, fr, stdAtRisk, fixedAtRisk, w, s };
  cache.set(key, out);
  return out;
}

// ---------------- SVG helpers ----------------
function svgEl(w, h) { return `<svg width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" xmlns="http://www.w3.org/2000/svg">`; }
function tickLabel(x, y, text, anchor = 'start') {
  const w = text.length * 5.6 + 8;
  const rx = anchor === 'end' ? x - w : x;
  return `<rect class="tick-bg" x="${rx}" y="${y - 8}" width="${w}" height="15" rx="3"/><text x="${rx + 4}" y="${y + 3}" font-size="10" fill="${C.axis}">${text}</text>`;
}
function niceMax(v) { const p = Math.pow(10, Math.floor(Math.log10(v))); for (const m of [1, 1.5, 2, 2.5, 3, 4, 5, 6, 8, 10]) if (m * p >= v) return m * p; return 10 * p; }
function pathOf(xs, ys) { let d = ''; for (let i = 0; i < xs.length; i++) d += (i ? 'L' : 'M') + xs[i].toFixed(1) + ' ' + ys[i].toFixed(1); return d; }
function stepPath(from, to, req, X, Y) {
  let d = '', prev = null;
  for (let j = from; j < to; j++) {
    const v = req[j]; if (isNaN(v)) continue;
    const x = X(j), y = Y(v);
    if (prev === null) d += `M${x.toFixed(1)} ${y.toFixed(1)}`;
    else if (v !== prev) d += `L${x.toFixed(1)} ${Y(prev).toFixed(1)}L${x.toFixed(1)} ${y.toFixed(1)}`;
    prev = v;
  }
  return d + `L${X(to).toFixed(1)} ${Y(prev).toFixed(1)}`;
}

// ---------------- main chart ----------------
function renderMain() {
  const { a, s, w } = get(state.wl, state.res);
  const r = state.res;
  const el = $('mainChart'); const W = el.clientWidth || 1100, Hh = 300;
  const from = H.PERIODS.replayFrom, to = s.length;
  const L = 56, R = 14, T = 14, B = 30;
  let mx = 0;
  for (let j = from; j < to; j++) mx = Math.max(mx, s[j], a.standard.req[j] || 0, a.fixed.req[j] || 0, a.calibrated.req[j] || 0);
  const ymax = niceMax(toU(mx, r) * 1.04);
  const X = (j) => L + ((j - from) / (to - from)) * (W - L - R);
  const Y = (v) => T + (1 - toU(v, r) / ymax) * (Hh - T - B);
  let g = svgEl(W, Hh);
  for (let k = 0; k <= 4; k++) {
    const val = (ymax * k) / 4; const y = T + (1 - k / 4) * (Hh - T - B);
    g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="${C.grid}" stroke-width="1" ${k ? 'stroke-dasharray="0"' : ''}/>`;
    g += tickLabel(6, y, k === 4 ? `${val.toFixed(val < 10 ? 2 : 1)} ${unit(r)}` : val.toFixed(val < 10 ? 2 : 1));
  }
  for (let d = 7; d <= 14; d++) {
    const j = d * H.SAMPLES_PER_DAY; const x = X(Math.min(j, to));
    if (d < 14) { g += `<line x1="${x}" x2="${x}" y1="${T}" y2="${Hh - B}" stroke="${C.grid}" stroke-dasharray="2 3"/>`; g += `<text x="${x + 4}" y="${Hh - 10}" font-size="10" fill="${C.axis}">${dfmt(j)}</text>`; }
  }
  for (const ev of w.events || []) if (ev.i >= from) {
    const x = X(ev.i);
    g += `<line x1="${x}" x2="${x}" y1="${T}" y2="${Hh - B}" stroke="#a5541e" stroke-width="1.2" stroke-dasharray="4 3"/>`;
    g += `<rect x="${x + 4}" y="${T}" width="${ev.label.length * 5.7 + 10}" height="17" rx="3" fill="#fef6e1" stroke="#fad983"/><text x="${x + 9}" y="${T + 12}" font-size="10" fill="#a5541e">${ev.label}</text>`;
  }
  // usage
  const xs = [], ys = [];
  for (let j = from; j < to; j++) { xs.push(X(j)); ys.push(Y(s[j])); }
  g += `<path d="${pathOf(xs, ys)}" fill="none" stroke="${C.usage}" stroke-width="1" opacity=".9"/>`;
  for (const k of ['standard', 'fixed', 'calibrated']) {
    if (r === 'mem' && k === 'fixed') continue;
    const on = state.strat === k;
    g += `<path d="${stepPath(from, to, a[k].req, X, Y)}" fill="none" stroke="${C[k]}" stroke-width="${on ? 2 : 1.2}" opacity="${on ? 1 : 0.35}"/>`;
  }
  const sel = a[state.strat].req;
  for (let j = from; j < to; j++) if (s[j] > sel[j]) g += `<circle cx="${X(j).toFixed(1)}" cy="${Y(s[j]).toFixed(1)}" r="2.6" fill="${C.miss}"/>`;
  g += `<line id="hoverLine" x1="0" x2="0" y1="${T}" y2="${Hh - B}" stroke="${C.grid}" stroke-width="1" style="display:none"/>`;
  g += `<rect id="hoverRect" x="${L}" y="${T}" width="${W - L - R}" height="${Hh - T - B}" fill="transparent"/></svg>`;
  el.innerHTML = g;
  const rect = el.querySelector('#hoverRect'), line = el.querySelector('#hoverLine'), tip = $('tip');
  rect.addEventListener('mousemove', (e) => {
    const bb = rect.getBoundingClientRect();
    const j = Math.min(to - 1, Math.max(from, Math.round(from + ((e.clientX - bb.left) / bb.width) * (to - from))));
    line.setAttribute('x1', X(j)); line.setAttribute('x2', X(j)); line.style.display = '';
    const row = (k, lab) => (r === 'mem' && k === 'fixed') ? '' : `<br><span style="color:${k === 'standard' ? '#bac3c8' : C[k]}">■</span> ${lab}: ${fmtU(a[k].req[j], r)} ${unit(r)}`;
    tip.innerHTML = `${dfmt(j, true)}<br><span style="color:${C.usage}">■</span> Usage: ${fmtU(s[j], r)} ${unit(r)}${row('standard', 'Standard')}${row('fixed', 'Predictive (+15%)')}${row('calibrated', 'Calibrated')}`;
    tip.classList.remove('hidden'); tip.style.left = e.clientX + 14 + 'px'; tip.style.top = e.clientY - 20 + 'px';
  });
  rect.addEventListener('mouseleave', () => { tip.classList.add('hidden'); line.style.display = 'none'; });
}

function renderLegend() {
  const { a } = get(state.wl, state.res); const r = state.res;
  const item = (k, label, v, extra, on) => `<div class="lg ${on ? '' : 'dim'}" style="border-color:${C[k] || k}"><div class="k">${label}</div><div class="v">${v}<small>${unit(r)}</small>${extra ? `<small style="margin-left:8px">${extra}</small>` : ''}</div></div>`;
  const sel = a[state.strat];
  const html =
    item('standard', r === 'cpu' ? 'Standard (p80 + 10%)' : 'Standard (max + 10%)', fmtU(a.standard.meanReq, r), `miss ${pct(a.standard.missRate)}`, true) +
    (r === 'cpu' ? item('fixed', 'Predictive (+15% buffer)', fmtU(a.fixed.meanReq, r), `miss ${pct(a.fixed.missRate)}`, true) : `<div class="lg dim" style="border-color:${C.fixed}"><div class="k">Predictive</div><div class="v" style="font-size:12px;font-weight:500;font-family:Poppins">CPU only</div></div>`) +
    item('calibrated', `Calibrated (target ${pct(state.target[r], state.target[r] < 0.01 ? 2 : 1)})`, fmtU(a.calibrated.meanReq, r), `miss ${pct(a.calibrated.missRate)}`, true) +
    item('usage', 'Avg. usage', fmtU(a.calibrated.meanUse, r), '', true) +
    `<div class="lg" style="border-color:${C.miss}"><div class="k">Misses · ${STRAT_NAME[state.strat]}</div><div class="v">${sel.misses}<small>of ${sel.samples}</small><small style="margin-left:8px">worst ${pct(sel.worstShortfall, 1)} over</small></div></div>`;
  $('legendRow').innerHTML = html;
}

// ---------------- frontier chart ----------------
function renderFrontier() {
  const { a, fr } = get(state.wl, state.res); const r = state.res;
  const el = $('frontierChart'); const W = el.clientWidth || 540, Hh = 236;
  const L = 52, R = 16, T = 12, B = 34;
  const xmin = r === 'cpu' ? 0.0005 : 0.0001, xmax = 0.3;
  const lx = (m) => Math.log10(Math.min(xmax, Math.max(xmin, m)));
  const X = (m) => L + ((lx(m) - Math.log10(xmin)) / (Math.log10(xmax) - Math.log10(xmin))) * (W - L - R);
  const fams = { standard: fr.standard, calibrated: fr.calibrated }; if (r === 'cpu') fams.fixed = fr.fixed;
  const ref = a.calibrated.meanReq;
  // keep the informative part of each sweep: drop points beyond 1.8x the calibrated request and
  // collapse the zero-miss tail to its cheapest point (log axis cannot show 0)
  const clean = (arr) => {
    const p = arr.filter((q) => q.meanReq <= ref * 1.8).sort((u, v) => u.missRate - v.missRate || v.meanReq - u.meanReq);
    const z = p.filter((q) => q.missRate < xmin); const nz = p.filter((q) => q.missRate >= xmin);
    return z.length ? [z.reduce((m, q) => (q.meanReq < m.meanReq ? q : m)), ...nz] : nz;
  };
  let ymaxRaw = 0, yminRaw = Infinity; for (const k in fams) for (const p of clean(fams[k])) { ymaxRaw = Math.max(ymaxRaw, p.meanReq); yminRaw = Math.min(yminRaw, p.meanReq); }
  const span = toU(ymaxRaw - yminRaw, r) || 0.1; const step = niceMax(span / 4);
  const ymin = Math.max(0, Math.floor((toU(yminRaw, r) - span * 0.08) / step) * step);
  const ymax = ymin + step * Math.max(4, Math.ceil((toU(ymaxRaw, r) + span * 0.06 - ymin) / step));
  const nT = Math.round((ymax - ymin) / step);
  const Y = (v) => T + (1 - (toU(v, r) - ymin) / (ymax - ymin)) * (Hh - T - B);
  let g = svgEl(W, Hh);
  for (let k = 0; k <= nT; k++) { const val = ymin + step * k; const y = Y(r === 'cpu' ? val * 1000 : val * 1024); g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="${C.grid}"/>` + tickLabel(4, y, val.toFixed(2)); }
  for (const m of [0.001, 0.01, 0.1].concat(r === 'mem' ? [0.0001] : [])) { if (m < xmin) continue; const x = X(m); g += `<line x1="${x}" x2="${x}" y1="${T}" y2="${Hh - B}" stroke="${C.grid}" stroke-dasharray="2 3"/><text x="${x}" y="${Hh - 18}" text-anchor="middle" font-size="10" fill="${C.axis}">${pct(m, m < 0.01 ? 1 : 0)}</text>`; }
  g += `<text x="${(L + W - R) / 2}" y="${Hh - 3}" text-anchor="middle" font-size="10" fill="${C.axis}">Realized miss rate, 7-day replay (log scale) · y: avg request per pod (${unit(r)})</text>`;
  const tx = X(state.target[r]);
  g += `<line x1="${tx}" x2="${tx}" y1="${T}" y2="${Hh - B}" stroke="${C.calibrated}" stroke-dasharray="4 3"/><text x="${tx + 4}" y="${T + 10}" font-size="10" fill="${C.calibrated}">target</text>`;
  for (const k of Object.keys(fams)) {
    const pts = clean(fams[k]);
    g += `<path d="${pathOf(pts.map((p) => X(p.missRate)), pts.map((p) => Y(p.meanReq)))}" fill="none" stroke="${C[k]}" stroke-width="1.6" opacity=".85"/>`;
    for (const p of pts) g += `<circle cx="${X(p.missRate)}" cy="${Y(p.meanReq)}" r="2.4" fill="#fff" stroke="${C[k]}" stroke-width="1.3"/>`;
  }
  const mark = (p, k, label, dy) => { const x = X(p.missRate), y = Y(p.meanReq); const left = x > W - R - label.length * 6 - 12; return `<circle cx="${x}" cy="${y}" r="5" fill="${C[k]}" stroke="#fff" stroke-width="1.5"/><text x="${left ? x - 8 : x + 8}" y="${y + dy}" text-anchor="${left ? 'end' : 'start'}" font-size="10" font-weight="600" fill="${C[k]}">${label}</text>`; };
  g += mark(a.standard, 'standard', r === 'cpu' ? 'p80+10% (today)' : 'max+10% (today)', -6);
  if (r === 'cpu') g += mark(a.fixed, 'fixed', '+15% (today)', 12);
  g += mark(a.calibrated, 'calibrated', 'calibrated', -8);
  el.innerHTML = g + '</svg>';
  $('frontierLeg').innerHTML = `<span><i style="background:${C.standard}"></i>Percentile p50→max</span>` + (r === 'cpu' ? `<span><i style="background:${C.fixed}"></i>Fixed buffer 0→300%</span>` : '') + `<span><i style="background:${C.calibrated}"></i>Calibrated, target sweep</span>`;
  const sameStd = get(state.wl, state.res).stdAtRisk, sameFix = get(state.wl, state.res).fixedAtRisk;
  $('frontierSub').innerHTML = `Lower-left is better. At the calibrated miss rate (${pct(a.calibrated.missRate)}), a tuned percentile needs ${sameStd ? fmtU(sameStd, r) : 'n/a'} ${unit(r)}` +
    (r === 'cpu' && sameFix ? ` and a hindsight-tuned fixed buffer ${fmtU(sameFix, r)} ${unit(r)}` : '') + `; calibrated asks ${fmtU(a.calibrated.meanReq, r)} ${unit(r)} with no hindsight.`;
}

// ---------------- rolling miss chart ----------------
function renderRolling() {
  const { a, s, w } = get(state.wl, state.res); const r = state.res;
  const from = H.PERIODS.replayFrom;
  const series = { calibrated: H.rollingMiss(s, a.calibrated.req, from) };
  if (r === 'cpu') series.fixed = H.rollingMiss(s, a.fixed.req, from); else series.standard = H.rollingMiss(s, a.standard.req, from);
  const el = $('rollChart'); const W = el.clientWidth || 540, Hh = 236;
  const L = 52, R = 16, T = 12, B = 34;
  let mx = state.target[r] * 2;
  for (const k in series) for (const p of series[k]) if (isFinite(p.rate)) mx = Math.max(mx, p.rate);
  const ymax = niceMax(mx * 1.1);
  const n = series.calibrated.length;
  const X = (i) => L + (i / (n - 1)) * (W - L - R);
  const Y = (v) => T + (1 - v / ymax) * (Hh - T - B);
  let g = svgEl(W, Hh);
  for (let k = 0; k <= 4; k++) { const y = T + (1 - k / 4) * (Hh - T - B); g += `<line x1="${L}" x2="${W - R}" y1="${y}" y2="${y}" stroke="${C.grid}"/>` + tickLabel(4, y, pct((ymax * k) / 4, ymax < 0.02 ? 2 : 1)); }
  for (let d = 8; d <= 13; d++) { const i = (d * 288 - from) / 6; const x = X(i); g += `<text x="${x}" y="${Hh - 14}" text-anchor="middle" font-size="10" fill="${C.axis}">${dfmt(d * 288)}</text>`; }
  for (const ev of w.events || []) if (ev.i >= from) { const x = X((ev.i - from) / 6); g += `<line x1="${x}" x2="${x}" y1="${T}" y2="${Hh - B}" stroke="#a5541e" stroke-dasharray="4 3"/>`; }
  g += `<line x1="${L}" x2="${W - R}" y1="${Y(state.target[r])}" y2="${Y(state.target[r])}" stroke="${C.calibrated}" stroke-dasharray="5 4" stroke-width="1.2"/>`;
  for (const k of Object.keys(series)) {
    const pts = series[k];
    g += `<path d="${pathOf(pts.map((_, i) => X(i)), pts.map((p) => Y(p.rate)))}" fill="none" stroke="${C[k]}" stroke-width="${k === 'calibrated' ? 2 : 1.5}"/>`;
  }
  el.innerHTML = g + '</svg>';
  const other = r === 'cpu' ? 'fixed' : 'standard';
  $('rollLeg').innerHTML = `<span><i style="background:${C.calibrated}"></i>Calibrated</span><span><i style="background:${C[other]}"></i>${r === 'cpu' ? 'Predictive +15%' : 'Standard max+10%'}</span><span><i style="background:none;border-top:2px dashed ${C.calibrated};height:0;width:12px;border-radius:0"></i>Target ${pct(state.target[r], 1)}</span>` + ((w.events || []).length ? `<span><i style="background:none;border-top:2px dashed #a5541e;height:0;width:12px;border-radius:0"></i>${w.events[0].label}</span>` : '');
  const ev = w.events && w.events[0];
  let note = `Share of the trailing 24h of 5-minute samples above the request. The calibrated buffer re-tunes itself after every 30-minute block (step size γ = ${a.d.gamma}).`;
  if (ev && r === 'cpu') {
    const k0 = (ev.i - from) / 6; const pre = series.fixed[k0 - 1]?.rate, peakF = Math.max(...series.fixed.slice(k0, k0 + 48).map((p) => p.rate)), peakC = Math.max(...series.calibrated.slice(k0, k0 + 48).map((p) => p.rate));
    note = `After the ${ev.label} on ${dfmt(ev.i)} raised CPU per request, the fixed buffer's 24h miss rate peaked at ${pct(peakF, 1)}; the calibrated buffer peaked at ${pct(peakC, 1)} and then widened until it was back under target.`;
  }
  $('rollSub').innerHTML = note;
}

// ---------------- cards ----------------
function renderCards() {
  const cpu = get(state.wl, 'cpu'), mem = get(state.wl, 'mem'); const w = cpu.w; const r = state.res; const cur = r === 'cpu' ? cpu : mem;
  const cpuSave = cpu.stdAtRisk ? H.monthlyCost(cpu.stdAtRisk, w.pods, 'cpu') - H.monthlyCost(cpu.a.calibrated.meanReq, w.pods, 'cpu') : 0;
  const memSave = mem.stdAtRisk ? H.monthlyCost(mem.stdAtRisk, w.pods, 'mem') - H.monthlyCost(mem.a.calibrated.meanReq, w.pods, 'mem') : 0;
  const base = (cpu.stdAtRisk ? H.monthlyCost(cpu.stdAtRisk, w.pods, 'cpu') : 0) + (mem.stdAtRisk ? H.monthlyCost(mem.stdAtRisk, w.pods, 'mem') : 0);
  const save = cpuSave + memSave; const red = base ? save / base : 0;
  const dCpu = cpu.stdAtRisk ? cpu.stdAtRisk - cpu.a.calibrated.meanReq : NaN;
  const dMem = mem.stdAtRisk ? mem.stdAtRisk - mem.a.calibrated.meanReq : NaN;
  const arrow = (d) => (d >= 0 ? `<span class="tri pos">▼</span>` : `<span class="tri neg">▲</span>`);
  $('savCard').innerHTML = `
    <div><div class="k">Est. monthly savings, same risk <i class="ti ti-info-circle" title="Monthly cost of a percentile + 10% rule tuned to the same realized miss rate, minus calibrated, across ${w.pods} pods. $${H.PRICE.vcpuHour}/vCPU-h, $${H.PRICE.gibHour}/GiB-h."></i></div>
      <div class="metric ${save < 0 ? 'neg' : ''}">${money(save)}<small>/mo</small></div>
      <div class="bar"><i style="width:${Math.max(0, Math.min(100, red * 100)).toFixed(1)}%"></i></div>
      <div class="pct-line"><b class="${save < 0 ? 'neg' : ''}">${pct(red)}</b><span class="sub">vs. tuned percentile</span></div>
      <div style="display:flex;gap:22px;margin-top:14px"><div><div class="k">Calibrated req / pod</div><div class="mval">${fmtU(cpu.a.calibrated.meanReq, 'cpu')}<small>CPU</small></div></div>
      <div><div class="k">Percentile @ ${pct(cpu.a.calibrated.missRate)} miss</div><div class="mval">${cpu.stdAtRisk ? fmtU(cpu.stdAtRisk, 'cpu') : 'n/a'}<small>CPU</small></div></div></div></div>
    <div class="vdiv"><div><div class="k">CPU difference / pod</div><div class="mval">${isNaN(dCpu) ? 'n/a' : arrow(dCpu) + Math.abs(dCpu / 1000).toFixed(3)}<small>CPU</small></div></div>
      <div><div class="k">Memory difference / pod</div><div class="mval">${isNaN(dMem) ? 'n/a' : arrow(dMem) + Math.abs(dMem / 1024).toFixed(3)}<small>GiB</small></div></div>
      <div><div class="k">Pods</div><div class="mval">${w.pods}<small>replicas</small></div></div></div>`;
  const c = cur.a.calibrated; const last = c.alphaPath[c.alphaPath.length - 1];
  const fixedMiss = r === 'cpu' ? cur.a.fixed.missRate : cur.a.standard.missRate;
  $('calCard').innerHTML = `
    <div class="hd"><h3>Calibrated headroom</h3><i class="ti ti-info-circle" title="Adaptive conformal inference on forecast residuals"></i><span class="sp"></span>
      <span class="sub" style="margin-right:6px">Target</span><div class="seg-target" id="segTarget">${TARGETS[r].map((t) => `<button data-t="${t}" class="${t === state.target[r] ? 'on' : ''}">${pct(t, t < 0.01 ? (t < 0.001 ? 2 : 1) : 0)}</button>`).join('')}</div></div>
    <div class="cal-grid">
      <div><div class="k">Target miss rate</div><div class="mval">${pct(state.target[r], state.target[r] < 0.01 ? 2 : 1)}</div><div class="sub" style="text-transform:none;letter-spacing:0">5-min samples over request</div></div>
      <div><div class="k">Realized, 7-day replay</div><div class="mval">${pct(c.missRate)}</div><div class="sub" style="text-transform:none;letter-spacing:0">${c.misses} of ${c.samples} · ${r === 'cpu' ? '+15% buffer' : 'max+10%'}: ${pct(fixedMiss)}</div></div>
      <div><div class="k">Buffer now</div><div class="mval">+${((last.q - 1) * 100).toFixed(1)}%</div><div class="sub" style="text-transform:none;letter-spacing:0">${r === 'cpu' ? 'vs. fixed +15%' : 'over forecast'} · ${dfmt(last.s, true).replace(' UTC', '')}</div></div>
    </div>
    <div class="cal-foot">Buffer = conformal (1−α<sub>t</sub>) quantile of usage ÷ forecast over the last 3 days; α<sub>t</sub> self-corrects every 30 minutes (adaptive conformal inference), so the long-run miss rate converges to the target.</div>`;
  $('segTarget').querySelectorAll('button').forEach((b) => b.addEventListener('click', () => { state.target[r] = Number(b.dataset.t); renderAll(); }));
}

// ---------------- fleet table ----------------
function renderFleet() {
  const r = 'cpu'; const target = state.target.cpu;
  const rows = DATA.workloads.map((w, i) => ({ i, w, ...get(i, r) }));
  const cal = rows.map((x) => x.a.calibrated.missRate), fix = rows.map((x) => x.a.fixed.missRate);
  const pods = rows.reduce((t, x) => t + x.w.pods, 0);
  const pw = (arr) => arr.reduce((t, v, i) => t + v * rows[i].w.pods, 0) / pods;
  const calCost = rows.reduce((t, x) => t + H.monthlyCost(x.a.calibrated.meanReq, x.w.pods, r), 0);
  const worstCal = Math.max(...cal);
  // smallest single fleet-wide buffer whose worst workload is no worse than calibrated's worst
  let fleetBuf = null;
  const grid = rows[0].fr.fixed.map((p) => p.buffer);
  for (const b of grid) {
    const worst = Math.max(...rows.map((x) => x.fr.fixed.find((p) => p.buffer === b).missRate));
    if (worst <= worstCal + 1e-12) { fleetBuf = { b, cost: rows.reduce((t, x) => t + H.monthlyCost(x.fr.fixed.find((p) => p.buffer === b).meanReq, x.w.pods, r), 0), worst }; break; }
  }
  const saveStd = rows.reduce((t, x) => t + (x.stdAtRisk ? H.monthlyCost(x.stdAtRisk, x.w.pods, r) - H.monthlyCost(x.a.calibrated.meanReq, x.w.pods, r) : 0), 0);
  const above = fix.filter((v) => v > target * 1.5).length;
  $('fleetNote').textContent = `CPU · ${rows.length} workloads · ${pods} pods · replay ${dfmt(H.PERIODS.replayFrom)} – ${dfmt(4031)}`;
  $('fleetSum').innerHTML = `
    <div><div class="k">Calibrated, target ${pct(target, 1)}</div><div class="mval">${pct(Math.min(...cal))} – ${pct(worstCal)}</div><div class="sub" style="text-transform:none;letter-spacing:0">realized range · pod-weighted ${pct(pw(cal))}</div></div>
    <div><div class="k">Predictive +15% (fixed)</div><div class="mval">${pct(Math.min(...fix))} – ${pct(Math.max(...fix))}</div><div class="sub" style="text-transform:none;letter-spacing:0">${above} of ${rows.length} workloads above 1.5× target</div></div>
    <div><div class="k">One fleet-wide buffer, same worst case</div><div class="mval">${fleetBuf ? `+${Math.round(fleetBuf.b * 100)}% · ${money(fleetBuf.cost)}<small>/mo</small>` : 'none ≤ 300%'}</div><div class="sub" style="text-transform:none;letter-spacing:0">vs. calibrated ${money(calCost)}/mo${fleetBuf ? ` (${pct(1 - calCost / fleetBuf.cost, 0)} less)` : ''}</div></div>
    <div><div class="k">vs. standard at matched risk</div><div class="mval ${saveStd < 0 ? 'neg' : 'pos'}">${money(saveStd)}<small>/mo</small></div><div class="sub" style="text-transform:none;letter-spacing:0">percentile tuned per workload, + 10%</div></div>`;
  const pill = (m) => `<span class="pill ${m <= target * 1.5 ? 'ok' : m <= target * 3 ? 'warn' : 'bad'}">${pct(m)}</span>`;
  const so = '<i class="ti ti-arrows-sort"></i>', inf = '<i class="ti ti-info-circle"></i>';
  let h = `<thead><tr><th class="cb"><span class="cbx"></span></th><th>ID / Workload ${so}</th><th class="r">Pods ${so}</th><th class="r">Miss · +15% ${inf}${so}</th><th class="r">Miss · calibrated ${inf}${so}</th><th class="r">Buffer ${so}</th><th class="r">Req / pod ${so}</th><th class="r">Std @ same risk ${inf}</th><th class="r">Savings/mo ${inf}${so}</th></tr></thead><tbody>`;
  for (const x of rows) {
    const c = x.a.calibrated; const last = c.alphaPath[c.alphaPath.length - 1];
    const sv = x.stdAtRisk ? H.monthlyCost(x.stdAtRisk, x.w.pods, r) - H.monthlyCost(c.meanReq, x.w.pods, r) : null;
    h += `<tr class="row ${x.i === state.wl ? 'sel-row' : ''}" data-i="${x.i}"><td class="cb"><span class="cbx"></span></td><td class="wcell"><div class="wl"><span class="wl-dot"></span>${x.w.name}</div><div class="wl-sub">${x.w.kind} · ${x.w.namespace} · ${x.w.notes}</div></td><td class="r">${x.w.pods}</td><td class="r">${pill(x.a.fixed.missRate)}</td><td class="r">${pill(c.missRate)}</td><td class="r">+${((last.q - 1) * 100).toFixed(0)}%</td><td class="r">${fmtU(c.meanReq, r)}</td><td class="r">${x.stdAtRisk ? fmtU(x.stdAtRisk, r) : 'n/a'}</td><td class="r ${sv !== null && sv < 0 ? 'neg' : sv ? 'pos' : ''}">${sv === null ? 'n/a' : money(sv)}</td></tr>`;
  }
  $('fleetTable').innerHTML = h + '</tbody>';
  $('countRow').innerHTML = `${rows.length} workloads<i class="ti ti-settings"></i>`;
  $('fleetTable').querySelectorAll('tr.row').forEach((tr) => tr.addEventListener('click', () => { state.wl = Number(tr.dataset.i); renderAll(); window.scrollTo({ top: 0, behavior: 'smooth' }); }));
}

// ---------------- settings + events ----------------
function renderSettings() {
  const r = state.res; const t = state.target[r];
  $('settingsCard').innerHTML = `
    <div class="set-nav"><div>Optimized resources<small>CPU (default), Memory (default)</small></div><div>When to apply changes<small>Immediate</small></div><div>Overhead<small>CPU 10%, Memory 10%</small></div><div>Recommendation percentile<small>CPU p80, Memory max</small></div><div class="on">Headroom <span class="new-pill">New</span><small style="color:var(--blue-500)">Calibrated · ${pct(t, 1)} target</small></div><div>Look-back period<small>CPU 24h, Memory 24h</small></div><div>Startup metrics<small>Default</small></div></div>
    <div><div class="mini-hd" style="padding:0 0 4px"><h3>Headroom</h3></div><div class="mini-sub" style="padding:0 0 12px">How much room to leave above the forecast. Applies to ${r === 'cpu' ? 'CPU' : 'memory'} recommendations for workloads in this policy.</div>
      <div class="opt"><span class="rd"></span><div><h4>Fixed buffer</h4><p>Forecast × (1 + 15%). Same margin for every workload; the resulting miss rate depends on each workload's noise (${pct(get(state.wl, 'cpu').a.fixed.missRate)} for ${DATA.workloads[state.wl].name}).</p></div></div>
      <div class="opt on"><span class="rd"></span><div><h4>Calibrated to a target miss rate</h4><p>Pick the share of 5-minute samples allowed above the request. Each workload gets its own buffer from the quantiles of its recent usage ÷ forecast, corrected online so the long-run rate stays at the target through drift and rollouts.</p></div></div>
      <pre class="code">metadata:
  annotations:
    workloads.cast.ai/configuration: |
      vertical:
        ${r === 'cpu' ? 'cpu' : 'memory'}:
          headroom:              # proposed field (concept)
            mode: calibrated
            targetMissRate: ${t}
            calibrationWindow: 72h
            stepSize: ${H.DEFAULTS[r].gamma}</pre></div>`;
}

function renderEvents() {
  const { a } = get(state.wl, state.res);
  const evs = H.bufferEvents(a.calibrated.alphaPath, 7);
  $('eventsCard').innerHTML = `<div class="tc-hd"><h3>Latest headroom events</h3><span class="sp"></span><span class="sub">largest buffer moves during the replay</span></div>` +
    evs.map((e) => `<div class="ev"><span class="t">${dfmt(e.s, true)}</span><span>Buffer ${e.change > 0 ? 'raised' : 'lowered'} from <b>+${((e.from - 1) * 100).toFixed(1)}%</b> to <b>+${((e.to - 1) * 100).toFixed(1)}%</b>${e.prevErr > 0 ? ` after ${Math.round(e.prevErr * 6)} of 6 samples in the previous block exceeded the request` : ' as quiet blocks let the target loosen'}</span><span style="text-align:right"><span class="pill ${e.change > 0 ? 'warn' : 'ok'}">${e.change > 0 ? 'Upscaled' : 'Downscaled'}</span></span></div>`).join('');
}

// ---------------- wiring ----------------
function renderAll() {
  const w = DATA.workloads[state.wl];
  $('wlName').textContent = w.name;
  $('wlKind').textContent = `${w.kind} · ${w.namespace}`;
  $('applied').textContent = `Applied ${w.pods}/${w.pods}`;
  $('wlSelect').value = String(state.wl);
  document.title = `${w.name} · Workload autoscaler · Cast AI (concept: Calibrated headroom)`;
  document.querySelectorAll('#resTabs button').forEach((b) => b.classList.toggle('on', b.dataset.r === state.res));
  document.querySelectorAll('#stratTabs button').forEach((b) => { b.classList.toggle('on', b.dataset.s === state.strat); b.disabled = state.res === 'mem' && b.dataset.s === 'fixed'; b.style.opacity = b.disabled ? .45 : 1; });
  renderCards(); renderLegend(); renderMain(); renderFrontier(); renderRolling(); renderFleet(); renderSettings(); renderEvents();
}

async function boot() {
  DATA = await (await fetch('data/fleet.json')).json();
  $('clusterName').textContent = DATA.cluster;
  $('wlSelect').innerHTML = DATA.workloads.map((w, i) => `<option value="${i}">${w.name}</option>`).join('');
  $('wlSelect').addEventListener('change', (e) => { state.wl = Number(e.target.value); renderAll(); });
  document.querySelectorAll('#resTabs button').forEach((b) => b.addEventListener('click', () => { state.res = b.dataset.r; if (state.res === 'mem' && state.strat === 'fixed') state.strat = 'calibrated'; renderAll(); }));
  document.querySelectorAll('#stratTabs button').forEach((b) => b.addEventListener('click', () => { if (b.disabled) return; state.strat = b.dataset.s; renderAll(); }));
  document.querySelectorAll('#mainTabs div').forEach((t) => t.addEventListener('click', () => {
    state.tab = t.dataset.t; document.querySelectorAll('#mainTabs div').forEach((x) => x.classList.toggle('on', x === t));
    for (const k of ['charts', 'settings', 'events']) $('tab-' + k).classList.toggle('hidden', k !== state.tab);
    if (state.tab === 'charts') renderAll();
  }));
  window.addEventListener('resize', () => { renderMain(); renderFrontier(); renderRolling(); });
  // deep links, e.g. ?wl=10&res=mem&strat=standard&target=0.02&tab=settings
  const q = new URLSearchParams(location.search);
  if (q.has('wl')) state.wl = Math.max(0, Math.min(DATA.workloads.length - 1, Number(q.get('wl')) || 0));
  if (q.get('res') === 'mem') state.res = 'mem';
  if (['standard', 'fixed', 'calibrated'].includes(q.get('strat'))) state.strat = q.get('strat');
  if (state.res === 'mem' && state.strat === 'fixed') state.strat = 'calibrated';
  if (q.has('target') && TARGETS[state.res].includes(Number(q.get('target')))) state.target[state.res] = Number(q.get('target'));
  renderAll();
  if (['settings', 'events'].includes(q.get('tab'))) document.querySelector(`#mainTabs div[data-t="${q.get('tab')}"]`).click();
}
boot();
