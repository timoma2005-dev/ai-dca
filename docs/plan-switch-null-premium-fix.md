# Switch null premium 修复计划

1. 保持 cn 分支，只修改 collector premiumPct 映射一行；补充显式 null/undefined 守卫。原要求表达式的 Number.isFinite(Number(null)) 为 true，仍会保留 bug，因此必须先检查空值。
2. 增加两个基金 premiumPercent 为 null 的回归用例，验证 collector 保留 null、规则快照差值为空、评估器跳过且不消耗额度；运行相关 node 测试、refactor guard、lint、diff 检查。
3. 本地提交代码、测试和计划，不 push。
4. SSH/scp 最多重试 25 次，失败间隔 8 秒；部署前核对远端 md5 必须为 d02c001ed3413271804454ed00f6e196，不符立即停止。
5. 查明常驻循环管理方式，校验 /proc/PID/cmdline 后按精确 PID 停止并恢复循环；检查新 PID 和新日志。

风险：指定表达式不能修复 null；远端漂移必须停止覆盖；SSH 抖动可能使执行结果不确定，重启前再次确认进程状态，禁止 pkill -f。

验证标准：两个 null 溢价保持 null，不产生 switch/OTC 触发且无计数更新；真实数值 0 仍可使用；所有要求检查通过；远端文件与本地一致、新进程存活且出现新的启动或心跳日志。
