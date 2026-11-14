import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { buildIndex, comparePeriods, normalizeRecords } from '../src/index.js';
import { validatePolicy, fxTable, packFactor } from '../src/policy.js';
import { renderReview } from '../src/report.js';

const rec = (id, sku, period, quantity, unitPrice, extra = {}) =>
  ({ id, sku, period, quantity, unitPrice, currency: 'CNY', pack: 'piece', returned: 0, ...extra });

const policy = {
  basePeriod: 1,
  fx: {
    defaultVersion: 'v1',
    versions: {
      v1: { base: 'CNY', rates: { CNY: 1, USD: 7 } },
      v2: { base: 'CNY', rates: { CNY: 1, USD: 8 } }
    }
  },
  packs: {
    piece: [{ from: 1, factor: 1 }],
    box: [{ from: 1, factor: 10 }, { from: 6, factor: 12 }]
  }
};

test('两商品手算：指数、权重与金额分解与手工值一致', () => {
  const records = [
    rec('a1', 'A', 1, 10, 100), rec('b1', 'B', 1, 5, 200),
    rec('a2', 'A', 2, 12, 110), rec('b2', 'B', 2, 8, 190)
  ];
  const pair = buildIndex(records, policy, { from: 1, to: 2 }).selected;
  assert.equal(pair.commonCount, 2);
  assert.deepEqual(pair.sums, { baseValue: 2000, currentValue: 2840, basePriceCurrentQty: 2800, currentPriceBaseQty: 2050 });
  assert.equal(pair.indices.laspeyresPrice, 1.025);
  assert.equal(pair.indices.paaschePrice, 71 / 70);
  assert.equal(pair.indices.fisherPrice, Math.sqrt(1.025 * 71 / 70));
  assert.equal(pair.indices.laspeyresQuantity, 1.4);
  assert.equal(pair.indices.paascheQuantity, 284 / 205);
  assert.equal(pair.indices.commonValueRatio, 1.42);
  assert.ok(Math.abs(pair.indices.fisherPrice * pair.indices.fisherQuantity - 1.42) < 1e-12);
  const d = pair.decomposition;
  assert.equal(d.priceEffect, 45);
  assert.equal(d.quantityEffect, 795);
  assert.equal(d.netChange, 840);
  assert.equal(d.identityError, 0);
  const a = pair.products.find(product => product.sku === 'A');
  const b = pair.products.find(product => product.sku === 'B');
  assert.equal(a.weightBase, 0.5);
  assert.equal(a.weightCurrent, 1320 / 2840);
  assert.equal(b.weightCurrent, 1520 / 2840);
  assert.equal(a.priceEffect, 110);
  assert.equal(a.quantityEffect, 210);
  assert.equal(b.priceEffect, -65);
  assert.equal(b.quantityEffect, 585);
});

test('纯数量变化：价格指数不动，金额变化全部归入数量效应', () => {
  const records = [
    rec('a1', 'A', 1, 10, 100), rec('b1', 'B', 1, 5, 200),
    rec('a2', 'A', 2, 20, 100), rec('b2', 'B', 2, 10, 200)
  ];
  const pair = buildIndex(records, policy, { from: 1, to: 2 }).selected;
  assert.equal(pair.indices.laspeyresPrice, 1);
  assert.equal(pair.indices.paaschePrice, 1);
  assert.equal(pair.indices.fisherPrice, 1);
  assert.equal(pair.indices.fisherQuantity, 2);
  assert.equal(pair.decomposition.priceEffect, 0);
  assert.equal(pair.decomposition.quantityEffect, 2000);
  assert.equal(pair.decomposition.netChange, 2000);
  assert.equal(pair.decomposition.identityError, 0);
});

test('混合币种按选定汇率版本折算，换版本结果随之改变', () => {
  const records = [
    rec('x1', 'X', 1, 4, 700),
    rec('x2', 'X', 2, 4, 100, { currency: 'USD' }),
    rec('y1', 'Y', 1, 2, 300, { currency: 'USD' }),
    rec('y2', 'Y', 2, 2, 300, { currency: 'USD' })
  ];
  const v1 = buildIndex(records, policy, { from: 1, to: 2 });
  assert.equal(v1.caliber.fxVersion, 'v1');
  assert.equal(v1.selected.totals.base.gross, 7000);
  assert.equal(v1.selected.totals.current.gross, 7000);
  assert.equal(v1.selected.indices.fisherPrice, 1);
  const v2 = buildIndex(records, policy, { fx: 'v2', from: 1, to: 2 });
  assert.equal(v2.caliber.fxVersion, 'v2');
  assert.equal(v2.selected.totals.base.gross, 7600);
  assert.equal(v2.selected.totals.current.gross, 8000);
  assert.equal(v2.selected.indices.laspeyresPrice, 20 / 19);
  assert.ok(v2.selected.indices.fisherPrice > 1);
});

test('规格按生效期折算，未知规格与未知币种单列不进共同商品', () => {
  const records = [
    rec('z1', 'Z', 5, 2, 1200, { pack: 'box' }),
    rec('z2', 'Z', 7, 2, 1440, { pack: 'box' }),
    rec('w1', 'W', 5, 3, 100),
    rec('w2', 'W', 7, 3, 100),
    rec('e1', 'E', 7, 1, 100, { currency: 'EUR' }),
    rec('k1', 'K', 7, 1, 500, { pack: 'crate' })
  ];
  const result = buildIndex(records, policy, { from: 5, to: 7 });
  const pair = result.selected;
  assert.equal(pair.commonCount, 2);
  assert.equal(pair.indices.fisherPrice, 1);
  const z = pair.products.find(product => product.sku === 'Z');
  assert.equal(z.baseUnits, 20);
  assert.equal(z.currentUnits, 24);
  assert.equal(z.basePrice, 120);
  assert.equal(z.currentPrice, 120);
  assert.deepEqual(result.excluded, [
    { id: 'e1', sku: 'E', period: 7, reason: 'missing-fx', currency: 'EUR' },
    { id: 'k1', sku: 'K', period: 7, reason: 'unknown-pack', pack: 'crate' }
  ]);
  assert.equal(pair.totals.current.gross, 2 * 1440 + 3 * 100);
});

test('规格生效表按期间取系数，未生效与未知规格返回空', () => {
  assert.equal(packFactor(policy.packs, 'box', 1), 10);
  assert.equal(packFactor(policy.packs, 'box', 5), 10);
  assert.equal(packFactor(policy.packs, 'box', 6), 12);
  assert.equal(packFactor(policy.packs, 'box', 99), 12);
  assert.equal(packFactor(policy.packs, 'piece', 0), null);
  assert.equal(packFactor(policy.packs, 'crate', 7), null);
});

test('中途无共同商品：链式明确断链不续接，定基单独标记', () => {
  const records = [
    rec('a1', 'A', 1, 10, 100), rec('b1', 'B', 1, 5, 200),
    rec('a2', 'A', 2, 10, 110), rec('b2', 'B', 2, 5, 210),
    rec('c3', 'C', 3, 4, 300), rec('d3', 'D', 3, 6, 400)
  ];
  const result = buildIndex(records, policy, { from: 1, to: 3 });
  assert.equal(result.chain.segments.length, 2);
  assert.equal(result.chain.segments[0].broken, false);
  assert.equal(result.chain.segments[1].broken, true);
  assert.deepEqual(result.chain.breaks, [{ from: 2, to: 3 }]);
  const cumulative = result.chain.cumulative;
  assert.equal(cumulative[0].price, 1);
  assert.ok(cumulative[1].price > 1);
  assert.equal(cumulative[2].price, null);
  assert.equal(cumulative[2].quantity, null);
  const fixed3 = result.fixedBase.find(entry => entry.period === 3);
  assert.equal(fixed3.commonCount, 0);
  assert.equal(fixed3.indices.fisherPrice, null);
  assert.equal(result.selected.commonCount, 0);
  assert.equal(result.selected.decomposition.enteringGross, 3600);
  assert.equal(result.selected.decomposition.exitingGross, 2000);
  assert.equal(result.selected.decomposition.netChange, 1600);
  assert.equal(result.selected.decomposition.identityError, 0);
  const review = renderReview(result);
  assert.match(review, /没有共同商品/);
  assert.match(review, /断开/);
});

test('退货是独立负向调整，不折算成负单价；零数量期金额单列', () => {
  const records = [
    rec('a1', 'A', 1, 4, 100, { returned: 1 }),
    rec('a2', 'A', 2, 4, 100, { returned: 3 }),
    rec('b1', 'B', 1, 2, 50),
    rec('b2', 'B', 2, 0, 50, { returned: 2 })
  ];
  const pair = buildIndex(records, policy, { from: 1, to: 2 }).selected;
  assert.equal(pair.commonCount, 1);
  assert.equal(pair.indices.fisherPrice, 1);
  assert.equal(pair.decomposition.returnsDelta, 300);
  assert.equal(pair.decomposition.netChange, -400);
  assert.equal(pair.decomposition.identityError, 0);
  assert.deepEqual(pair.exiting, [{ sku: 'B', gross: 100, reason: 'zero-current' }]);
  assert.deepEqual(pair.zeroQuantity, [{ sku: 'B', baseUnits: 2, currentUnits: 0, baseReturns: 0, currentReturns: 100 }]);
});

test('新品与退市不进共同商品，覆盖率与组合变化可见', () => {
  const records = [
    rec('a1', 'A', 1, 10, 100), rec('b1', 'B', 1, 5, 200),
    rec('a2', 'A', 2, 10, 100), rec('c2', 'C', 2, 3, 300)
  ];
  const pair = buildIndex(records, policy, { from: 1, to: 2 }).selected;
  assert.equal(pair.commonCount, 1);
  assert.equal(pair.coverage.base, 0.5);
  assert.equal(pair.coverage.current, 1000 / 1900);
  assert.deepEqual(pair.entering, [{ sku: 'C', gross: 900, reason: 'new' }]);
  assert.deepEqual(pair.exiting, [{ sku: 'B', gross: 1000, reason: 'discontinued' }]);
  assert.equal(pair.decomposition.assortmentChange, -100);
  assert.equal(pair.decomposition.netChange, -100);
  assert.equal(pair.decomposition.identityError, 0);
});

test('同一份记录换个排列不应改动计算结果', () => {
  const records = [
    rec('r1', 'A', 1, 10, 100), rec('r2', 'B', 1, 5, 200, { currency: 'USD' }),
    rec('r3', 'A', 2, 12, 110), rec('r4', 'C', 2, 3, 90, { pack: 'box' }),
    rec('r5', 'B', 2, 6, 210, { currency: 'USD', returned: 1 }),
    rec('r6', 'D', 1, 0, 50, { returned: 2 }), rec('r7', 'E', 3, 4, 70),
    rec('r8', 'A', 3, 11, 120), rec('r9', 'C', 3, 3, 95, { pack: 'box' })
  ];
  const interleaved = [...records.slice(5), ...records.slice(0, 5)].reverse();
  assert.deepEqual(buildIndex(interleaved, policy, { from: 1, to: 3 }), buildIndex(records, policy, { from: 1, to: 3 }));
});

test('业务配置校验拒绝非法汇率版本与规格表', () => {
  assert.equal(validatePolicy(policy), policy);
  assert.equal(fxTable(policy, 'v2').rates.USD, 8);
  assert.throws(() => fxTable(policy, 'nope'), /未知汇率版本/);
  assert.throws(() => validatePolicy({ ...policy, basePeriod: 1.5 }), /basePeriod/);
  assert.throws(() => validatePolicy({ ...policy, fx: { defaultVersion: 'v9', versions: policy.fx.versions } }), /默认汇率版本/);
  assert.throws(() => validatePolicy({ ...policy, fx: { defaultVersion: 'v1', versions: { v1: { base: 'CNY', rates: { CNY: 2 } } } } }), /基准币种/);
  assert.throws(() => validatePolicy({ ...policy, fx: { defaultVersion: 'v1', versions: { v1: { base: 'CNY', rates: { CNY: 1, USD: -7 } } } } }), /正数/);
  assert.throws(() => validatePolicy({ ...policy, packs: { box: [{ from: 2, factor: 12 }, { from: 1, factor: 10 }] } }), /递增/);
  assert.throws(() => validatePolicy({ ...policy, packs: { box: [{ from: 1, factor: 0 }] } }), /正数/);
});

test('演练数据全期间：共同商品全覆盖，恒等式误差为零，链式不断', async () => {
  const records = JSON.parse(await readFile('data/records.json', 'utf8')).records;
  const result = buildIndex(records, JSON.parse(await readFile('data/policy.json', 'utf8')));
  assert.equal(result.range.from, 1);
  assert.equal(result.range.to, 12);
  assert.equal(result.excluded.length, 0);
  assert.equal(result.chain.breaks.length, 0);
  assert.equal(result.fixedBase[0].indices.fisherPrice, 1);
  for (const segment of result.chain.segments) {
    assert.equal(segment.commonCount, 8);
    assert.equal(segment.coverage.base, 1);
    assert.equal(segment.coverage.current, 1);
    assert.ok(Math.abs(segment.decomposition.identityError) < 1e-9);
  }
  const last = result.chain.cumulative[result.chain.cumulative.length - 1];
  assert.ok(last.price > 1);
  const review = renderReview(result);
  assert.match(review, /价格复盘/);
  assert.match(review, /Laspeyres/);
  assert.match(review, /恒等式误差/);
  assert.match(review, /链式/);
});

test('命令行 index 输出 JSON、review 输出中文复盘，错误参数非零退出', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'index-cli-'));
  try {
    const out = join(folder, 'index.json');
    const run = spawnSync(process.execPath, ['src/cli.js', 'index', '--from', '1', '--to', '3', '--out', out], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const document = JSON.parse(run.stdout);
    assert.equal(document.flow, 'index');
    assert.equal(document.caliber.fxVersion, 'demo-v1');
    assert.equal(document.selected.commonCount, 8);
    assert.equal(document.chain.segments.length, 2);
    assert.deepEqual(JSON.parse(await readFile(out, 'utf8')), JSON.parse(run.stdout));
    const review = spawnSync(process.execPath, ['src/cli.js', 'review', '--from', '1', '--to', '3'], { encoding: 'utf8' });
    assert.equal(review.status, 0, review.stderr);
    assert.match(review.stdout, /价格复盘：第 1 期 → 第 3 期/);
    assert.match(review.stdout, /Fisher/);
    assert.equal(spawnSync(process.execPath, ['src/cli.js', 'index', '--fx', 'nope']).status, 1);
    assert.equal(spawnSync(process.execPath, ['src/cli.js', 'index', '--from', 'abc']).status, 1);
    assert.equal(spawnSync(process.execPath, ['src/cli.js', 'index', '--policy']).status, 1);
  } finally { await rm(folder, { recursive: true, force: true }); }
});

test('自定义政策文件可经 --policy 传入', async () => {
  const folder = await mkdtemp(join(tmpdir(), 'index-policy-'));
  try {
    const path = join(folder, 'policy.json');
    await writeFile(path, JSON.stringify(policy));
    const run = spawnSync(process.execPath, ['src/cli.js', 'index', '--policy', path, '--fx', 'v2', '--from', '1', '--to', '2'], { encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    assert.equal(JSON.parse(run.stdout).caliber.fxVersion, 'v2');
  } finally { await rm(folder, { recursive: true, force: true }); }
});
