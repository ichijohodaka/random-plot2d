// 計算の核の試験。node --test test/ で走る。
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const RP = require('../web/random-plot2d.js');
const C = RP.core;

function loadDemo(){
  const src = fs.readFileSync(path.join(__dirname, '..', 'web', 'demo-model.js'), 'utf8');
  return vm.runInNewContext(src + '\n;model', {Math});
}

// x0, x1 を振って y = [x0 + x1, x0 * x1] を返すだけのモデル
const toy = () => ({
  vars: [
    {id:'a', value:2, lo:1, hi:3},
    {id:'b', value:10, lo:1, hi:100, dist:'log'},
    {id:'c', value:5},
  ],
  outs: [{id:'sum'}, {id:'prod'}],
  eval(x, y){ y[0] = x[0] + x[1] + x[2]; y[1] = x[0]*x[1]; },
});
const rangesOf = M => M.vars.map(v => ({lo: v.lo, hi: v.hi, dist: v.dist}));

test('列は変数、関数値の順に並ぶ', () => {
  const M = C.normalizeModel(toy());
  assert.deepEqual(M.cols.map(c => c.id), ['a', 'b', 'c', 'sum', 'prod']);
  assert.equal(M.n, 3); assert.equal(M.m, 2);
});

test('おかしなモデルは理由を添えて弾く', () => {
  const bad = patch => () => C.normalizeModel(Object.assign(toy(), patch));
  assert.throws(bad({eval: undefined}), /eval/);
  assert.throws(bad({vars: []}), /vars/);
  assert.throws(bad({outs: [{id:'a'}]}), /重複/);
  assert.throws(bad({vars: [{id:'z', value:0, dist:'log'}]}), /min|value/);
  assert.throws(bad({vars: [{id:'z', value:1, lo:3, hi:2}]}), /lo/);
  assert.throws(bad({vars: [{id:'z', value:5, min:0, max:1}]}), /value/);
});

test('値は指定した区間に入り、幅 0 の変数は値そのまま', () => {
  const M = C.normalizeModel(toy());
  const [a, b, c] = C.runJob(M, rangesOf(M), [0, 1, 2], 20000, 7);
  for (let i = 0; i < a.length; i++){
    assert.ok(a[i] >= 1 && a[i] <= 3);
    assert.ok(b[i] >= 1 && b[i] <= 100);
    assert.equal(c[i], 5);
  }
});

test('log は対数一様、lin は一様', () => {
  const M = C.normalizeModel(toy());
  const [a, b] = C.runJob(M, rangesOf(M), [0, 1], 100000, 3);
  const frac = (arr, f) => arr.filter(f).length / arr.length;
  // b ∈ [1, 100] 対数一様なら b < 10 がちょうど半分
  assert.ok(Math.abs(frac(Array.from(b), v => v < 10) - 0.5) < 0.01);
  // a ∈ [1, 3] 一様なら a < 2 が半分
  assert.ok(Math.abs(frac(Array.from(a), v => v < 2) - 0.5) < 0.01);
});

test('関数値の列は eval を直接呼んだものと一致する', () => {
  const M = C.normalizeModel(toy());
  const [a, b, c, s, p] = C.runJob(M, rangesOf(M), [0, 1, 2, 3, 4], 1000, 11);
  for (let i = 0; i < 1000; i++){
    assert.equal(s[i], a[i] + b[i] + c[i]);
    assert.equal(p[i], a[i]*b[i]);
  }
});

test('同じ種なら同じ標本、別の変数の区間を変えても自分の標本は変わらない', () => {
  const M = C.normalizeModel(toy());
  const r = rangesOf(M);
  const [a1] = C.runJob(M, r, [0], 5000, 42);
  const [a2] = C.runJob(M, r, [0], 5000, 42);
  assert.deepEqual(a1, a2);
  const r2 = r.slice(); r2[1] = {lo: 50, hi: 60, dist: 'lin'};
  const [a3] = C.runJob(M, r2, [0], 5000, 42);
  assert.deepEqual(a1, a3);
  const [a4] = C.runJob(M, r, [0], 5000, 43);
  assert.notDeepEqual(a1, a4);
});

test('少しずつ進めても一度に計算しても同じ', () => {
  const M = C.normalizeModel(toy());
  const all = C.runJob(M, rangesOf(M), [3, 1], 12345, 5);
  const j = C.createJob(M, rangesOf(M), [3, 1], 12345, 5);
  while (!j.step(1000));
  assert.deepEqual(j.cols.map(o => o.arr), all);
});

test('関数値を使わない組み合わせでは eval を呼ばない', () => {
  let calls = 0;
  const m = toy(); const ev = m.eval; m.eval = (x, y) => { calls++; ev(x, y); };
  const M = C.normalizeModel(m);
  C.runJob(M, rangesOf(M), [0, 1], 100, 1);
  assert.equal(calls, 0);
  C.runJob(M, rangesOf(M), [0, 4], 100, 1);
  assert.equal(calls, 100);
});

test('分位点で表示範囲を決めると、外れ値に引きずられない', () => {
  const arr = new Float64Array(10000);
  for (let i = 0; i < arr.length; i++) arr[i] = i / arr.length;   // [0, 1)
  arr[0] = 1e9;                                                   // 鋭い山ひとつ
  const [lo, hi] = C.quantileRange(arr, false);
  assert.ok(lo < 0.02 && hi > 0.98 && hi < 1.1, lo + ' ' + hi);
});

test('log 軸の分位点は 0 以下と非有限を除いて log10 で返す', () => {
  const arr = Float64Array.from([-1, 0, NaN, Infinity, 10, 100, 1000]);
  const [lo, hi] = C.quantileRange(arr, true, 0);
  assert.ok(lo < 1 && lo > 0.8 && hi > 3 && hi < 3.2);
  assert.deepEqual(C.countInvalid(arr, true), {nonpos: 2, nonfinite: 2});
  assert.deepEqual(C.countInvalid(arr, false), {nonpos: 0, nonfinite: 2});
  assert.equal(C.quantileRange(Float64Array.from([-1, 0]), true), null);
});

test('幅 0 の列でも見える範囲をこしらえる', () => {
  assert.deepEqual(C.quantileRange(Float64Array.from([5, 5, 5]), false), [4.5, 5.5]);
  assert.deepEqual(C.quantileRange(Float64Array.from([0, 0]), false), [-1, 1]);
  assert.deepEqual(C.quantileRange(Float64Array.from([100, 100]), true), [1.5, 2.5]);
});

test('目盛り', () => {
  assert.deepEqual(C.niceTicks(0, 1, 5).ticks, [0, 0.2, 0.4, 0.6000000000000001, 0.8, 1]);
  const lt = C.logTicks(0, 3, 10);
  assert.deepEqual(lt.filter(t => t.label && Number.isInteger(t.t)).map(t => t.t), [0, 1, 2, 3]);
  // 1 桁に満たないときは実際の値で刻む
  const small = C.logTicks(Math.log10(2), Math.log10(3), 5);
  assert.ok(small.length >= 2 && small.every(t => t.v >= 2 && t.v <= 3));
  // 桁が多いときは間引く
  const wide = C.logTicks(-12, 12, 6);
  assert.ok(wide.filter(t => t.label).length <= 7);
});

test('SI 接頭辞の読み書き', () => {
  assert.equal(C.formatSI(100000, 4), '100k');
  assert.equal(C.formatSI(1e-7, 4), '100n');
  assert.equal(C.formatSI(999.99, 3), '1k');
  assert.equal(C.formatSI(-0.0025, 3), '-2.5m');
  assert.equal(C.formatTick(120000, 20000), '120k');
  assert.equal(C.formatTick(1.25, 0.05), '1.25');
  assert.equal(C.parseSI('100u'), 100e-6);
  assert.equal(C.parseSI('100µH'), 100e-6);
  assert.equal(C.parseSI('4.7k'), 4700);
  assert.equal(C.parseSI('1meg'), 1e6);
  assert.equal(C.parseSI('1M'), 1e6);
  assert.equal(C.parseSI('1m'), 1e-3);
  assert.equal(C.parseSI('2.2e-6'), 2.2e-6);
  assert.equal(C.parseSI('10 Hz'), 10);
  assert.ok(Number.isNaN(C.parseSI('abc')));
});

test('デモのモデル: 共振で |Z| = R、位相 0、P = V²/(2R)', () => {
  const M = C.normalizeModel(loadDemo());
  const x = Float64Array.from([1, 10, 100e-6, 100e-9, 0]);
  x[4] = 1/(2*Math.PI*Math.sqrt(x[2]*x[3]));
  const y = new Float64Array(M.m);
  M.eval(x, y);
  const near = (a, b) => Math.abs(a - b) <= 1e-9*Math.max(1, Math.abs(b));
  assert.ok(near(y[0], 10));
  assert.ok(Math.abs(y[1]) < 1e-6);
  assert.ok(near(y[3], 1/(2*10)));
  assert.ok(near(y[4], x[4]));
});
