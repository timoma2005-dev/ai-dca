-- Lease tracking for transactional outbox claims.
--
-- 背景：claimPendingEvents 会把事件翻成 'processing' 后再投递。若 syncWorker
-- 在这之后崩溃/被 kill，旧实现没有任何机制把卡死的行重置回 pending，事件会
-- 永久停在 processing，导致本地与 D1 静默不一致。新增 claimed_at 记录认领时间，
-- claim 时把超过租约（10 分钟）的 processing 行回收，口径与 cn-data 对齐。
--
-- 历史行的 claimed_at 为 NULL；回收语句用 (claimed_at IS NULL OR ...) 兼容，
-- 使迁移前遗留的卡死 processing 行也能在下次 claim 时被重新投递。
ALTER TABLE sync_outbox ADD COLUMN claimed_at TEXT;
