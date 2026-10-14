# ETF PCF 历史 backfill 最小 fixture

来源：真实 KV 归档 `FUND_LIMIT_KV` 的 1944 条深交所 PCF backfill（`etf-pcf:<code>:<yyyymmdd>`，
2025-10-13 至 2026-10-13 共 243 个交易日 × 8 只：159501/159509/159513/159632/159659/159660/159696/159941）。
本目录只保留测试所需的最小样本，字段与顺序和 KV value 完全一致：

- `ETF15994120251013.backfill.json` — 159941/2025-10-13，`GET ?code=159941&date=2025-10-13` 的主 fixture。
- `ETF<code>20261013.backfill.json` × 8 — 区间末日样本，用于 plan 第 7 节 2026-10-13 净申购真实值表
  的历史/当日两路径验证。

真实备份副本（含 key 的 bulk 导出、CSV、JSONL）保存在于仓库之外：
`~/workspace/scratch/etf-pcf/history/`（`kv_bulk_backup.json`、`etf_pcf_history_20251013_20261013.csv`、
`etf_pcf_history_20251013_20261013.jsonl`）。本目录 fixture 与 `kv_bulk_backup.json` 中对应 key 的
value 逐字节同内容（仅重新缩进）。

## 归档 value 形态（与 `parseEtfPcf` 输出的差异）

`schemaVersion=1`、`source=szse_pcf`、`code/date`、8 组 `…LimitShares`/`…LimitKind`、
`creationRedemptionUnitShares`、布尔/现金/比例/计数、`basicRawFields`（string record）、`warnings:[]`。
回填时删除了 `rawFields`，未写入 `fetchedAt`/`expiresAt`/`sourceUrl`；KV 无过期时间（永久归档）。

## CSV 期望值（禁止凭空猜测的断言依据）

`etf_pcf_history_20251013_20261013.csv` 列：date,code,fund_name,net_subscribe_limit_shares,
net_subscribe_limit_kind,net_redeem_limit_shares,net_redeem_limit_kind,total_subscribe_limit_shares,
account_net_subscribe_limit_shares,min_unit_shares。

- 2025-10-13,159941,"广发纳指100ETF",**6500000**,**limited**,1000000000,limited,,,1300000
  → fixture 断言 `netSubscribeLimitShares=6500000`、`netSubscribeLimitKind='limited'`、
  `netRedeemLimitShares=1000000000`、`creationRedemptionUnitShares=1300000`。
- 2026-10-13 八只净申购（plan 第 7 节「已核实真实值」表，与 CSV 一致）：
  159501=5000000/limited、159509=8000000/limited、159513=null/unlimited、159632=null/unlimited、
  159659=null/unlimited、159660=500000/limited、159696=1000000/limited、159941=1300000/limited。
