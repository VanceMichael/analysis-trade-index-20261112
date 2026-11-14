const fmtIndex = value => value === null ? '不可得' : value.toFixed(4);
const fmtAmount = value => Number.isInteger(value) ? String(value) : value.toFixed(2);
const fmtShare = value => value === null ? '不可得' : `${(value * 100).toFixed(2)}%`;
const fmtChange = value => value === null ? '不可得' : `${value >= 1 ? '+' : ''}${((value - 1) * 100).toFixed(2)}%`;

// 中文复盘：叙述金额为展示舍入，精确数值与恒等式误差以 index 命令的 JSON 为准。
export function renderReview(result) {
  const { caliber, selected } = result;
  const d = selected.decomposition;
  const lines = [];
  lines.push(`价格复盘：第 ${result.range.from} 期 → 第 ${result.range.to} 期`);
  lines.push(`口径：汇率版本 ${caliber.fxVersion}（基币 ${caliber.fxBase}，金额为最小货币单位），基期第 ${caliber.basePeriod} 期，数量按规格生效系数折算为基本单位，退货单列不并入单价；口径指纹 ${caliber.fingerprint}。`);
  lines.push('说明：本叙述金额为展示舍入值，精确数值以 index 命令的 JSON 输出为准。');
  const avg = selected.averageUnitPrice;
  if (avg.ratio !== null) {
    lines.push(`总额/总量均价由 ${fmtAmount(avg.base)} 变为 ${fmtAmount(avg.current)}（${fmtChange(avg.ratio)}）；该口径混有商品结构变化，不能直接当作涨价。`);
  }
  if (selected.commonCount === 0) {
    lines.push('两期没有共同商品，价格与数量指数不可得；全部金额变化列入新品、退市与退货等未解释部分。');
  } else {
    lines.push(`共同商品 ${selected.commonCount} 种，共同商品金额覆盖率：基期 ${fmtShare(selected.coverage.base)}，当期 ${fmtShare(selected.coverage.current)}。`);
    lines.push(`价格指数：Laspeyres（基期数量权重）${fmtIndex(selected.indices.laspeyresPrice)}，Paasche（当期数量权重）${fmtIndex(selected.indices.paaschePrice)}，Fisher（两者几何平均）${fmtIndex(selected.indices.fisherPrice)}。`);
    lines.push(`数量指数：Laspeyres ${fmtIndex(selected.indices.laspeyresQuantity)}，Paasche ${fmtIndex(selected.indices.paascheQuantity)}，Fisher ${fmtIndex(selected.indices.fisherQuantity)}。`);
  }
  lines.push(`净额变化 ${fmtAmount(d.netChange)} = 价格效应 ${fmtAmount(d.priceEffect)} + 数量效应 ${fmtAmount(d.quantityEffect)} + 新品 ${fmtAmount(d.enteringGross)} − 退市 ${fmtAmount(d.exitingGross)} − 退货变动 ${fmtAmount(d.returnsDelta)}；恒等式误差 ${fmtAmount(d.identityError)}。`);
  if (selected.entering.length > 0) {
    lines.push(`新品/基期零数量 ${selected.entering.length} 种：${selected.entering.map(entry => `${entry.sku}（${fmtAmount(entry.gross)}）`).join('、')}。`);
  }
  if (selected.exiting.length > 0) {
    lines.push(`退市/当期零数量 ${selected.exiting.length} 种：${selected.exiting.map(entry => `${entry.sku}（${fmtAmount(entry.gross)}）`).join('、')}。`);
  }
  if (selected.zeroQuantity.length > 0) {
    lines.push(`零数量期 ${selected.zeroQuantity.length} 个：${selected.zeroQuantity.map(entry => entry.sku).join('、')}；其退货金额已单列，未折算成负单价。`);
  }
  const contributors = [...selected.products]
    .sort((a, b) => (Math.abs(b.priceEffect) + Math.abs(b.quantityEffect)) - (Math.abs(a.priceEffect) + Math.abs(a.quantityEffect)))
    .slice(0, 5);
  if (contributors.length > 0) {
    lines.push('商品级贡献（按贡献绝对值排序，最多 5 条，完整清单见 JSON）：');
    for (const product of contributors) {
      lines.push(`  ${product.sku}：价格效应 ${fmtAmount(product.priceEffect)}，数量效应 ${fmtAmount(product.quantityEffect)}，权重 ${fmtShare(product.weightBase)} → ${fmtShare(product.weightCurrent)}`);
    }
  }
  if (result.chain.breaks.length > 0) {
    lines.push(`链式指数在 ${result.chain.breaks.map(entry => `第 ${entry.from}→${entry.to} 期`).join('、')} 断开（该段无共同商品），断点之后不续接；定基指数不受影响。`);
  }
  const lastPeriod = result.periods[result.periods.length - 1];
  const chained = result.chain.cumulative.find(entry => entry.period === lastPeriod);
  const fixed = result.fixedBase.find(entry => entry.period === lastPeriod);
  if (chained && chained.price !== null && fixed && fixed.indices.fisherPrice !== null && lastPeriod !== caliber.basePeriod) {
    lines.push(`第 ${lastPeriod} 期 Fisher 价格指数：链式（逐段复利）${fmtIndex(chained.price)}，定基（对第 ${caliber.basePeriod} 期）${fmtIndex(fixed.indices.fisherPrice)}；链式逐段更新共同商品与权重，定基始终与基期直接对比，二者差异来自商品集合与权重的更新。`);
  }
  if (result.excluded.length > 0) {
    lines.push(`未纳入换算 ${result.excluded.length} 条：${result.excluded.map(entry => `${entry.id}（${entry.reason === 'missing-fx' ? `币种 ${entry.currency} 无汇率` : `规格 ${entry.pack} 无换算系数`}）`).join('、')}。`);
  }
  return lines.join('\n');
}
