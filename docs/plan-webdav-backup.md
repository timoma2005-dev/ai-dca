**PLAN ONLY：尚未实施。**

**是，cn 机器上的 ai-dca 全部用户数据目前存放在两个 SQLite 文件中：**

- `auth.sqlite`：用户、会话、同步发件箱及同步状态。
- `cn-data.db`：通知配置、规则、用户通知记录、账户资源、资源记录及持仓交易等业务数据。

静态前端文件、nginx/supervisor 配置等属于部署产物，可从 git 恢复。建议额外备份一份配置目录，非本计划必需项。

## 1. 现状

主机：`root@rdfo1495558.bohrium.tech`。已有 Node.js v22、`node:sqlite` 和 curl 7.81.0；未安装 sqlite3 CLI、rclone。

| 文件 | 大小 | WAL 大小 | 主要表及行数 |
|---|---:|---:|---|
| `/var/lib/ai-dca-auth/auth.sqlite` | 356K | 4.0M | users：342；sessions：279；sync_outbox：2；sync_state：0 |
| `/var/lib/ai-dca-cn-data/cn-data.db` | 67M | 61M | notify_user_records：43487；account_resource_records：3080；notify_configs：1202；account_holdings_transactions：616；account_resources：347；notify_rules：83；其余表小或空 |

两个数据库均使用 WAL。业务库 WAL 已达 61M，直接 `cp` 主库可能遗漏已提交数据；分别复制主库和 WAL 也可能获得不一致甚至损坏的副本。

已验证 `node:sqlite` 执行 `VACUUM INTO` 可生成包含 WAL 数据的一致快照，且不产生配套 WAL 文件：业务快照 64.1MB，完整性检查通过、43487 行全部保留；gzip 后约 5.3MB，认证库压缩后约 50KB。

## 2. 设计决策

| 项目 | 方案 | 为什么／权衡 |
|---|---|---|
| 快照 | Node 脚本执行 `VACUUM INTO` | 无 sqlite3 CLI；支持 WAL 下的一致快照；已验证可用。考虑过 SQLite backup API，但当前需求下代码量更大，所得一致快照效果相同，因此不采用 |
| 上传 | curl PUT 到 HTTPS WebDAV | curl 已存在，零新依赖。rclone 未安装、部署更重，因此不采用 |
| 格式 | `cn-data-YYYYMMDD-HHMMSS.db.gz`、`auth-YYYYMMDD-HHMMSS.db.gz` | 压缩约 12 倍，降低上传量；同一批次使用相同 CST 时间戳，便于配对 |
| 指针 | `latest.json` | 记录备份时间（含时区）及两个压缩文件的文件名、字节数、SHA-256；两文件上传并校验成功后才更新，方便恢复定位 |
| 频率 | 每日一次 | 数据由用户操作驱动、写入量小，接受当天尚未备份的变更丢失；可升级为每 6 小时，目前每日足够 |
| 保留 | 7 个每日 + 4 个每周成功备份 | 兼顾近期恢复与月内回溯。按 CST 日期／自然周选取，重叠复用同一组，最多 11 组；过期文件通过 WebDAV DELETE 删除 |
| 凭证 | `/etc/ai-dca-webdav.env`，`root:root`、`0600` | 仅 root 可访问；包含 `WEBDAV_URL`、`WEBDAV_USER`、`WEBDAV_PASS`，绝不进入 git，日志不得输出凭证 |
| 加密 | 默认仅 HTTPS 传输；可选 age/gpg 客户端加密 | 默认部署简单，但网盘上的文件仍为未加密快照。客户端加密可保护静态数据，同时增加依赖、密钥保管及恢复复杂度 |

两个数据库分别保证事务一致性，不保证跨库同一时刻的原子快照；如未来要求严格跨库一致，应增加短暂停写窗口。

## 3. 实施步骤

1. **取得 WebDAV 地址与凭证。** 建议使用应用专用密码及专用备份目录，验证 HTTPS 和 PUT、GET、HEAD、PROPFIND、DELETE 能力。使用现有入口连接：
   `ssh -o ProxyCommand="nc -X connect -x 198.19.0.1:3128 %h %p" -i ~/.ssh/id_ed25519 root@rdfo1495558.bohrium.tech`

2. **编写备份脚本。** 创建 `/opt/ai-dca-backup/backup.sh` 与 `snapshot.js`：互斥执行、为两个数据库生成快照并检查完整性、gzip、计算摘要、curl PUT 重试、HEAD/PROPFIND 核对远端大小、下载核对 SHA-256、更新 manifest、执行保留清理。日志写入 `/var/log/ai-dca-backup.log`。

3. **编写恢复脚本。** 创建 `/opt/ai-dca-backup/restore.sh`：读取 manifest、下载、校验 SHA-256、gunzip、执行 `PRAGMA integrity_check`；通过显式覆盖确认后，停止所有访问数据库的服务，保存原 DB/WAL/SHM 回滚副本，替换数据库、移除旧 WAL/SHM、恢复属主权限，再重启服务。

4. **配置凭证安全。** 凭证文件设置 `root:root`、`0600`；脚本使用 `umask 077`，临时目录仅 root 可访问。curl 认证通过受保护配置文件传入，避免密码出现在命令行参数中。

5. **手动试运行。** 完成一次双库备份，重新下载并解压，验证摘要、完整性和关键表行数；在隔离目录演练恢复。

6. **配置 root crontab。** 建议每日 **03:30 CST（Asia/Shanghai）** 执行。先确认 cron 所用时区：
   - CST 主机：`30 3 * * * /opt/ai-dca-backup/backup.sh >> /var/log/ai-dca-backup.log 2>&1`
   - UTC 主机：`30 19 * * * /opt/ai-dca-backup/backup.sh >> /var/log/ai-dca-backup.log 2>&1`

   文件命名及保留计算统一使用 `TZ=Asia/Shanghai`；配置日志轮转。

7. **可选告警。** 任一步骤失败返回非零状态，并通过现有通知通道告警，附批次时间和失败阶段，不携带凭证。

## 4. 脚本清单

| 脚本 | 用途与关键逻辑 |
|---|---|
| `snapshot.js` | 用 `DatabaseSync` 打开源库，设置 `busy_timeout`；对不存在的目标路径执行 `VACUUM INTO <snapshot>`；打开快照执行 `PRAGMA integrity_check`，记录关键表行数并关闭连接 |
| `backup.sh` | 加锁 → 检查空间 → `mktemp -d` → 双库快照 → `gzip` → `sha256sum` → PUT → 远端校验 → PUT `latest.json` → 保留清理 → 退出时清理临时文件 |
| `restore.sh` | 下载指定批次／latest → 校验压缩文件大小与 SHA-256 → gunzip → 完整性检查 → 检查 `--confirm-overwrite` → 停服务 → 保存回滚集 → 替换双库 → 清除旧 WAL/SHM → 重启与业务检查 |

关键上传参数：`curl --fail --show-error --retry 3 --retry-delay 5 --connect-timeout 15 --max-time 300 --config <认证配置> -T <压缩文件> <目标URL>`。

清理逻辑：使用 `PROPFIND`、`Depth: 1` 获取列表，仅处理专用目录内匹配约定命名的成对文件；保护 `latest.json` 引用的批次。上传或校验失败时，不推进指针、不执行保留清理。WebDAV ETag 不作为 SHA-256 使用。

## 5. 测试／验收步骤

- 两个 gzip 文件使用同一时间戳；`latest.json` 中时间、文件名、大小、SHA-256 与本地及下载结果一致。
- HEAD/PROPFIND 返回的文件大小匹配；下载文件通过 `gzip -t`，解压后 `PRAGMA integrity_check` 返回 `ok`。
- 关键表行数与该次快照日志一致；首次当前基准为用户 342 行、通知用户记录 43487 行，后续以备份时实际值为准。
- 隔离恢复成功；未提供 `--confirm-overwrite` 时不得覆盖线上数据库。实际恢复后确认服务健康、用户登录及业务数据可用，数据库恢复 WAL 模式。
- 模拟上传失败，确认非零退出、日志／告警可定位，旧指针及有效备份仍保留。
- 验证 7 个每日 + 4 个每周保留选择、DELETE 范围，以及并发执行互斥、临时文件清理和 cron 实际触发时间。

## 6. 风险与缓解

| 风险 | 缓解措施 |
|---|---|
| 备份期间有写入 | `VACUUM INTO` 提供事务一致快照，包含快照时已提交的 WAL 数据；设置忙等待及有限重试 |
| WebDAV 凭证泄露 | `root:root`、`0600`；不进 git、不写日志、不放入 curl 命令行参数；优先应用专用密码 |
| `/tmp` 磁盘满 | 当前可用 94G，单次快照及压缩临时占用约 70M；运行前检查空间，互斥执行，退出时清理 |
| 静默备份失败 | curl 检查 HTTP 错误，HEAD/PROPFIND 核对大小，下载核对摘要；日志记录结果，可选失败告警 |
| 恢复覆盖线上数据 | 强制显式 `--confirm-overwrite`；校验通过后才停服务，替换前保留完整回滚集 |
| 旧 WAL 污染恢复库 | 停止全部读写服务后保存并移除旧 WAL/SHM，再替换数据库、重启验证 |
