# 回测工坊：个人投资回测与风险分析平台

一个可本地运行的个人投资策略回测与风险分析平台。内置模拟行情引擎、技术指标库、回测撮合器、风险指标与蒙特卡洛模拟，提供 Web 交互界面。

## 快速开始

```bash
npm install
npm run dev
```

启动后自动打开浏览器（自动选择空闲端口）。`npm test` 运行测试套件。

## 架构

```
invest_backtest/
├── engine/
│   ├── market.js       模拟行情生成（GBM + 波动率状态切换 + 前复权）
│   ├── indicators.js   技术指标（SMA/EMA/RSI/MACD/布林带/ATR）
│   ├── backtest.js     回测撮合器（信号延迟一日、止损止盈、成本模型）
│   ├── metrics.js      风险指标（年化/夏普/索提诺/最大回撤/卡玛）
│   ├── montecarlo.js   自助法蒙特卡洛模拟
│   └── strategies.js   策略版本库（草稿→送审→发布工作流 + 参数快照运行）
├── server.js           HTTP 服务（静态托管 + 回测/策略库 API）
├── web/                Vue3 + Canvas 前端（工作台 + 策略库）
└── tests/              引擎与工作流测试套件
```

## 核心语义

- **信号延迟**：策略在第 `i` 根 K 线收盘后产生信号，于第 `i+1` 根开盘成交，杜绝前视偏差。
- **止损止盈**：持仓期间按当日最高/最低价触发；若开盘跳空越过触发价，按开盘价成交；止损/止盈平仓当日不再进场。
  - `stopMode: "fixed"`（默认）：固定比例，`stopLoss`/`takeProfit` 为相对入场价的百分比；不传 `stopMode` 的旧参数与历史结果逐位一致。
  - `stopMode: "atr"`：入场当日锁定触发价，距离 = `ATR(atrN)` × 倍数（`atrStopMult`/`atrTargetMult`）× 波动状态乘数。ATR 与波动状态只引用**入场前一根**（`i-1`）数据，无前视；预热期 ATR 不足时回退固定比例（比例为 0 则不设止损止盈）。
  - `stopMode: "trail"`：可追踪规则。入场当日与 `atr` 同价起步，此后**每个交易日**用截至前一根 K 线的 ATR 与波动状态重算退出价：止损锚定持仓期最高收盘价（吊灯式），**只紧不松**；止盈锚定入场价，距离随最新 ATR × 波动乘数每日收放。波动变化因此逐日反映到退出价格上；预热期同样回退固定比例，ATR 可用后自动接入追踪。
  - 波动状态：`ATR / ATR 的 atrVolN 均值 ≤ volLowK(0.7)` 为低波动（乘数 `volLowMult=0.8`，收紧），`≥ volHighK(1.3)` 为高波动（乘数 `volHighMult=1.5`，放宽），否则正常（乘数 1）。
  - 逐笔交易统一记录 `stop_price`/`target_price`（平仓当日实际生效价）、`stop_init`/`target_init`（入场当日初始价）、`stop_updates`（追踪收紧次数）与 `stop_mode`/`atr_ref`/`vol_state`/`vol_mult`；固定与 ATR 模式初始价等于锁定价、调整次数为 0，`atr_ref` 为 `null` 表示固定比例兜底。回测撮合、风险指标与前端展示共用同一套历史解释。
- **成本模型**：成交价叠加滑点（买入上浮、卖出下浮），双边收取手续费。
- **风险指标**：收益序列采用对数收益，年化按 252 个交易日折算；下行波动只统计负收益；最大回撤记录回撤区间。
- **蒙特卡洛**：对历史对数收益自助重采样生成模拟路径，输出 5%/50%/95% 分位带与亏损概率。

## 策略版本与审核发布

策略库（`/strategies.html`）为策略提供全生命周期管理，数据持久化于 `data/strategies.json`：

- **版本状态机**：`草稿 → 待评审 → 已发布 / 已驳回`，待评审可撤回送审，已驳回可重新打开修订，已发布可撤回（`已撤回`）。
- **角色权限**（页面右上角切换，经 `x-role`/`x-user` 请求头传递，缺省按投资者最小权限处理）：
  - **策略作者**：存草稿、编辑草稿、送审；被驳回后重新打开；撤回已发布版本；任意版本均可直接回测试算。
  - **评审员**：评审他人提交的版本——通过后发布、驳回则退回（必填评审意见）；可撤回已发布版本；不能评审自己撰写的策略。
  - **投资者**：只能查看并运行「已发布」版本。
- **参数快照**：每个版本固化一份 `行情 + 策略 + 交易` 三段参数快照，送审即冻结；回测、风险指标与蒙特卡洛（种子 = 行情种子 + 1）均由同一份快照驱动，同一版本重复运行结果逐位可复现。
- **历史不可变**：每次运行追加一条不可变运行记录（指标、权益曲线、MC 亏损概率）；撤回版本只改状态，不删不改历史结果；已撤回/被取代的旧版本仍可由作者与评审员直接回测。

## API

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/system` | 系统信息 |
| POST | `/api/market` | 生成模拟行情 |
| POST | `/api/backtest` | 行情 + 策略 + 交易参数，返回权益曲线/回撤/逐笔交易/风险指标 |
| POST | `/api/montecarlo` | 对权益曲线做蒙特卡洛模拟 |
| GET | `/api/strategies` | 策略列表（按角色过滤，投资者仅见已发布版本） |
| POST | `/api/strategies` | 创建策略（含 v1 草稿），body: `{name, snapshot, note}` |
| GET | `/api/strategies/:id` | 策略详情（含版本与运行记录） |
| POST | `/api/strategies/:id/versions` | 基于既有版本派生新草稿，body: `{from}` |
| PUT | `/api/strategies/:id/versions/:v` | 保存草稿参数快照（仅草稿可编辑） |
| POST | `/api/strategies/:id/versions/:v/submit` | 送审（草稿 → 待评审） |
| POST | `/api/strategies/:id/versions/:v/retract` | 撤回送审（待评审 → 草稿） |
| POST | `/api/strategies/:id/versions/:v/review` | 评审（仅评审员），body: `{action: "approve"/"reject", comment}` |
| POST | `/api/strategies/:id/versions/:v/reopen` | 重新打开（已驳回 → 草稿） |
| POST | `/api/strategies/:id/versions/:v/withdraw` | 撤回已发布版本（历史结果保留） |
| POST | `/api/strategies/:id/versions/:v/run` | 按版本参数快照运行回测 + 风险指标 + 蒙特卡洛，并记录历史 |

## 测试

`npm test` 覆盖指标手算、撮合时点、止损语义、成本模型、最大回撤、蒙特卡洛统计性质、ATR 动态止损止盈、可追踪（逐日调整）规则、波动状态、旧参数复现，以及策略版本状态机、角色权限、快照一致性、撤回保历史、旧版复跑与持久化等 43 个用例。
