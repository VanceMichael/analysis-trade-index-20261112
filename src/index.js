import { validateRecords, fingerprint } from './dataset.js';
import { validatePolicy, fxTable, packFactor } from './policy.js';

const byId = (left, right) => left.id.localeCompare(right.id, 'en');

// 规范化：数量折成基本单位、金额折成基币最小货币单位；退货金额单列，不冲减数量。
// 无法换算（币种无汇率、规格无生效系数）的记录整条排除，不进入任何合计。
export function normalizeRecords(records, policy, fxVersion) {
  validateRecords(records);
  validatePolicy(policy);
  const fx = fxTable(policy, fxVersion);
  const rows = [];
  const excluded = [];
  for (const record of [...records].sort(byId)) {
    const rate = fx.rates[record.currency];
    if (rate === undefined) {
      excluded.push({ id: record.id, sku: record.sku, period: record.period, reason: 'missing-fx', currency: record.currency });
      continue;
    }
    const factor = packFactor(policy.packs, record.pack, record.period);
    if (factor === null) {
      excluded.push({ id: record.id, sku: record.sku, period: record.period, reason: 'unknown-pack', pack: record.pack });
      continue;
    }
    rows.push({
      id: record.id,
      sku: record.sku,
      period: record.period,
      units: record.quantity * factor,
      gross: record.quantity * record.unitPrice * rate,
      returns: record.returned * record.unitPrice * rate
    });
  }
  return { rows, excluded, fx };
}

function aggregateBySku(rows) {
  const map = new Map();
  for (const row of rows) {
    const entry = map.get(row.sku) ?? { units: 0, gross: 0, returns: 0 };
    entry.units += row.units;
    entry.gross += row.gross;
    entry.returns += row.returns;
    map.set(row.sku, entry);
  }
  return map;
}

function totals(rows) {
  let gross = 0;
  let returns = 0;
  let units = 0;
  for (const row of rows) {
    gross += row.gross;
    returns += row.returns;
    units += row.units;
  }
  return { gross, returns, net: gross - returns, units };
}

const ratio = (numerator, denominator) => denominator > 0 ? numerator / denominator : null;
const fisher = (laspeyres, paasche) => laspeyres !== null && paasche !== null ? Math.sqrt(laspeyres * paasche) : null;

// 两期对比：共同商品（两期数量均大于零）进指数；其余进新品/退市/零数量清单。
// 价格、数量效应用 Bennet 分解，逐商品可加且合计精确等于共同商品金额变化。
export function comparePeriods(rows, from, to) {
  const baseRows = rows.filter(row => row.period === from);
  const currentRows = rows.filter(row => row.period === to);
  const baseMap = aggregateBySku(baseRows);
  const currentMap = aggregateBySku(currentRows);
  const skus = [...new Set([...baseMap.keys(), ...currentMap.keys()])].sort((a, b) => a.localeCompare(b, 'en'));
  const products = [];
  const entering = [];
  const exiting = [];
  const zeroQuantity = [];
  for (const sku of skus) {
    const base = baseMap.get(sku);
    const current = currentMap.get(sku);
    const baseUnits = base ? base.units : 0;
    const currentUnits = current ? current.units : 0;
    if (baseUnits > 0 && currentUnits > 0) {
      products.push({
        sku,
        baseUnits,
        currentUnits,
        basePrice: base.gross / baseUnits,
        currentPrice: current.gross / currentUnits,
        baseGross: base.gross,
        currentGross: current.gross
      });
      continue;
    }
    if (currentUnits > 0) entering.push({ sku, gross: current.gross, reason: base ? 'zero-base' : 'new' });
    if (baseUnits > 0) exiting.push({ sku, gross: base.gross, reason: current ? 'zero-current' : 'discontinued' });
    if ((base && base.units === 0) || (current && current.units === 0)) {
      zeroQuantity.push({
        sku,
        baseUnits,
        currentUnits,
        baseReturns: base ? base.returns : 0,
        currentReturns: current ? current.returns : 0
      });
    }
  }
  let baseValue = 0;
  let currentValue = 0;
  let basePriceCurrentQty = 0;
  let currentPriceBaseQty = 0;
  for (const product of products) {
    baseValue += product.baseGross;
    currentValue += product.currentGross;
    basePriceCurrentQty += product.basePrice * product.currentUnits;
    currentPriceBaseQty += product.currentPrice * product.baseUnits;
  }
  for (const product of products) {
    product.priceEffect = (product.currentPrice - product.basePrice) * (product.baseUnits + product.currentUnits) / 2;
    product.quantityEffect = (product.currentUnits - product.baseUnits) * (product.basePrice + product.currentPrice) / 2;
    product.weightBase = baseValue > 0 ? product.baseGross / baseValue : null;
    product.weightCurrent = currentValue > 0 ? product.currentGross / currentValue : null;
  }
  const laspeyresPrice = ratio(currentPriceBaseQty, baseValue);
  const paaschePrice = ratio(currentValue, basePriceCurrentQty);
  const laspeyresQuantity = ratio(basePriceCurrentQty, baseValue);
  const paascheQuantity = ratio(currentValue, currentPriceBaseQty);
  const baseTotals = totals(baseRows);
  const currentTotals = totals(currentRows);
  const priceEffect = products.reduce((sum, product) => sum + product.priceEffect, 0);
  const quantityEffect = products.reduce((sum, product) => sum + product.quantityEffect, 0);
  const enteringGross = entering.reduce((sum, entry) => sum + entry.gross, 0);
  const exitingGross = exiting.reduce((sum, entry) => sum + entry.gross, 0);
  const grossChange = currentTotals.gross - baseTotals.gross;
  const returnsDelta = currentTotals.returns - baseTotals.returns;
  const netChange = currentTotals.net - baseTotals.net;
  const identityError = netChange - (priceEffect + quantityEffect + enteringGross - exitingGross - returnsDelta);
  const averageBase = baseTotals.units > 0 ? baseTotals.gross / baseTotals.units : null;
  const averageCurrent = currentTotals.units > 0 ? currentTotals.gross / currentTotals.units : null;
  return {
    from,
    to,
    commonCount: products.length,
    totals: { base: baseTotals, current: currentTotals },
    sums: { baseValue, currentValue, basePriceCurrentQty, currentPriceBaseQty },
    indices: {
      laspeyresPrice,
      paaschePrice,
      fisherPrice: fisher(laspeyresPrice, paaschePrice),
      laspeyresQuantity,
      paascheQuantity,
      fisherQuantity: fisher(laspeyresQuantity, paascheQuantity),
      commonValueRatio: ratio(currentValue, baseValue)
    },
    averageUnitPrice: {
      base: averageBase,
      current: averageCurrent,
      ratio: averageBase !== null && averageBase > 0 && averageCurrent !== null ? averageCurrent / averageBase : null
    },
    coverage: {
      base: baseTotals.gross > 0 ? baseValue / baseTotals.gross : null,
      current: currentTotals.gross > 0 ? currentValue / currentTotals.gross : null
    },
    decomposition: {
      priceEffect,
      quantityEffect,
      enteringGross,
      exitingGross,
      assortmentChange: enteringGross - exitingGross,
      returnsDelta,
      grossChange,
      netChange,
      identityError
    },
    entering,
    exiting,
    zeroQuantity,
    products
  };
}

function pairSummary(pair) {
  const { products, ...summary } = pair;
  return summary;
}

// 指数流程：选定期间直接对比（含商品级贡献），另给出定基序列与逐段链式序列。
// 链式在某段无共同商品时明确断链，之后期间不再续接。
export function buildIndex(records, policy, options = {}) {
  const { rows, excluded, fx } = normalizeRecords(records, policy, options.fx);
  const observed = [...new Set(rows.map(row => row.period))].sort((a, b) => a - b);
  const from = options.from ?? observed[0] ?? policy.basePeriod;
  const to = options.to ?? observed[observed.length - 1] ?? policy.basePeriod;
  if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to)) throw new Error('期间应为整数');
  if (from > to) throw new Error('期间起点不可大于终点');
  const periods = observed.filter(period => period >= from && period <= to);
  const selected = comparePeriods(rows, from, to);
  const fixedBase = periods.map(period => ({ period, ...pairSummary(comparePeriods(rows, policy.basePeriod, period)) }));
  const segments = [];
  const breaks = [];
  const cumulative = [];
  let chainedPrice = 1;
  let chainedQuantity = 1;
  let disconnected = false;
  if (periods.length > 0) cumulative.push({ period: periods[0], price: 1, quantity: 1 });
  for (let index = 1; index < periods.length; index += 1) {
    const segment = comparePeriods(rows, periods[index - 1], periods[index]);
    const usable = segment.commonCount > 0
      && segment.indices.fisherPrice !== null
      && segment.indices.fisherQuantity !== null;
    if (!usable) {
      disconnected = true;
      breaks.push({ from: periods[index - 1], to: periods[index] });
    }
    if (!disconnected) {
      chainedPrice *= segment.indices.fisherPrice;
      chainedQuantity *= segment.indices.fisherQuantity;
    }
    segments.push({ from: periods[index - 1], to: periods[index], broken: !usable, ...pairSummary(segment) });
    cumulative.push({
      period: periods[index],
      price: disconnected ? null : chainedPrice,
      quantity: disconnected ? null : chainedQuantity
    });
  }
  const caliber = {
    fxVersion: fx.version,
    fxBase: fx.base,
    basePeriod: policy.basePeriod,
    packTable: policy.packs,
    amountUnit: `${fx.base} 最小货币单位`,
    quantityUnit: '按规格生效系数折算的基本单位'
  };
  return {
    flow: 'index',
    caliber: { ...caliber, fingerprint: fingerprint(caliber) },
    range: { from, to },
    periods,
    excluded,
    selected,
    fixedBase,
    chain: { segments, cumulative, breaks }
  };
}
