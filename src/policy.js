import { readFile } from 'node:fs/promises';

export function validatePolicy(policy) {
  if (policy === null || typeof policy !== 'object' || Array.isArray(policy)) {
    throw new Error('业务配置必须是对象');
  }
  if (!Number.isSafeInteger(policy.basePeriod)) throw new Error('业务配置 basePeriod 应为整数');
  const fx = policy.fx;
  if (fx === null || typeof fx !== 'object' || Array.isArray(fx)) throw new Error('业务配置缺少 fx 汇率表');
  if (typeof fx.defaultVersion !== 'string' || fx.defaultVersion.length === 0) {
    throw new Error('业务配置缺少默认汇率版本');
  }
  if (fx.versions === null || typeof fx.versions !== 'object' || Array.isArray(fx.versions)) {
    throw new Error('业务配置 fx.versions 应为对象');
  }
  const names = Object.keys(fx.versions);
  if (names.length === 0) throw new Error('业务配置至少需要一个汇率版本');
  if (!names.includes(fx.defaultVersion)) throw new Error('默认汇率版本必须在 fx.versions 中定义');
  for (const [name, table] of Object.entries(fx.versions)) {
    if (table === null || typeof table !== 'object' || Array.isArray(table)) {
      throw new Error(`汇率版本 ${name} 应为对象`);
    }
    if (typeof table.base !== 'string' || table.base.length === 0) throw new Error(`汇率版本 ${name} 缺少基准币种`);
    if (table.rates === null || typeof table.rates !== 'object' || Array.isArray(table.rates)) {
      throw new Error(`汇率版本 ${name} 缺少 rates`);
    }
    const entries = Object.entries(table.rates);
    if (entries.length === 0) throw new Error(`汇率版本 ${name} 的 rates 不能为空`);
    for (const [currency, rate] of entries) {
      if (currency.length === 0) throw new Error(`汇率版本 ${name} 存在空币种`);
      if (typeof rate !== 'number' || !Number.isFinite(rate) || rate <= 0) {
        throw new Error(`汇率版本 ${name} 的 ${currency} 汇率应为正数`);
      }
    }
    if (table.rates[table.base] !== 1) throw new Error(`汇率版本 ${name} 的基准币种汇率应为 1`);
  }
  const packs = policy.packs;
  if (packs === null || typeof packs !== 'object' || Array.isArray(packs)) throw new Error('业务配置缺少 packs 规格表');
  for (const [pack, entries] of Object.entries(packs)) {
    if (pack.length === 0) throw new Error('规格表存在空名称');
    if (!Array.isArray(entries) || entries.length === 0) throw new Error(`规格 ${pack} 至少需要一条生效记录`);
    let previous = -Infinity;
    for (const entry of entries) {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) {
        throw new Error(`规格 ${pack} 的生效记录应为对象`);
      }
      if (!Number.isSafeInteger(entry.from)) throw new Error(`规格 ${pack} 的生效期应为整数`);
      if (typeof entry.factor !== 'number' || !Number.isFinite(entry.factor) || entry.factor <= 0) {
        throw new Error(`规格 ${pack} 的换算系数应为正数`);
      }
      if (entry.from <= previous) throw new Error(`规格 ${pack} 的生效期应严格递增`);
      previous = entry.from;
    }
  }
  return policy;
}

export async function loadPolicy(path) {
  return validatePolicy(JSON.parse(await readFile(path, 'utf8')));
}

export function fxTable(policy, version) {
  const name = version ?? policy.fx.defaultVersion;
  const table = policy.fx.versions[name];
  if (!table) throw new Error(`未知汇率版本：${name}`);
  return { version: name, base: table.base, rates: table.rates };
}

export function packFactor(packs, pack, period) {
  const entries = packs[pack];
  if (!entries) return null;
  let factor = null;
  for (const entry of entries) {
    if (entry.from <= period) factor = entry.factor;
    else break;
  }
  return factor;
}
