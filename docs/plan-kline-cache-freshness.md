# K 线浏览器缓存新鲜度修复计划

## 根因

`marketHistoryCache.readCachedKline` 使用 `kline|<symbol>|<timeframe>` 键，原先只检查 `coversRange`，没有检查缓存写入时间或末根蜡烛日期，并固定返回 `cache.stale: false`。`marketsApi.fetchKlineUncached` 在普通缓存命中后直接返回，因此详情日线缓存可能永久停留在旧日期；服务端已有新数据也不会被请求。

## 改动点

1. 在 `src/app/marketHistoryCache.js` 内增加可测试的新鲜度判定，复用同目录 `holidaysCN.js` 的 `getNearestTradingDayShanghai`，不从页面模块反向导入。
2. `readCachedKline` 继续检查来源、数据形态和 `coversRange`，在适用路径额外检查新鲜度；提供 `allowStale` 选项供回源失败兜底使用，准确返回 stale 标记。
3. 在 `src/app/marketsApi.js` 的 `fetchKlineUncached` 回源异常分支读取允许过期的缓存；仅在缓存仍符合来源、形态和区间条件时返回，并标记顶层 `stale: true` 和 `cache.stale: true`。成功回源继续覆盖原键。
4. 在 `test/` 增补判定、缓存读写以及 fetchKline 回源/兜底回归测试；使用可控时间和最小 IndexedDB 替身，确保测试不依赖真实网络。

## 口径决定

- 仅无显式 `endDate` 的日线读取增加门槛；基础 timeframe 为 `1d` 即适用，兼容 `1d|session=...`。其他 timeframe 保持原语义。
- 末根蜡烛日期必须不早于 Asia/Shanghai 最近交易日，完全复用 `getNearestTradingDayShanghai` 口径，与 `marketFundMetrics.hasEnoughChartCandles` 对齐。
- 末根日期落后时，若有效的 `storedAt` 距今不超过 30 分钟，仍可普通命中；超过 30 分钟后再次按日期判定。不引入其他阈值。
- 带显式 `endDate` 的历史区间读取继续只按 `coversRange` 判定，不增加交易日门槛。
- `allowStale` 只放宽新鲜度，不放宽来源、数据形态或区间覆盖；普通缓存读取不得开启。显式 `forceLive` 也必须先请求 live，失败后的任何缓存兜底统一标记 stale；成功时保留既有写入策略。
- `eastmoney-direct` 来源记录继续忽略，包括允许过期的兜底读取。
- 不更改缓存键、不清理老缓存、不预取、不调整列表或其他无关模块。

## 风险

- 新门槛会使既有过期日线缓存首次打开时回源；成功后覆盖原记录，停牌、新基金等源站无更新场景由 30 分钟豁免限制重复请求。
- 回源故障时保留旧图表可用性，但必须暴露 stale 标记；没有合格兜底缓存时保留现有错误语义。
- 交易日完全沿用仓库已有上海交易日计算及节假日表，不新增市场专属日历；历史区间及分钟线不得受到该门槛影响。

## 测试清单

- [x] 最近交易日日线普通命中，fetchKline 不回源。
- [x] 落后交易日且写入超过 30 分钟的日线普通未命中，并触发回源及覆盖写入。
- [x] 落后交易日但写入不超过 30 分钟仍命中；覆盖恰好 30 分钟边界及无效写入时间。
- [x] 显式 `endDate` 历史区间只检查覆盖；无显式结束日期仍执行日线门槛。
- [x] `1d|session=...` 执行日线门槛，`5m` 保留原行为。
- [x] `eastmoney-direct` 在普通/allowStale 路径均不命中。
- [x] allowStale 返回过期数据并准确标记；不能绕过区间、来源、形态检查。
- [x] fetchKline 回源抛错且有过期缓存时返回双层 stale 标记；无可用缓存时仍报错。
- [x] 保持缓存键隔离及写入 key 防御，成功回源写回原键。
- [x] 运行新增测试、`test/marketsKlineFallback.test.mjs`、`test/marketDetailHistory.test.mjs` 及所有相关 marketFundMetrics 测试。
- [x] 运行 `npm run check:refactor`、`npm run lint -- --quiet`、`git diff --check`；区分本次文件与既有 lint 基线错误（实际结果见下）。

## 验收方式

1. 自动测试固定上海交易日与缓存时间，验证命中/未命中、回源调用次数、写入 key 和 stale 标记，确认无新增预取。
2. 用日线缓存落后且写入超过 30 分钟的详情请求验证会回源，成功后缓存覆盖；同条件下模拟回源失败验证旧数据可用且标记 stale。
3. 用历史区间、分钟线和排除来源验证兼容性，全部收尾命令给出实际通过/失败数。
4. 最终变更仅包含本计划、两处授权源码和相关测试；不提交、不推送、不运行发布脚本、不触碰发布目录或构建产物，也不修改 `docs/plan-react-router-migration.md`。

## 实施与检查结果

- `isKlineCacheFresh` 实现日期/30 分钟豁免及 timeframe/endDate 边界，通过 `__internals` 暴露供纯函数测试使用。
- `readCachedKline` 在 `coversRange` 之后增加新鲜度检查，`allowStale` 返回真实的 stale 标记。
- `fetchKlineUncached` 只在 live 抛错后开启 `allowStale`，返回双层 stale 标记，不续写失败兜底的 `storedAt`。
- 新增 `test/marketHistoryCacheFreshness.test.mjs`，共 22 项测试；除必需场景外还覆盖上海跨日、周末/国庆、时间戳蜡烛、HTTP 失败、30 分钟后重新回源及显式刷新失败。

实际执行的相关测试命令：

```bash
node --test test/marketHistoryCacheFreshness.test.mjs test/marketsKlineFallback.test.mjs test/marketDetailHistory.test.mjs test/marketsFundMetrics.test.mjs test/marketsApi.test.mjs test/backtestDataFetcher.test.mjs
```

| 检查命令 | 实际结果 |
| --- | --- |
| 上述 `node --test`（6 个文件） | 101 通过 / 0 失败 / 0 跳过，退出码 0；包含新增 22 项。 |
| `npm run check:refactor` | 退出码 1；2 处既有超限：`src/pages/NotifyExperience.jsx` 938/880 行、`workers/ocr-proxy/src/index.js` 290/250 行。两文件与 HEAD 一致。 |
| `npm run lint -- --quiet` | 退出码 1；本次两处源码 0 错误，全仓 12 个既有错误。所有报错文件与 HEAD 一致，本次未修改。 |
| `./node_modules/.bin/eslint src/app/marketHistoryCache.js src/app/marketsApi.js --quiet` | 两文件检查通过，0 错误，退出码 0。 |
| `git diff --check` | 通过，0 空白错误，退出码 0。 |

遗留限制：全仓 refactor/lint 基线未在本任务内修改；交易日继续依赖既有上海节假日表；回源持续失败时会返回明确标记 stale 的旧图表。此次通过本地自动测试验收，未提交、推送或部署。
