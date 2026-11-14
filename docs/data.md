# 数据与现有口径

unitPrice 为最小货币单位的非负整数；returned 为退回数量，基础核算不折汇。

`data/records.json` 是版本为 1 的演练数据，所有人员、机构、商品和交易均为本地合成记录。`id` 是导入记录键，不自动代表企业、访问或其他统计单位；记录键不得重复。数值字段必须有限，整数字段不得超过安全整数范围。空字符串可用于字段约定允许的未公开标签，不用零冒充缺测。

| 字段 | 类型 |
| --- | --- |
| `id` | `string` |
| `sku` | `string` |
| `period` | `integer` |
| `quantity` | `number` |
| `unitPrice` | `number` |
| `currency` | `string` |
| `pack` | `string` |
| `returned` | `number` |

现有 `summary` 按 `currency` 清点记录，`sum` 为 `quantity` 的逐行核对值，不代表统计推断或跨期业务指标。分组按键排序，行按记录键稳定处理。`data/expected-summary.json` 是独立生成的现有核算对照；`summary` 与 `inspect` 不消费分析配置。

`data/policy.json` 保存指数流程的业务配置演练值：`basePeriod` 为定基基期；`fx.versions` 为带版本的汇率表，`base` 为基币，汇率是 1 单位交易币种最小货币单位对应的基币最小货币单位，基币自身汇率必须为 1，`fx.defaultVersion` 为默认版本，命令可用 `--fx` 选定其他版本；`packs` 按规格保存生效期（`from`）严格递增的换算系数，记录按所属期间取最后一条不晚于该期的系数。

`inspect` 返回输入行数、字段列表与 SHA-256 指纹；指纹不依赖字段或记录排列。数据版本不支持时应直接拒绝，不做静默迁移。错误发生时命令返回非零退出码。

## 指数流程口径

`index` 输出 JSON，`review` 输出中文复盘，二者共用同一计算，可用 `--from`/`--to` 选定期间：

- 规范化：数量 × 规格系数 = 基本单位数量；单价 ÷ 系数 = 基本单位单价；金额与退货金额按选定版本汇率折基币。中间计算不舍入，JSON 保留双精度全量，`review` 叙述金额为展示舍入。
- 币种在选定版本无汇率、或规格在该期间无生效系数的记录整条排除，列入 `excluded`，不进入任何合计与共同商品，不硬凑。
- 退货金额是独立的负向调整（`decomposition.returnsDelta`），不冲减数量、不折算成负单价。
- 共同商品为两期基本单位数量均大于零的 `sku`；其余进入 `entering`（新品 `new` 或基期零数量 `zero-base`）、`exiting`（退市 `discontinued` 或当期零数量 `zero-current`），零数量期连同其退货金额列入 `zeroQuantity`。
- 价格指数：Laspeyres 用基期数量权重（Σp1q0/Σp0q0），Paasche 用当期数量权重（Σp1q1/Σp0q1），Fisher 为两者几何平均；数量指数对称定义。`products` 给出各商品基期/当期权重 `weightBase`、`weightCurrent` 及商品级价格/数量效应。
- 金额恒等式：`netChange = priceEffect + quantityEffect + enteringGross − exitingGross − returnsDelta + identityError`。价格/数量效应为 Bennet 分解（(p1−p0)(q0+q1)/2 与 (q1−q0)(p0+p1)/2），逐商品可加；`identityError` 为浮点残差，应接近 0。
- `averageUnitPrice` 是总额/总量均价，仅用于对照：它混有商品结构变化，不等于价格变化。
- `fixedBase` 每期与 `basePeriod` 直接比较；`chain` 逐段 Fisher 复利累积，某段无共同商品即断链（`chain.breaks`），断点之后 `cumulative` 为 `null`，不跨段续接。链式与定基并存，差异来自商品集合与权重的更新。
- `caliber` 记录本次计算的口径（汇率版本、基期、规格表、金额与数量单位）及其指纹，可随结果一起复核。
