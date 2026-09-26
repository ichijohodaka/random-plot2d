// random-plot2d — 多変数関数の変数と関数値から任意の2つを選んで散布図にする。
//
// 入力 x ∈ R^n を区間の中で乱数に振り、y = F(x) ∈ R^m を求める。
// 1点は Z = (x, y) ∈ R^(n+m) で、その n+m 本の列から横軸・縦軸を1本ずつ選ぶ。
//
// 回路には依存しない。応用側は次の形の model を渡すだけでよい。
//
//   const model = {
//     name: '…',
//     vars: [{id, label, unit, value, lo, hi, dist:'log'|'lin', min, max, step}, …],
//     outs: [{id, label, unit, scale:'log'|'lin'}, …],
//     eval(x, y){ … }   // x: Float64Array(n) を読み、y: Float64Array(m) に全部書く
//   };
//   RandomPlot2D.mount(document.getElementById('app'), model, {n: 200000});
//
// ブラウザでは RandomPlot2D を大域に置き、Node では module.exports にする。
(function (root, factory) {
  const RP = factory();
  if (typeof module === 'object' && module.exports) module.exports = RP;
  else root.RandomPlot2D = RP;
})(typeof self !== 'undefined' ? self : this, function () {
'use strict';

// ===================================================================
// 計算の核（DOM に触らない。Node の試験はここだけを見る）
// ===================================================================

// 対数一様の変数に既定で与える下限。0 や負の値は log に乗らない。
const LOG_MIN = 1e-300;

function mulberry32(a){
  return function(){
    a |= 0; a = a + 0x6D2B79F5 | 0;
    let t = Math.imul(a ^ a >>> 15, 1 | a);
    t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t;
    return ((t ^ t >>> 14) >>> 0) / 4294967296;
  };
}

// 変数ごとに別の乱数列を使う。ある変数の区間を変えても、
// ほかの変数の標本は同じままになる（見比べるときにちらつかない）。
function streamSeed(seed, k){
  let h = (seed ^ Math.imul(k + 1, 0x9E3779B1)) >>> 0;
  h = Math.imul(h ^ h >>> 16, 0x85EBCA6B);
  h = Math.imul(h ^ h >>> 13, 0xC2B2AE35);
  return (h ^ h >>> 16) >>> 0;
}

// dist / scale の空間への写像。log なら log10、lin ならそのまま。
const fwd = (kind, v) => kind === 'log' ? Math.log10(v) : v;
const inv = (kind, t) => kind === 'log' ? Math.pow(10, t) : t;
const clamp = (v, a, b) => v < a ? a : (v > b ? b : v);

function normalizeModel(model){
  if (!model || typeof model !== 'object') throw new Error('model がありません');
  if (typeof model.eval !== 'function') throw new Error('model.eval(x, y) がありません');
  if (!Array.isArray(model.vars) || model.vars.length === 0) throw new Error('model.vars が空です');
  const outs0 = model.outs || [];
  if (!Array.isArray(outs0)) throw new Error('model.outs は配列にしてください');

  const seen = new Set();
  const useId = (id, what) => {
    if (typeof id !== 'string' || id === '') throw new Error(what + ' の id がありません');
    if (seen.has(id)) throw new Error('id が重複しています: ' + id);
    seen.add(id);
  };

  const vars = model.vars.map((v, i) => {
    useId(v && v.id, '変数 ' + i);
    const dist = v.dist === undefined ? 'lin' : v.dist;
    if (dist !== 'lin' && dist !== 'log') throw new Error(v.id + ': dist は lin か log です');
    const min = v.min === undefined ? (dist === 'log' ? LOG_MIN : -Infinity) : +v.min;
    const max = v.max === undefined ? Infinity : +v.max;
    if (dist === 'log' && !(min > 0)) throw new Error(v.id + ': 対数一様なら min は正にしてください');
    if (!(min < max)) throw new Error(v.id + ': min < max になっていません');
    const value = +v.value;
    if (!isFinite(value)) throw new Error(v.id + ': value が数ではありません');
    if (value < min || value > max) throw new Error(v.id + ': value が [min, max] の外です');
    const lo = v.lo === undefined ? value : +v.lo;
    const hi = v.hi === undefined ? value : +v.hi;
    if (!(lo <= hi) || lo < min || hi > max) throw new Error(v.id + ': lo ≤ hi かつ [min, max] の中にしてください');
    let step = v.step;
    if (step === undefined){
      if (dist === 'log') step = 0.02;
      else if (isFinite(min) && isFinite(max)) step = (max - min)/200;
      else step = Math.max(Math.abs(value), 1)*0.01;
    }
    if (!(step > 0)) throw new Error(v.id + ': step は正にしてください');
    return {
      kind:'var', index:i, id:v.id, label: v.label ?? v.id, unit: v.unit ?? '',
      dist, min, max, value, lo, hi, step,
    };
  });

  const outs = outs0.map((o, j) => {
    useId(o && o.id, '関数 ' + j);
    const scale = o.scale === undefined ? 'lin' : o.scale;
    if (scale !== 'lin' && scale !== 'log') throw new Error(o.id + ': scale は lin か log です');
    return {kind:'out', index:j, id:o.id, label: o.label ?? o.id, unit: o.unit ?? '', scale};
  });

  return {
    name: model.name ?? '',
    vars, outs,
    cols: [...vars, ...outs],   // 列番号 0..n-1 が変数、n..n+m-1 が関数値
    n: vars.length, m: outs.length,
    eval: model.eval.bind(model),
  };
}

// 標本を取りながら、指定した列だけを N 点ぶん埋める。
//
// ranges[i] = {lo, hi, dist}（実際の値）。lo === hi ならその値に固定する。
// 全 n+m 列は持たない（N = 10^6 で WPT なら数百 MB になる）。
// 画面を止めないよう、step(k) で k 点ずつ進める。
function createJob(M, ranges, colIdx, N, seed){
  const n = M.n;
  const x = new Float64Array(n), y = new Float64Array(M.m);
  const varying = [];
  for (let i = 0; i < n; i++){
    const r = ranges[i];
    if (r.lo === r.hi){ x[i] = r.lo; continue; }
    const a = fwd(r.dist, r.lo);
    varying.push({i, a, d: fwd(r.dist, r.hi) - a, log: r.dist === 'log',
                  rnd: mulberry32(streamSeed(seed, i))});
  }
  const cols = colIdx.map(c => ({
    col: c, isVar: c < n, k: c < n ? c : c - n, arr: new Float64Array(N),
  }));
  const needEval = cols.some(o => !o.isVar);
  let done = 0;
  return {
    N, cols,
    get done(){ return done; },
    step(k){
      const end = Math.min(N, done + k);
      for (let p = done; p < end; p++){
        for (let q = 0; q < varying.length; q++){
          const v = varying[q], t = v.a + v.d*v.rnd();
          x[v.i] = v.log ? Math.pow(10, t) : t;
        }
        if (needEval) M.eval(x, y);
        for (let q = 0; q < cols.length; q++){
          const o = cols[q];
          o.arr[p] = o.isVar ? x[o.k] : y[o.k];
        }
      }
      done = end;
      return done === N;
    },
  };
}

function runJob(M, ranges, colIdx, N, seed){
  const j = createJob(M, ranges, colIdx, N, seed);
  j.step(N);
  return j.cols.map(o => o.arr);
}

// 描けない点を数える。log 軸で 0 以下のものと、NaN・±∞。
function countInvalid(arr, log){
  let nonpos = 0, nonfinite = 0;
  for (let i = 0; i < arr.length; i++){
    const v = arr[i];
    if (!isFinite(v)) nonfinite++;
    else if (log && !(v > 0)) nonpos++;
  }
  return {nonpos, nonfinite};
}

// 範囲に余白を足す。幅が 0（固定値）なら見える幅をこしらえる。
function padRange(lo, hi, log){
  const span = hi - lo;
  if (!(span > Math.max(Math.abs(lo), Math.abs(hi))*1e-12)){
    const c = (lo + hi)/2;
    const w = log ? 0.5 : (c !== 0 ? Math.abs(c)*0.1 : 1);
    return [c - w, c + w];
  }
  const p = span*0.04;
  return [lo - p, hi + p];
}

// 分位点で表示範囲を決める（返すのは log なら log10 の空間）。
// min/max だと共振の鋭い山ひとつで残りがつぶれるので、両端 q を捨てる。
// 捨てた点は描画の側で端に寄せて見せる。
function quantileRange(arr, log, q = 0.005, maxSample = 100000){
  const stride = Math.max(1, Math.floor(arr.length / maxSample));
  const buf = [];
  for (let i = 0; i < arr.length; i += stride){
    let v = arr[i];
    if (log){ if (!(v > 0)) continue; v = Math.log10(v); }
    if (isFinite(v)) buf.push(v);
  }
  if (buf.length === 0) return null;
  const s = Float64Array.from(buf).sort();
  const L = s.length - 1;
  return padRange(s[Math.floor(q*L)], s[Math.ceil((1 - q)*L)], log);
}

// 1・2・5 刻みの目盛り。
function niceTicks(a, b, maxN){
  const span = b - a;
  if (!(span > 0)) return {step: 0, ticks: []};
  const raw = span / Math.max(1, maxN);
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const r = raw / mag;
  const step = (r <= 1 ? 1 : r <= 2 ? 2 : r <= 5 ? 5 : 10)*mag;
  const s0 = Math.ceil(a/step), s1 = Math.floor(b/step);
  const ticks = [];
  for (let s = s0; s <= s1; s++) ticks.push(s === 0 ? 0 : s*step);
  return {step, ticks};
}

// 対数軸の目盛り。t は log10 の値。label の付かないものは短い補助目盛り。
function logTicks(t0, t1, maxN){
  const span = t1 - t0;
  if (!(span > 0)) return [];
  if (span < 1){   // 1桁に満たないときは実際の値で等間隔に刻む
    const lin = niceTicks(Math.pow(10, t0), Math.pow(10, t1), maxN);
    return lin.ticks.filter(v => v > 0).map(v => ({t: Math.log10(v), v, label: true, step: lin.step}));
  }
  const out = [];
  const k = Math.max(1, Math.ceil(span / Math.max(1, maxN)));
  for (let e = Math.floor(t0); e <= Math.ceil(t1); e++){
    if (((e % k) + k) % k === 0 && e >= t0 && e <= t1) out.push({t: e, v: Math.pow(10, e), label: true});
    if (k === 1){
      for (let mm = 2; mm <= 9; mm++){
        const t = e + Math.log10(mm);
        if (t < t0 || t > t1) continue;
        out.push({t, v: mm*Math.pow(10, e), label: span <= 2.5 && (mm === 2 || mm === 5)});
      }
    }
  }
  return out.sort((p, q) => p.t - q.t);
}

const SI_PREFIX = {'-15':'f', '-12':'p', '-9':'n', '-6':'µ', '-3':'m', '0':'', '3':'k', '6':'M', '9':'G', '12':'T'};
const SI_EXP    = {f:-15, p:-12, n:-9, u:-6, 'µ':-6, 'μ':-6, m:-3, k:3, K:3, M:6, G:9, T:12};

// 有効数字 sig 桁で、SI 接頭辞を付けて書く（100000 → 100k）。
function formatSI(v, sig = 4){
  if (v === 0) return '0';
  if (!isFinite(v)) return String(v);
  let e = clamp(Math.floor(Math.log10(Math.abs(v))/3)*3, -15, 12);
  let s = Number((v/Math.pow(10, e)).toPrecision(sig));
  if (Math.abs(s) >= 1000 && e < 12){ e += 3; s = Number((v/Math.pow(10, e)).toPrecision(sig)); }
  return String(s) + SI_PREFIX[e];
}

// 目盛りの値を、刻み幅から見て足りるだけの桁で書く。
function formatTick(v, step){
  if (v === 0 || !(step > 0)) return formatSI(v, 3);
  const d = Math.floor(Math.log10(Math.abs(v))) - Math.floor(Math.log10(step)) + 1;
  return formatSI(v, clamp(d, 1, 12));
}

// '100u', '4.7k', '1meg', '2.2e-6', '10uH' を読む。m はミリ、M と meg はメガ。
function parseSI(str){
  const m = /^\s*([+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)\s*(meg|MEG|Meg|[fpnuµμmkKMGT])?[A-Za-zΩ°%]*\s*$/.exec(String(str));
  if (!m) return NaN;
  if (!m[2]) return parseFloat(m[1]);
  // 掛け算にすると 100*1e-6 = 9.999…e-5 になるので、指数に足してから読む
  const e = m[2].toLowerCase() === 'meg' ? 6 : SI_EXP[m[2]];
  const [, mant, ex] = /^([^eE]+)(?:[eE]([+-]?\d+))?$/.exec(m[1]);
  return Number(mant + 'e' + ((ex ? +ex : 0) + e));
}

const core = {
  LOG_MIN, mulberry32, streamSeed, fwd, inv, normalizeModel, createJob, runJob,
  countInvalid, padRange, quantileRange, niceTicks, logTicks, formatSI, formatTick, parseSI,
};

// ===================================================================
// 画面
// ===================================================================

const N_CHOICES = [1e4, 2e4, 5e4, 1e5, 2e5, 5e5, 1e6, 2e6, 5e6, 1e7];
const PAD = {l: 76, r: 14, t: 10, b: 44};   // 描画域の外側の余白（CSS px）
const SLICE_MS = 25;                         // 一度に計算し続ける時間の上限

function h(tag, attrs, ...kids){
  const el = document.createElement(tag);
  if (attrs) for (const k in attrs){
    if (k === 'class') el.className = attrs[k];
    else if (k === 'text') el.textContent = attrs[k];
    else el.setAttribute(k, attrs[k]);
  }
  for (const c of kids) if (c != null) el.append(c);
  return el;
}

function parseRamp(str){
  const stops = String(str).split(',').map(s => s.trim()).filter(Boolean).map(s => {
    const m = /^#?([0-9a-f]{6})$/i.exec(s);
    if (!m) return null;
    const n = parseInt(m[1], 16);
    return [n >> 16 & 255, n >> 8 & 255, n & 255];
  }).filter(Boolean);
  return stops.length >= 2 ? stops : [[127,179,230],[43,108,176],[26,54,93],[11,15,26]];
}

function buildLUT(stops){
  const lut = new Uint8ClampedArray(256*4);
  for (let i = 0; i < 256; i++){
    const t = i/255*(stops.length - 1);
    const k = Math.min(stops.length - 2, Math.floor(t)), f = t - k;
    for (let c = 0; c < 3; c++) lut[i*4 + c] = stops[k][c] + (stops[k + 1][c] - stops[k][c])*f;
    lut[i*4 + 3] = 255;
  }
  return lut;
}

function mount(root, model, opts = {}){
  const M = normalizeModel(model);
  const cols = M.cols;

  // ---------------- 状態 ----------------
  // 変数は dist の空間で「中心 c・半幅 h」を持つ。value は中心の実際の値で、
  // 固定（h = 0）のときに log10 を往復させずにそのまま使うため別に持つ。
  const st = {
    n: opts.n ?? 200000,
    seed: (opts.seed ?? 1) >>> 0,
    edge: opts.edge ?? true,
    gamma: opts.gamma ?? 0.6,
    psize: opts.psize ?? 1,
    vars: M.vars.map(v => {
      const a = fwd(v.dist, v.lo), b = fwd(v.dist, v.hi);
      return v.lo === v.hi ? {c: fwd(v.dist, v.value), h: 0, value: v.value}
                           : {c: (a + b)/2, h: (b - a)/2, value: inv(v.dist, (a + b)/2)};
    }),
  };
  const defX = Math.max(0, M.vars.findIndex(v => v.lo < v.hi));
  const defY = M.m > 0 ? M.n : (M.n > 1 ? 1 : 0);
  const colIndex = id => {
    const i = cols.findIndex(c => c.id === id);
    if (i < 0) throw new Error('列がありません: ' + id);
    return i;
  };
  const defScale = c => cols[c].kind === 'var' ? cols[c].dist : cols[c].scale;
  const initAxis = (o, dflt) => {
    const col = o && o.col !== undefined ? colIndex(o.col) : dflt;
    return {col, scale: (o && o.scale) || defScale(col), link: !!(o && o.link), t0: 0, t1: 1};
  };
  st.ax = {x: initAxis(opts.x, defX), y: initAxis(opts.y, defY)};

  let data = null;                           // {x, y, N, xcol, ycol, ms, bad}
  let pendingAuto = {x: true, y: true};
  let jobGen = 0, computeTimer = 0, drawReq = 0, computing = false;
  let hover = null;

  // ---------------- 組み立て ----------------
  root.classList.add('rp2');
  root.textContent = '';
  const title = opts.title ?? (M.name || 'random-plot2d');

  const varBox = h('div', {class: 'rp2-vars'});
  const nSel = h('select', {class: 'rp2-num'});
  for (const v of N_CHOICES){
    const o = h('option', {value: String(v), text: v.toLocaleString()});
    if (v === st.n) o.selected = true;
    nSel.append(o);
  }
  if (!N_CHOICES.includes(st.n)) nSel.prepend(h('option', {value: String(st.n), text: st.n.toLocaleString(), selected: ''}));
  const seedIn = h('input', {class: 'rp2-num', type: 'number', min: '0', step: '1', value: String(st.seed)});
  const reseed = h('button', {class: 'rp2-btn', type: 'button', text: '引き直し', title: '種を1つ進めて標本を取り直す'});
  const edgeChk = h('input', {type: 'checkbox'}); edgeChk.checked = st.edge;
  const gammaIn = h('input', {type: 'range', min: '0.2', max: '1.5', step: '0.05', value: String(st.gamma)});
  const psizeSel = h('select', {class: 'rp2-num'});
  for (const p of [1, 2, 3]) psizeSel.append(h('option', {value: String(p), text: p + ' px'}));
  psizeSel.value = String(st.psize);

  const panel = h('aside', {class: 'rp2-panel'},
    h('h1', {text: title}),
    h('section', null,
      h('div', {class: 'rp2-hd', text: '変数'}),
      h('div', {class: 'rp2-note', text: 'ホイールで幅を増減（Shift で細かく）。値の欄の上のホイールは中心を動かす。幅 0 は固定値。'}),
      varBox),
    h('section', null,
      h('div', {class: 'rp2-hd', text: 'サンプリング'}),
      h('label', {class: 'rp2-line'}, h('span', {text: '点数'}), nSel),
      h('label', {class: 'rp2-line'}, h('span', {text: '種'}), seedIn, reseed)),
    h('section', null,
      h('div', {class: 'rp2-hd', text: '表示'}),
      h('label', {class: 'rp2-line'}, h('span', {text: '点の大きさ'}), psizeSel),
      h('label', {class: 'rp2-line'}, h('span', {text: '濃さ'}), gammaIn),
      h('label', {class: 'rp2-line'}, edgeChk, h('span', {text: '表示範囲の外の点を端に寄せて描く'}))),
  );

  const axisUI = {};
  const axisBar = h('div', {class: 'rp2-axes'});
  for (const k of ['x', 'y']){
    const sel = h('select', {class: 'rp2-colsel'});
    const gv = h('optgroup', {label: '変数'}), go = h('optgroup', {label: '関数'});
    cols.forEach((c, i) => (c.kind === 'var' ? gv : go).append(h('option', {value: String(i), text: colText(c)})));
    sel.append(gv); if (M.m > 0) sel.append(go);
    const sc = h('button', {class: 'rp2-btn', type: 'button', title: '線形と対数を切り替える'});
    const lk = h('input', {type: 'checkbox'});
    const lkLab = h('label', {class: 'rp2-link', title: 'この変数の乱数の区間を、表示範囲に合わせる（パン・ズームで取り直す）'}, lk, h('span', {text: '表示範囲で振る'}));
    axisBar.append(h('div', {class: 'rp2-axis'}, h('span', {class: 'rp2-axlab', text: k === 'x' ? '横軸' : '縦軸'}), sel, sc, lkLab));
    axisUI[k] = {sel, sc, lk, lkLab};
  }
  const autoBtn = h('button', {class: 'rp2-btn', type: 'button', text: '自動', title: '両軸を見やすい範囲に合わせる（ダブルクリックでも同じ）'});
  axisBar.append(autoBtn);

  const canvas = h('canvas', {class: 'rp2-canvas'});
  const wrap = h('div', {class: 'rp2-wrap'}, canvas);
  const status = h('div', {class: 'rp2-status'});
  const main = h('main', {class: 'rp2-main'}, axisBar, wrap, status);
  root.append(panel, main);

  function colText(c){ return c.label + (c.unit ? ' [' + c.unit + ']' : ''); }

  // ---------------- 変数の行 ----------------
  const rows = M.vars.map((v, i) => {
    const center = h('input', {class: 'rp2-num rp2-center', type: 'text', spellcheck: 'false'});
    const zero = h('button', {class: 'rp2-btn rp2-zero', type: 'button', text: '幅0', title: '幅を 0 にして固定値にする'});
    const tag = h('span', {class: 'rp2-tag'});
    const width = h('span', {class: 'rp2-width'});
    const range = h('div', {class: 'rp2-range'});
    const fill = h('div', {class: 'rp2-fill'}), mark = h('div', {class: 'rp2-mark'});
    const bounded = isFinite(fwd(v.dist, v.min)) && isFinite(v.max) && v.min > (v.dist === 'log' ? LOG_MIN : -Infinity);
    const bar = bounded ? h('div', {class: 'rp2-bar'}, fill, mark) : null;
    const row = h('div', {class: 'rp2-var'},
      h('div', {class: 'rp2-var-hd'},
        h('span', {class: 'rp2-name', text: v.label}),
        v.unit ? h('span', {class: 'rp2-unit', text: '[' + v.unit + ']'}) : null,
        tag, zero),
      h('div', {class: 'rp2-var-bd'}, center, width),
      bar, range);
    varBox.append(row);

    row.addEventListener('wheel', e => {
      if (linkedAxis(i)) return;
      e.preventDefault();
      const s = st.vars[i];
      const d = (e.deltaY < 0 ? 1 : -1) * v.step * (e.shiftKey ? 0.1 : 1);
      const gmin = fwd(v.dist, v.min), gmax = fwd(v.dist, v.max);
      if (e.target === center){
        const c = clamp(s.c + d, gmin + s.h, gmax - s.h);
        s.c = c; s.value = inv(v.dist, c);
      } else {
        let hw = clamp(s.h + d, 0, Math.min(s.c - gmin, gmax - s.c));
        if (hw < v.step*1e-6) hw = 0;
        if (hw === 0) s.c = fwd(v.dist, s.value);   // 固定に戻したら中心は正確な値
        s.h = hw;
      }
      updateRow(i);
      requestCompute(40);
    }, {passive: false});

    center.addEventListener('change', () => {
      const s = st.vars[i];
      let val = parseSI(center.value);
      if (!isFinite(val)){ updateRow(i); return; }
      val = clamp(val, v.min, v.max);
      if (v.dist === 'log' && !(val > 0)){ updateRow(i); return; }
      const gmin = fwd(v.dist, v.min), gmax = fwd(v.dist, v.max);
      s.value = val; s.c = fwd(v.dist, val);
      s.h = Math.min(s.h, s.c - gmin, gmax - s.c);
      updateRow(i);
      requestCompute(0);
    });
    center.addEventListener('keydown', e => { if (e.key === 'Enter') center.blur(); });
    zero.addEventListener('click', () => {
      const s = st.vars[i];
      s.h = 0; s.c = fwd(v.dist, s.value);
      updateRow(i); requestCompute(0);
    });
    return {center, zero, tag, width, range, bar, fill, mark};
  });

  function linkedAxis(i){
    for (const k of ['x', 'y']){
      const a = st.ax[k];
      if (a.link && a.col === i) return k;
    }
    return null;
  }

  // 変数 i の乱数の区間（実際の値）。表示範囲で振る軸があれば、そちらが優先。
  function samplingRange(i){
    const v = M.vars[i], s = st.vars[i];
    const k = linkedAxis(i);
    if (k){
      const a = st.ax[k];
      let lo = inv(a.scale, a.t0), hi = inv(a.scale, a.t1);
      lo = clamp(lo, v.min, v.max); hi = clamp(hi, v.min, v.max);
      if (!(lo < hi)) return {lo, hi: lo, dist: a.scale};
      return {lo, hi, dist: a.scale};
    }
    if (s.h === 0) return {lo: s.value, hi: s.value, dist: v.dist};
    return {lo: inv(v.dist, s.c - s.h), hi: inv(v.dist, s.c + s.h), dist: v.dist};
  }

  function updateRow(i){
    const v = M.vars[i], s = st.vars[i], r = rows[i];
    const k = linkedAxis(i);
    const R = samplingRange(i);
    const u = v.unit ? ' ' + v.unit : '';
    if (document.activeElement !== r.center) r.center.value = formatSI(s.value, 5);
    r.center.disabled = !!k;
    r.zero.disabled = !!k || s.h === 0;
    r.tag.textContent = k ? '表示範囲（' + (k === 'x' ? '横軸' : '縦軸') + '）' : (s.h === 0 ? '固定' : '乱数');
    r.tag.dataset.kind = k ? 'link' : (s.h === 0 ? 'fixed' : 'rand');
    if (k) r.width.textContent = '';
    else if (s.h === 0) r.width.textContent = '幅 0';
    else r.width.textContent = v.dist === 'log' ? '±' + s.h.toFixed(2) + ' 桁' : '±' + formatSI(s.h, 3) + (v.unit ? ' ' + v.unit : '');
    r.range.textContent = R.lo === R.hi ? '' :
      '[' + formatSI(R.lo, 4) + ', ' + formatSI(R.hi, 4) + ']' + u + (R.dist === 'log' ? '　対数一様' : '　一様');
    if (r.bar){
      const g0 = fwd(v.dist, v.min), g1 = fwd(v.dist, v.max);
      const f = x => clamp((fwd(v.dist, x) - g0)/(g1 - g0), 0, 1)*100;
      r.fill.style.left = f(R.lo) + '%';
      r.fill.style.width = Math.max(0, f(R.hi) - f(R.lo)) + '%';
      r.mark.style.left = f(s.value) + '%';
      r.mark.style.display = k ? 'none' : '';
    }
  }

  function updateAxisUI(){
    for (const k of ['x', 'y']){
      const a = st.ax[k], u = axisUI[k];
      u.sel.value = String(a.col);
      u.sc.textContent = a.scale;
      u.lk.checked = a.link;
      u.lkLab.style.display = cols[a.col].kind === 'var' ? '' : 'none';
    }
    M.vars.forEach((_, i) => updateRow(i));
  }

  // ---------------- 計算 ----------------
  function requestCompute(delay){
    clearTimeout(computeTimer);
    computeTimer = setTimeout(startCompute, delay);
  }

  function startCompute(){
    const gen = ++jobGen;
    let job;
    const colIdx = [st.ax.x.col, st.ax.y.col];
    try {
      job = createJob(M, M.vars.map((_, i) => samplingRange(i)), colIdx, st.n, st.seed);
    } catch (err){ fail(err); return; }
    computing = true;
    const t0 = performance.now();
    const slice = () => {
      if (gen !== jobGen) return;
      const ts = performance.now();
      try {
        while (!job.step(10000)){
          if (performance.now() - ts > SLICE_MS){
            setStatus('計算中 ' + Math.round(100*job.done/job.N) + ' %');
            setTimeout(slice, 0);
            return;
          }
        }
      } catch (err){ fail(err); return; }
      computing = false;
      finish(job, colIdx, performance.now() - t0);
    };
    slice();
  }

  function fail(err){
    computing = false;
    setStatus('model.eval でエラー: ' + (err && err.message || err), true);
    if (typeof console !== 'undefined') console.error(err);
  }

  function finish(job, colIdx, ms){
    data = {x: job.cols[0].arr, y: job.cols[1].arr, N: job.N, xcol: colIdx[0], ycol: colIdx[1], ms};
    for (const k of ['x', 'y']){
      if (!pendingAuto[k]) continue;
      pendingAuto[k] = false;
      autoscaleAxis(k);
    }
    scheduleDraw();
  }

  // 表示範囲で振っている軸は、範囲そのものが標本を決めるので合わせない。
  function autoscaleAxis(k){
    const a = st.ax[k];
    if (!data || (a.link && cols[a.col].kind === 'var')) return;
    const arr = k === 'x' ? data.x : data.y;
    const r = quantileRange(arr, a.scale === 'log');
    if (r){ a.t0 = r[0]; a.t1 = r[1]; }
  }

  // ---------------- 描画 ----------------
  const off = document.createElement('canvas');
  let counts = null, dpr = 1;

  function scheduleDraw(){
    if (drawReq) return;
    drawReq = requestAnimationFrame(() => { drawReq = 0; draw(); });
  }

  function geom(){
    const W = canvas.width, H = canvas.height;
    const L = Math.round(PAD.l*dpr), T = Math.round(PAD.t*dpr);
    return {W, H, L, T, PW: Math.max(1, W - L - Math.round(PAD.r*dpr)), PH: Math.max(1, H - T - Math.round(PAD.b*dpr))};
  }

  function css(name, dflt){
    const v = getComputedStyle(root).getPropertyValue(name).trim();
    return v || dflt;
  }

  let lutKey = '', lut = null;
  function getLUT(){
    const key = css('--rp2-ramp', '');
    if (key !== lutKey || !lut){ lutKey = key; lut = buildLUT(parseRamp(key)); }
    return lut;
  }

  function draw(){
    const g = canvas.getContext('2d');
    const {W, H, L, T, PW, PH} = geom();
    const ax = st.ax.x, ay = st.ax.y;
    g.setTransform(1, 0, 0, 1, 0, 0);
    g.clearRect(0, 0, W, H);
    g.fillStyle = css('--rp2-plot-bg', '#fff');
    g.fillRect(L, T, PW, PH);

    const fg = css('--rp2-fg', '#222'), grid = css('--rp2-grid', '#e5e7eb'), axc = css('--rp2-axis', '#888');
    const xt = ticks('x', PW), yt = ticks('y', PH);
    const X = t => L + (t - ax.t0)/(ax.t1 - ax.t0)*PW;
    const Y = t => T + (ay.t1 - t)/(ay.t1 - ay.t0)*PH;

    // 格子
    g.strokeStyle = grid; g.lineWidth = 1;
    g.beginPath();
    for (const t of xt) if (t.label){ const x = Math.round(X(t.t)) + 0.5; g.moveTo(x, T); g.lineTo(x, T + PH); }
    for (const t of yt) if (t.label){ const y = Math.round(Y(t.t)) + 0.5; g.moveTo(L, y); g.lineTo(L + PW, y); }
    g.stroke();

    // 点（画素ごとの点数を数えて、log(1+c) で色を付ける）
    let bad = null;
    if (data && data.xcol === ax.col && data.ycol === ay.col){
      bad = plotDensity(g, L, T, PW, PH);
    }

    // 枠と目盛り
    g.strokeStyle = axc;
    g.strokeRect(L + 0.5, T + 0.5, PW - 1, PH - 1);
    g.fillStyle = fg;
    g.font = (11*dpr) + 'px system-ui, sans-serif';
    g.beginPath();
    g.textAlign = 'center'; g.textBaseline = 'top';
    for (const t of xt){
      const x = Math.round(X(t.t)) + 0.5, len = (t.label ? 5 : 3)*dpr;
      g.moveTo(x, T + PH); g.lineTo(x, T + PH + len);
      if (t.label) g.fillText(t.text, x, T + PH + 7*dpr);
    }
    g.textAlign = 'right'; g.textBaseline = 'middle';
    for (const t of yt){
      const y = Math.round(Y(t.t)) + 0.5, len = (t.label ? 5 : 3)*dpr;
      g.moveTo(L, y); g.lineTo(L - len, y);
      if (t.label) g.fillText(t.text, L - 7*dpr, y);
    }
    g.stroke();

    g.font = (12*dpr) + 'px system-ui, sans-serif';
    g.textAlign = 'center'; g.textBaseline = 'bottom';
    g.fillText(colText(cols[ax.col]) + (ax.scale === 'log' ? '  (log)' : ''), L + PW/2, H - 3*dpr);
    g.save();
    g.translate(13*dpr, T + PH/2); g.rotate(-Math.PI/2);
    g.textBaseline = 'middle';
    g.fillText(colText(cols[ay.col]) + (ay.scale === 'log' ? '  (log)' : ''), 0, 0);
    g.restore();

    if (!computing) showStatus(bad);
  }

  function ticks(k, P){
    const a = st.ax[k];
    const maxN = Math.max(2, Math.floor(P/dpr/(k === 'x' ? 90 : 42)));
    if (a.scale === 'log'){
      return logTicks(a.t0, a.t1, maxN).map(t => ({t: t.t, label: t.label,
        text: t.label ? (t.step ? formatTick(t.v, t.step) : formatSI(t.v, 3)) : ''}));
    }
    const nt = niceTicks(a.t0, a.t1, maxN);
    return nt.ticks.map(v => ({t: v, label: true, text: formatTick(v, nt.step)}));
  }

  function plotDensity(g, L, T, PW, PH){
    const ax = st.ax.x, ay = st.ax.y;
    const ps = Math.max(1, Math.round(st.psize*dpr));
    const BW = Math.ceil(PW/ps), BH = Math.ceil(PH/ps);
    if (!counts || counts.length < BW*BH) counts = new Uint32Array(BW*BH);
    else counts.fill(0, 0, BW*BH);
    const xs = data.x, ys = data.y, N = data.N;
    const xl = ax.scale === 'log', yl = ay.scale === 'log';
    const sx = PW/ps/(ax.t1 - ax.t0), sy = PH/ps/(ay.t1 - ay.t0);
    const x0 = ax.t0, y1 = ay.t1, edge = st.edge;
    let badX = 0, badY = 0, outside = 0;
    for (let i = 0; i < N; i++){
      let xv = xs[i], yv = ys[i], bad = false;
      if (xl) xv = xv > 0 ? Math.log10(xv) : NaN;
      if (yl) yv = yv > 0 ? Math.log10(yv) : NaN;
      if (!isFinite(xv)){ badX++; bad = true; }
      if (!isFinite(yv)){ badY++; bad = true; }
      if (bad) continue;
      let px = Math.floor((xv - x0)*sx), py = Math.floor((y1 - yv)*sy);
      if (px < 0 || px >= BW || py < 0 || py >= BH){
        outside++;
        if (!edge) continue;
        px = px < 0 ? 0 : (px >= BW ? BW - 1 : px);
        py = py < 0 ? 0 : (py >= BH ? BH - 1 : py);
      }
      counts[py*BW + px]++;
    }
    let cmax = 0;
    for (let i = 0; i < BW*BH; i++) if (counts[i] > cmax) cmax = counts[i];
    if (cmax > 0){
      off.width = BW; off.height = BH;
      const og = off.getContext('2d');
      const img = og.createImageData(BW, BH), px = img.data;
      const lt = getLUT();
      const k = 1/Math.log(1 + cmax), gm = st.gamma;
      for (let i = 0; i < BW*BH; i++){
        const c = counts[i];
        if (!c) continue;
        const t = cmax === 1 ? 1 : Math.pow(Math.log(1 + c)*k, gm);
        const j = Math.round(t*255)*4, o = i*4;
        px[o] = lt[j]; px[o + 1] = lt[j + 1]; px[o + 2] = lt[j + 2]; px[o + 3] = 255;
      }
      og.putImageData(img, 0, 0);
      g.save();
      g.imageSmoothingEnabled = false;
      g.beginPath(); g.rect(L, T, PW, PH); g.clip();
      g.drawImage(off, L, T, BW*ps, BH*ps);
      g.restore();
    }
    return {badX, badY, outside};
  }

  // ---------------- 状態表示 ----------------
  let lastBad = null;
  function showStatus(bad){
    if (bad) lastBad = bad;
    if (!data){ setStatus('計算中…'); return; }
    const parts = [data.N.toLocaleString() + ' 点', '計算 ' + Math.round(data.ms) + ' ms'];
    const b = lastBad;
    if (b){
      if (b.badX) parts.push('横軸で描けない点 ' + b.badX.toLocaleString() + (st.ax.x.scale === 'log' ? '（0 以下か非有限）' : '（非有限）'));
      if (b.badY) parts.push('縦軸で描けない点 ' + b.badY.toLocaleString() + (st.ax.y.scale === 'log' ? '（0 以下か非有限）' : '（非有限）'));
      if (b.outside) parts.push('範囲外 ' + b.outside.toLocaleString() + (st.edge ? '（端に表示）' : ''));
    }
    if (hover) parts.push('x = ' + formatSI(hover.x, 5) + ', y = ' + formatSI(hover.y, 5));
    setStatus(parts.join('　|　'));
  }
  function setStatus(text, err){
    status.textContent = text;
    status.classList.toggle('rp2-err', !!err);
  }

  // ---------------- 軸の操作 ----------------
  function zoneAt(e){
    const r = canvas.getBoundingClientRect();
    const px = (e.clientX - r.left)*dpr, py = (e.clientY - r.top)*dpr;
    const {L, T, PW, PH} = geom();
    const inX = px >= L && px <= L + PW, inY = py >= T && py <= T + PH;
    let zone = null;
    if (inX && inY) zone = 'xy';
    else if (inX && py > T + PH) zone = 'x';
    else if (inY && px < L) zone = 'y';
    return {zone, px, py, L, T, PW, PH};
  }

  function viewChanged(which){
    scheduleDraw();
    let relink = false;
    for (const k of which){
      const a = st.ax[k];
      if (a.link && cols[a.col].kind === 'var'){ relink = true; updateRow(a.col); }
    }
    if (relink) requestCompute(150);
  }

  canvas.addEventListener('wheel', e => {
    const z = zoneAt(e);
    if (!z.zone) return;
    e.preventDefault();
    const f = e.deltaY < 0 ? (e.shiftKey ? 0.97 : 0.85) : 1/(e.shiftKey ? 0.97 : 0.85);
    const which = z.zone === 'xy' ? ['x', 'y'] : [z.zone];
    for (const k of which){
      const a = st.ax[k];
      const u = k === 'x' ? (z.px - z.L)/z.PW : 1 - (z.py - z.T)/z.PH;
      const tm = a.t0 + u*(a.t1 - a.t0);
      a.t0 = tm - (tm - a.t0)*f;
      a.t1 = tm + (a.t1 - tm)*f;
    }
    viewChanged(which);
  }, {passive: false});

  let drag = null;
  canvas.addEventListener('pointerdown', e => {
    const z = zoneAt(e);
    if (!z.zone || e.button !== 0) return;
    try { canvas.setPointerCapture(e.pointerId); } catch (_) { /* 取れなくてもドラッグはできる */ }
    drag = {zone: z.zone, x: e.clientX, y: e.clientY, PW: z.PW, PH: z.PH,
            v: {x: [st.ax.x.t0, st.ax.x.t1], y: [st.ax.y.t0, st.ax.y.t1]}};
  });
  canvas.addEventListener('pointermove', e => {
    const z = zoneAt(e);
    canvas.style.cursor = drag ? 'grabbing' : (z.zone === 'x' ? 'ew-resize' : z.zone === 'y' ? 'ns-resize' : z.zone ? 'grab' : '');
    if (drag){
      const which = drag.zone === 'xy' ? ['x', 'y'] : [drag.zone];
      for (const k of which){
        const a = st.ax[k], v = drag.v[k], span = v[1] - v[0];
        const d = k === 'x' ? -(e.clientX - drag.x)*dpr/drag.PW*span : (e.clientY - drag.y)*dpr/drag.PH*span;
        a.t0 = v[0] + d; a.t1 = v[1] + d;
      }
      viewChanged(which);
      return;
    }
    if (z.zone === 'xy'){
      const ax = st.ax.x, ay = st.ax.y;
      hover = {x: inv(ax.scale, ax.t0 + (z.px - z.L)/z.PW*(ax.t1 - ax.t0)),
               y: inv(ay.scale, ay.t1 - (z.py - z.T)/z.PH*(ay.t1 - ay.t0))};
    } else hover = null;
    if (!computing) showStatus(null);
  });
  const endDrag = () => { drag = null; };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => { hover = null; if (!computing) showStatus(null); });
  canvas.addEventListener('dblclick', e => {
    const z = zoneAt(e);
    const which = z.zone === 'x' || z.zone === 'y' ? [z.zone] : ['x', 'y'];
    for (const k of which) autoscaleAxis(k);
    scheduleDraw();
  });

  // ---------------- 部品のつなぎ ----------------
  for (const k of ['x', 'y']){
    const u = axisUI[k];
    u.sel.addEventListener('change', () => {
      const a = st.ax[k];
      a.col = +u.sel.value;
      a.scale = defScale(a.col);
      pendingAuto[k] = true;
      data = null;
      updateAxisUI(); scheduleDraw(); requestCompute(0);
    });
    u.sc.addEventListener('click', () => {
      const a = st.ax[k];
      a.scale = a.scale === 'log' ? 'lin' : 'log';
      updateAxisUI();
      if (a.link && cols[a.col].kind === 'var'){
        // 表示範囲で振っているなら、今の範囲を新しい目盛りに移してから取り直す
        const lo = Math.max(inv(a.scale === 'log' ? 'lin' : 'log', a.t0), 0);
        const hi = inv(a.scale === 'log' ? 'lin' : 'log', a.t1);
        if (a.scale === 'log'){
          const v = M.vars[a.col];
          const l = Math.max(lo, v.min > 0 ? v.min : hi*1e-3, LOG_MIN);
          a.t0 = Math.log10(l); a.t1 = Math.log10(Math.max(hi, l*10));
        } else { a.t0 = lo; a.t1 = hi; }
        updateRow(a.col); requestCompute(0);
      } else {
        autoscaleAxis(k);
      }
      scheduleDraw();
    });
    u.lk.addEventListener('change', () => {
      const a = st.ax[k];
      a.link = u.lk.checked;
      // 縦横に同じ変数を置いて両方で振ると決まらないので、片方だけにする
      const o = st.ax[k === 'x' ? 'y' : 'x'];
      if (a.link && o.link && o.col === a.col){ o.link = false; }
      updateAxisUI(); requestCompute(0);
    });
  }
  autoBtn.addEventListener('click', () => { autoscaleAxis('x'); autoscaleAxis('y'); scheduleDraw(); });
  nSel.addEventListener('change', () => { st.n = +nSel.value; requestCompute(0); });
  seedIn.addEventListener('change', () => { st.seed = (+seedIn.value >>> 0); requestCompute(0); });
  reseed.addEventListener('click', () => { st.seed = (st.seed + 1) >>> 0; seedIn.value = String(st.seed); requestCompute(0); });
  edgeChk.addEventListener('change', () => { st.edge = edgeChk.checked; scheduleDraw(); });
  gammaIn.addEventListener('input', () => { st.gamma = +gammaIn.value; scheduleDraw(); });
  psizeSel.addEventListener('change', () => { st.psize = +psizeSel.value; scheduleDraw(); });

  function resize(){
    dpr = window.devicePixelRatio || 1;
    const r = wrap.getBoundingClientRect();
    canvas.width = Math.max(1, Math.round(r.width*dpr));
    canvas.height = Math.max(1, Math.round(r.height*dpr));
    canvas.style.width = r.width + 'px';
    canvas.style.height = r.height + 'px';
    scheduleDraw();
  }
  const ro = new ResizeObserver(resize);
  ro.observe(wrap);
  const mq = window.matchMedia ? window.matchMedia('(prefers-color-scheme: dark)') : null;
  const onScheme = () => { lut = null; scheduleDraw(); };
  if (mq && mq.addEventListener) mq.addEventListener('change', onScheme);

  updateAxisUI();
  resize();
  requestCompute(0);

  return {
    model: M,
    state: st,
    get data(){ return data; },
    recompute(){ requestCompute(0); },
    autoscale(){ autoscaleAxis('x'); autoscaleAxis('y'); scheduleDraw(); },
    destroy(){
      jobGen++;
      clearTimeout(computeTimer);
      if (drawReq) cancelAnimationFrame(drawReq);
      ro.disconnect();
      if (mq && mq.removeEventListener) mq.removeEventListener('change', onScheme);
      root.textContent = '';
      root.classList.remove('rp2');
    },
  };
}

return {mount, core};
});
