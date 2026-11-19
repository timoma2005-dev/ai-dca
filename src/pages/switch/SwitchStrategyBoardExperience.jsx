import { demoAccessToken } from '../../app/demo/demoMode.js';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { motionTokens } from '../../components/arc/lib/motion-tokens.js';
import {
  loadSwitchConfigFromWorker,
  loadSwitchGuide,
  loadSwitchSnapshotFromWorker,
  normalizeSwitchConfigShape,
  readSwitchConfigCache,
  saveSwitchConfigToWorker
} from '../../app/switchStrategySync.js';
import { testSwitchConfig } from '../../app/switchStrategyTestSync.js';
import { loadCloudSession } from '../../app/authClient.js';
import { apiUrl } from '../../app/apiBase.js';
import { buildSwitchBoardRows, filterSwitchBoardRows, summarizeSwitchBoard } from './switchBoardModel.js';
import { readSwitchRuleChannelMap } from './switchRuleChannels.js';
import { SwitchStrategyMetricsBar } from './SwitchStrategyMetricsBar.jsx';
import { SwitchStrategyCardItem } from './SwitchStrategyCardItem.jsx';
import { SwitchStrategyTable } from './SwitchStrategyTable.jsx';
import { SwitchStrategyRuleModal } from './SwitchStrategyRuleModal.jsx';
import { SwitchDemoTeaserCard } from './SwitchDemoTeaserCard.jsx';
import { SwitchGuide } from './SwitchGuide.jsx';
import { SWITCH_GUIDE_DEMO } from '../../app/demo/fixtures/switchGuide.js';
import { useDemoActive, useFeatureDemo } from '../../components/rbac/demo-lock.jsx';
import { FollowAlongHint } from '../../components/onboarding/FollowAlongHint.jsx';
import { normalizeSwitchEntryAttribution } from '../switchStrategyViewUtils.js';
import { readLedgerState } from '../../app/holdingsLedger.js';
import { buildTransactionId, normalizeTransaction } from '../../app/holdingsLedgerBasics.js';
import { readCurrentHoldingTransactions } from '../../app/holdingTransactionsSync.js';
import { persistHoldingTransactionMutation } from '../../app/holdingTransactionMutations.js';
import { SwitchAnswerDialog } from './SwitchAnswerDialog.jsx';
import {
  availableShares,
  buildFlippedRule,
  buildQuietRule,
  buildSwitchLedgerDrafts,
  findRowForEntry,
  resolveSignalPrompt,
  shanghaiToday
} from '../../app/switchSignalAnswer.js';

const ENTRY_PARAMS = ['source', 'code', 'targetCode', 'trigger', 'rule', 'answer'];

function readNotificationEntry() {
  if (typeof window === 'undefined') return null;
  const entry = normalizeSwitchEntryAttribution();
  if (!entry.fromNotification || !entry.notificationCode || !entry.notificationTargetCode) return null;
  const answer = new URLSearchParams(window.location.search || '').get('answer') || '';
  return { ...entry, answer: answer === 'done' || answer === 'skip' ? answer : '' };
}

function clearNotificationEntryParams() {
  if (typeof window === 'undefined' || !window.history?.replaceState) return;
  try {
    const url = new URL(window.location.href);
    ENTRY_PARAMS.forEach((key) => url.searchParams.delete(key));
    window.history.replaceState(window.history.state, '', `${url.pathname}${url.search}${url.hash}`);
  } catch (_error) { /* ignore */ }
}

function persistSwitchLedger(drafts) {
  const rows = drafts.map((draft) => normalizeTransaction(draft));
  const base = readLedgerState();
  const current = readCurrentHoldingTransactions();
  const nextState = { ...base, transactions: [...(Array.isArray(current) ? current : []), ...rows] };
  return persistHoldingTransactionMutation(nextState, {
    kind: 'create',
    label: '正在记录换基',
    upsertIds: rows.map((row) => row.id)
  }).then(() => rows.map((row) => row.id));
}

function deleteSwitchLedger(ids = []) {
  const remove = new Set(ids.filter(Boolean));
  if (!remove.size) return Promise.resolve();
  const base = readLedgerState();
  const current = readCurrentHoldingTransactions();
  const nextState = { ...base, transactions: (Array.isArray(current) ? current : []).filter((tx) => !remove.has(tx.id)) };
  return persistHoldingTransactionMutation(nextState, {
    kind: 'delete',
    label: '正在撤销换基记录',
    deletedIds: Array.from(remove)
  });
}

function isFundCode(value) {
  return /^\d{6}$/.test(String(value || '').trim());
}

function uniqueCodes(values = []) {
  return Array.from(new Set(values.map((value) => String(value || '').trim()).filter(isFundCode)));
}

function buildRuleFromPayload(payload, existingRule = null, ruleId = '') {
  const highCodes = uniqueCodes(Array.isArray(payload.highCodes) ? payload.highCodes : [payload.highCode]);
  const lowCodes = uniqueCodes(Array.isArray(payload.lowCodes) ? payload.lowCodes : [payload.lowCode])
    .filter((code) => !highCodes.includes(code));
  const allCodes = [...highCodes, ...lowCodes];
  const holdingSide = payload.holdingSide === 'L' ? 'L' : 'H';
  const benchmarkCodes = holdingSide === 'L' ? lowCodes : highCodes;
  const requestedHoldingCode = isFundCode(payload.holdingFundCode) && benchmarkCodes.includes(payload.holdingFundCode)
    ? payload.holdingFundCode
    : '';
  const existingHoldingCode = isFundCode(existingRule?.holdingFundCode) && benchmarkCodes.includes(existingRule.holdingFundCode)
    ? existingRule.holdingFundCode
    : '';
  const selectedHoldingCode = requestedHoldingCode || existingHoldingCode || benchmarkCodes[0] || '';
  const keepingHoldingMetadata = Boolean(existingRule?.holdingFundCode)
    && existingRule.holdingFundCode === selectedHoldingCode;
  return {
    ...(existingRule || {}),
    id: ruleId,
    name: payload.name,
    enabled: existingRule ? Boolean(existingRule.enabled) : true,
    benchmarkCodes,
    enabledCodes: allCodes,
    premiumClass: Object.fromEntries([
      ...highCodes.map((code) => [code, 'H']),
      ...lowCodes.map((code) => [code, 'L'])
    ]),
    intraSellLowerPct: payload.lowerPct,
    intraBuyOtherPct: payload.upperPct,
    candidateFundCodes: uniqueCodes(
      Array.isArray(payload.candidateFundCodes)
        ? payload.candidateFundCodes
        : allCodes.filter((code) => !benchmarkCodes.includes(code))
    ),
    ...(payload.autoGenerated ? {
      holdingFundCode: payload.holdingFundCode,
      holdingFundName: payload.holdingFundName,
      holdingQuantity: payload.holdingQuantity,
      holdingNotional: payload.holdingNotional,
      candidateFundCodes: payload.candidateFundCodes,
      feeConfig: payload.feeConfig,
      backtestTimeframe: payload.backtestTimeframe || '5m'
    } : {}),
    // 持仓方向由 benchmarkCodes 表示。切换到对手方后同步更新持仓元数据，
    // 避免规则仍然保留旧持有基金的信息。
    holdingFundCode: selectedHoldingCode,
    holdingFundName: String(payload.holdingFundName || (keepingHoldingMetadata ? existingRule?.holdingFundName : '') || '').trim(),
    holdingQuantity: keepingHoldingMetadata ? (payload.holdingQuantity ?? existingRule?.holdingQuantity ?? null) : (payload.holdingQuantity ?? null),
    holdingNotional: keepingHoldingMetadata ? (payload.holdingNotional ?? existingRule?.holdingNotional ?? null) : (payload.holdingNotional ?? null)
  };
}

function mergeSwitchSnapshot(current, payload) {
  const previousRoot = current?.snapshot && typeof current.snapshot === 'object'
    ? current.snapshot
    : (current && typeof current === 'object' ? current : {});
  const incomingRoot = payload?.snapshot && typeof payload.snapshot === 'object'
    ? payload.snapshot
    : (payload && typeof payload === 'object' ? payload : null);
  if (!incomingRoot) return current;
  const incomingRules = Array.isArray(incomingRoot.rules) ? incomingRoot.rules : [];
  const incomingIds = new Set(incomingRules.map((entry) => String(entry?.ruleId || entry?.id || entry?.snapshot?.ruleId || '')).filter(Boolean));
  const previousRules = Array.isArray(previousRoot.rules) ? previousRoot.rules : [];
  return {
    snapshot: {
      ...previousRoot,
      ...incomingRoot,
      rules: [
        ...previousRules.filter((entry) => !incomingIds.has(String(entry?.ruleId || entry?.id || entry?.snapshot?.ruleId || ''))),
        ...incomingRules
      ]
    }
  };
}

function hasFiniteValue(value) {
  return value != null && value !== '' && Number.isFinite(Number(value));
}

function snapshotHasRulePremium(snapshot, ruleId) {
  const root = snapshot?.snapshot || snapshot;
  const entry = (Array.isArray(root?.rules) ? root.rules : []).find((item) => (
    String(item?.ruleId || item?.id || item?.snapshot?.ruleId || '') === String(ruleId || '')
  ));
  const value = entry?.snapshot || entry;
  return (Array.isArray(value?.byBenchmark) ? value.byBenchmark : []).some((group) => (
    hasFiniteValue(group?.benchmarkPremiumPct)
      || (Array.isArray(group?.candidates) && group.candidates.some((item) => hasFiniteValue(item?.premiumPct)))
  ));
}

export function SwitchStrategyBoardExperience({ onOpenBacktest, onOpenQuickTrade } = {}) {
  const demoActive = useDemoActive();
  const reduceMotion = useReducedMotion();
  const featureDemo = useFeatureDemo();
  const [config, setConfig] = useState(() => normalizeSwitchConfigShape(readSwitchConfigCache()));
  const [snapshot, setSnapshot] = useState(null);
  const [keyword, setKeyword] = useState('');
  const [viewMode, setViewMode] = useState('grid');
  const [modalOpen, setModalOpen] = useState(false);
  const [editingRuleId, setEditingRuleId] = useState('');
  const [channelMap] = useState(() => readSwitchRuleChannelMap());
  const [busyRuleId, setBusyRuleId] = useState('');
  const [testingRuleId, setTestingRuleId] = useState('');
  const [guide, setGuide] = useState(null);
  // 新建方案：有引导数据时进入「换基引导」全页流程，保存后回到方案列表；没有数据时退回老弹窗
  const [creating, setCreating] = useState(false); // false | 'guide' | 'legacy'
  const [flip, setFlip] = useState('');
  // 持仓跟着提醒走：从提醒点进来的入口、确认弹窗、每张卡的回答结果
  const [entry, setEntry] = useState(() => readNotificationEntry());
  const [configLoaded, setConfigLoaded] = useState(false);
  const [answerTarget, setAnswerTarget] = useState(null);
  const [answeringId, setAnsweringId] = useState('');
  const [notices, setNotices] = useState({});
  const configRef = useRef(config);
  configRef.current = config;
  const rootRef = useRef(null);
  const backToTop = useCallback(() => {
    requestAnimationFrame(() => rootRef.current?.scrollIntoView({ block: 'start' }));
  }, []);

  // 换基引导（看懂溢价 / 价差 / 平时，再一步建方案）：演示模式用固定快照，登录用户取实时统计
  useEffect(() => {
    if (demoActive) { setGuide(SWITCH_GUIDE_DEMO); return undefined; }
    let alive = true;
    loadSwitchGuide().then((data) => { if (alive && data?.win) setGuide(data); }).catch(() => {});
    return () => { alive = false; };
  }, [demoActive]);

  useEffect(() => {
    Promise.all([
      loadSwitchConfigFromWorker().catch(() => null),
      loadSwitchSnapshotFromWorker().catch(() => null)
    ]).then(([nextConfig, nextSnapshot]) => {
      if (nextConfig) setConfig(nextConfig);
      if (nextSnapshot) setSnapshot(nextSnapshot);
      setConfigLoaded(true);
      // 首屏补算：只测已配置标的（有 H/L 代码）且快照里还没有溢价的方案，
      // 不再拿 activeRuleId 指向的空「默认规则」去测。
      const pending = (nextConfig?.rules || [])
        .filter((rule) => rule.enabled !== false && ((rule.benchmarkCodes || []).length || (rule.enabledCodes || []).length))
        .filter((rule) => !snapshotHasRulePremium(nextSnapshot, rule.id))
        .sort((a, b) => (a.id === nextConfig?.activeRuleId ? -1 : 0) - (b.id === nextConfig?.activeRuleId ? -1 : 0))
        .slice(0, 6);
      pending.reduce((chain, rule) => chain.then(() => testSwitchConfig({
        ...nextConfig,
        enabled: true,
        activeRuleId: rule.id,
        rules: [{ ...rule, enabled: true }]
      }).then((payload) => {
        setSnapshot((current) => mergeSwitchSnapshot(current || nextSnapshot, payload));
      }).catch(() => {})), Promise.resolve());
    });
  }, []);

  const rules = useMemo(
    () => (config.rules || []).filter((rule) => (rule.benchmarkCodes || []).length || (rule.enabledCodes || []).length),
    [config]
  );
  const rows = useMemo(() => buildSwitchBoardRows({ rules }, snapshot, { channelsByRuleId: channelMap }), [rules, snapshot, channelMap]);

  const visibleRows = useMemo(() => filterSwitchBoardRows(rows, keyword), [rows, keyword]);
  const summary = useMemo(() => summarizeSwitchBoard(rows), [rows]);
  const monitoring = useMemo(() => rows.filter((r) => r.enabled).length, [rows]);
  const editingRow = useMemo(() => rows.find((row) => row.id === editingRuleId) || null, [rows, editingRuleId]);
  const today = shanghaiToday();
  const entryRow = useMemo(() => findRowForEntry(rows, entry), [rows, entry]);
  const prompts = useMemo(() => Object.fromEntries(rows.map((row) => [
    row.id,
    resolveSignalPrompt(row, { today, entry: entryRow?.id === row.id ? entry : null })
  ])), [rows, today, entry, entryRow]);

  // 只改一条规则并同步到云端（提醒 worker 下一分钟就按新方案判断）。
  const saveRule = useCallback(async (ruleId, nextRule) => {
    const current = configRef.current;
    const nextConfig = normalizeSwitchConfigShape({
      ...current,
      rules: (current.rules || []).map((rule) => (rule.id === ruleId ? nextRule : rule))
    });
    setConfig(nextConfig);
    await saveSwitchConfigToWorker(nextConfig);
    return nextConfig;
  }, []);

  const openAnswerSwitch = useCallback((row, prompt) => {
    const available = availableShares(readCurrentHoldingTransactions(), prompt.fromCode);
    setAnswerTarget({ row, prompt, available });
  }, []);

  const handleConfirmSwitch = useCallback(async (values) => {
    const target = answerTarget;
    if (!target) return;
    const { row, prompt } = target;
    const prevRule = row.rule;
    setAnsweringId(row.id);
    let txIds = [];
    try {
      if (values.writeLedger) {
        const drafts = buildSwitchLedgerDrafts({
          fromCode: prompt.fromCode,
          fromName: prompt.fromName,
          toCode: prompt.toCode,
          toName: prompt.toName,
          sellPrice: values.sellPrice,
          sellShares: values.sellShares,
          buyPrice: values.buyPrice,
          buyShares: values.buyShares,
          date: today,
          makeId: buildTransactionId
        });
        txIds = await persistSwitchLedger(drafts);
      }
      const nextRule = buildFlippedRule(prevRule, {
        fromCode: prompt.fromCode,
        toCode: prompt.toCode,
        toName: prompt.toName,
        signalRule: prompt.signalRule,
        buyShares: values.writeLedger ? values.buyShares : null,
        sellTxId: txIds[0] || '',
        buyTxId: txIds[1] || ''
      });
      await saveRule(row.id, nextRule);
      setNotices((current) => ({
        ...current,
        [row.id]: {
          tone: 'ok',
          text: `已换到 ${prompt.toCode}，方案改为盯换回的方向${txIds.length ? '；账本记了一卖一买' : ''}。`,
          undo: { type: 'switch', prevRule, txIds }
        }
      }));
      setAnswerTarget(null);
      if (entryRow?.id === row.id) setEntry(null);
    } catch (error) {
      console.warn('switch answer failed:', error);
      setNotices((current) => ({ ...current, [row.id]: { tone: 'warn', text: `没保存成功：${error?.message || '请稍后再试'}` } }));
    } finally {
      setAnsweringId('');
    }
  }, [answerTarget, today, saveRule, entryRow]);

  const handleAnswerSkip = useCallback(async (row, prompt) => {
    const prevRule = row.rule;
    setAnsweringId(row.id);
    try {
      await saveRule(row.id, buildQuietRule(prevRule, { signalRule: prompt.signalRule, today }));
      setNotices((current) => ({
        ...current,
        [row.id]: { tone: 'muted', text: '好，今天不再提醒这个方向，明天照常。', undo: { type: 'quiet', prevRule } }
      }));
      if (entryRow?.id === row.id) setEntry(null);
    } catch (error) {
      console.warn('switch skip failed:', error);
      setNotices((current) => ({ ...current, [row.id]: { tone: 'warn', text: `没保存成功：${error?.message || '请稍后再试'}` } }));
    } finally {
      setAnsweringId('');
    }
  }, [saveRule, today, entryRow]);

  const handleUndoNotice = useCallback(async (row, notice) => {
    const undo = notice?.undo;
    if (!undo?.prevRule) return;
    setAnsweringId(row.id);
    try {
      if (undo.txIds?.length) await deleteSwitchLedger(undo.txIds);
      await saveRule(row.id, undo.prevRule);
      setNotices((current) => { const next = { ...current }; delete next[row.id]; return next; });
    } catch (error) {
      console.warn('switch undo failed:', error);
    } finally {
      setAnsweringId('');
    }
  }, [saveRule]);

  // 从提醒点进来：滚到对应方案；链接里带 answer=done/skip（站内信按钮）时直接接着回答。
  const entryHandledRef = useRef(false);
  useEffect(() => {
    if (!entry || entryHandledRef.current || !configLoaded) return;
    if (!entryRow) { entryHandledRef.current = true; clearNotificationEntryParams(); return; }
    entryHandledRef.current = true;
    clearNotificationEntryParams();
    const prompt = prompts[entryRow.id];
    if (typeof document !== 'undefined') {
      requestAnimationFrame(() => document.querySelector(`[data-switch-card="${entryRow.id}"]`)?.scrollIntoView({ block: 'center', behavior: 'smooth' }));
    }
    if (!prompt) return;
    if (entry.answer === 'done') openAnswerSwitch(entryRow, prompt);
    else if (entry.answer === 'skip') handleAnswerSkip(entryRow, prompt);
  }, [entry, entryRow, configLoaded, prompts, openAnswerSwitch, handleAnswerSkip]);
  const entryPrompt = entryRow ? prompts[entryRow.id] : null;

  // 处理方案保存（新建 / 编辑），配置结构与 Worker 的多基准模型保持一致。
  const handleSaveRule = useCallback(async (payload) => {
    const isNew = !payload.ruleId;
    const ruleId = isNew ? `rule-${Date.now().toString(36)}` : payload.ruleId;
    const existingRule = (config.rules || []).find((rule) => rule.id === payload.ruleId) || null;
    const nextRule = buildRuleFromPayload(payload, existingRule, ruleId);
    const nextRules = isNew
      ? [...(config.rules || []), nextRule]
      : (config.rules || []).map((rule) => (rule.id === ruleId ? nextRule : rule));
    const nextConfig = normalizeSwitchConfigShape({
      ...config,
      enabled: true,
      activeRuleId: ruleId,
      rules: nextRules
    });

    setConfig(nextConfig);
    setModalOpen(false);
    setBusyRuleId(ruleId);
    try {
      await saveSwitchConfigToWorker(nextConfig);
      const savedRule = (nextConfig.rules || []).find((rule) => rule.id === ruleId);
      if (savedRule) {
        const payloadResult = await testSwitchConfig({
          ...nextConfig,
          enabled: true,
          activeRuleId: ruleId,
          rules: [{ ...savedRule, enabled: true }]
        });
        setSnapshot((current) => mergeSwitchSnapshot(current, payloadResult));
      }
    } catch (error) {
      console.warn('Worker sync error:', error);
    } finally {
      setBusyRuleId('');
    }
  }, [config]);

  // 仅测试当前规则，保留多 H / 多 L 配置，并用返回快照更新看板。
  const handleTestRule = useCallback(async (row) => {
    const sourceRule = row.rule || {};
    const rule = {
      ...sourceRule,
      id: row.id,
      name: row.name,
      enabled: true
    };
    setTestingRuleId(row.id);
    try {
      const payload = await testSwitchConfig({
        ...config,
        enabled: false,
        activeRuleId: rule.id,
        rules: [rule]
      });
      setSnapshot((current) => mergeSwitchSnapshot(current, payload));
    } catch (error) {
      console.warn('testSwitchConfig feedback trigger:', error);
    } finally {
      setTestingRuleId('');
    }
  }, [config]);

  const handleToggleRule = useCallback(async (row) => {
    const nextConfig = normalizeSwitchConfigShape({
      ...config,
      rules: (config.rules || []).map((rule) => rule.id === row.id ? { ...rule, enabled: !rule.enabled } : rule)
    });
    setConfig(nextConfig);
    setBusyRuleId(row.id);
    try {
      await saveSwitchConfigToWorker(nextConfig);
    } catch (error) {
      console.warn('Worker sync error:', error);
    } finally {
      setBusyRuleId('');
    }
  }, [config]);

  const handleDeleteRule = useCallback(async (row) => {
    if (typeof window !== 'undefined' && !window.confirm(`确定删除“${row.name}”吗？删除后将同步到云端。`)) return;
    const nextRules = (config.rules || []).filter((rule) => rule.id !== row.id);
    const nextConfig = normalizeSwitchConfigShape({
      ...config,
      activeRuleId: config.activeRuleId === row.id ? (nextRules[0]?.id || '') : config.activeRuleId,
      rules: nextRules
    });
    setConfig(nextConfig);
    setBusyRuleId(row.id);
    try {
      await saveSwitchConfigToWorker(nextConfig);
    } catch (error) {
      console.warn('Worker sync error:', error);
    } finally {
      setBusyRuleId('');
    }
  }, [config]);

  // 复用旧版 Beta 的云端候选分析流程，为新建弹窗生成 H/L 双腿和阈值。
  const handleAutoFillRule = useCallback(async ({ holdingCode, feeWanRate }) => {
    const normalizedHoldingCode = String(holdingCode || '').trim();
    if (!isFundCode(normalizedHoldingCode)) throw new Error('请填写 6 位当前持仓代码。');
    const normalizedFeeWanRate = Number(feeWanRate);
    if (!Number.isFinite(normalizedFeeWanRate) || normalizedFeeWanRate < 0) {
      throw new Error('请填写有效的万分之交易费率。');
    }
    // 对手方选择与阈值计算全部由后端 /api/notify/switch/recommend 完成，
    // 前端不再做客户端回测与硬编码兜底，避免选出固定对手方。
    const session = loadCloudSession();
    const accessToken = String(demoAccessToken(session?.accessToken) || '').trim();
    if (!accessToken) {
      const error = new Error('请先登录账户后使用自动填充。');
      error.status = 401;
      error.code = 'AUTH_REQUIRED';
      throw error;
    }
    const response = await fetch(apiUrl('/api/notify/switch/recommend'), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${accessToken}`
      },
      body: JSON.stringify({ holdingCode: normalizedHoldingCode, feeWanRate: normalizedFeeWanRate })
    });
    const payload = await response.json().catch(() => ({}));
    if (!response.ok || payload?.ok === false || !payload?.rule) {
      const error = new Error(payload?.error || `自动填充失败：状态 ${response.status}`);
      error.status = response.status;
      error.code = String(payload?.code || '');
      throw error;
    }
    return payload.rule;
  }, []);

  // 新版 ⇄ 旧版：整页翻过去，再翻回来
  const flipTo = (mode) => {
    if (flip) return;
    setFlip('out');
    setTimeout(() => {
      setFlip('');
      setEditingRuleId('');
      setCreating(mode);
      backToTop();
    }, 320);
  };

  if (creating) {
    const legacy = creating === 'legacy' || !guide;
    return (
      <div className="sg-flipstage" ref={rootRef} style={{ scrollMarginTop: 76 }}>
      <div key={legacy ? 'legacy' : 'guide'} className={`space-y-3 sm:space-y-4 ${flip === 'out' ? 'sg-flipout' : 'sg-flipin'}`}>
        <div className="flex items-center justify-between gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm font-semibold text-slate-700 hover:bg-slate-50"
            onClick={() => { setCreating(false); backToTop(); }}
          >
            ← 返回方案列表
          </button>
          {guide ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-full border border-slate-200 bg-white px-3 py-1.5 text-sm text-slate-600 hover:bg-slate-50"
              onClick={() => flipTo(legacy ? 'guide' : 'legacy')}
            >
              ⇄ {legacy ? '新版' : '旧版'}
            </button>
          ) : null}
        </div>
        {legacy ? (
          <SwitchStrategyRuleModal
            inline
            open
            saving={Boolean(busyRuleId)}
            onClose={() => { setCreating(false); backToTop(); }}
            onSave={(payload) => { handleSaveRule(payload); setCreating(false); setKeyword(''); backToTop(); }}
            existingRules={config.rules || []}
          />
        ) : (
        <SwitchGuide
          guide={guide}
          existingRules={config.rules || []}
          saving={Boolean(busyRuleId)}
          onSave={async (payload) => { await handleSaveRule(payload); return true; }}
          onDone={() => { setCreating(false); setKeyword(''); backToTop(); }}
        />
        )}
      </div>
      </div>
    );
  }

  return (
    <div className="space-y-3 sm:space-y-4" ref={rootRef} style={{ scrollMarginTop: 76 }}>
      {demoActive ? <SwitchDemoTeaserCard onUpgrade={featureDemo?.onUpgrade} /> : null}
      {!demoActive && rows.length === 0 ? <FollowAlongHint flow="switch" text="第一次用？跟着做，约 1 分钟设好一个切换提醒" /> : null}
      {entryPrompt ? (
        <div className="flex flex-wrap items-center gap-2 rounded-2xl border border-indigo-200 bg-indigo-50 px-3.5 py-2.5 text-sm text-slate-700">
          <span className="min-w-0 flex-1">
            你从提醒进来：<b className="font-mono text-rose-600">卖 {entryPrompt.fromCode}</b> → <b className="font-mono text-emerald-600">买 {entryPrompt.toCode}</b>，换了吗？
          </span>
          <span className="flex gap-2">
            <button type="button" disabled={Boolean(answeringId)} onClick={() => openAnswerSwitch(entryRow, entryPrompt)} className="rounded-lg bg-slate-900 px-3 py-1.5 text-xs font-semibold text-white disabled:opacity-50">我换了</button>
            <button type="button" disabled={Boolean(answeringId)} onClick={() => handleAnswerSkip(entryRow, entryPrompt)} className="rounded-lg border border-slate-200 bg-white px-3 py-1.5 text-xs font-semibold text-slate-700 disabled:opacity-50">这次不换</button>
          </span>
        </div>
      ) : null}
      {/* 统计概览与操作栏 */}
      <SwitchStrategyMetricsBar
        total={rows.length}
        monitoring={monitoring}
        triggeredToday={summary.triggeredToday}
        keyword={keyword}
        onKeywordChange={setKeyword}
        viewMode={viewMode}
        onViewModeChange={setViewMode}
        onCreate={() => {
          setEditingRuleId(''); setCreating(guide ? 'guide' : 'legacy'); backToTop();
        }}
      />

      {/* 方案卡片列表 */}
      {viewMode === 'grid' ? (
        <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3 sm:gap-4">
          {/* 搜索/删除时卡片淡出，其余卡片沿网格滑到新位置；新建的方案从下方轻微上浮 */}
          <AnimatePresence initial={false} mode="popLayout">
            {visibleRows.map((row) => (
              <motion.div
                key={row.id}
                layout={!reduceMotion}
                initial={reduceMotion ? false : { opacity: 0, y: 8, scale: 0.98 }}
                animate={{ opacity: 1, y: 0, scale: 1 }}
                exit={reduceMotion ? { opacity: 0, transition: { duration: 0.1 } } : { opacity: 0, scale: 0.97, transition: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] } }}
                transition={reduceMotion ? { duration: 0 } : motionTokens.spring.smooth}
              >
                <div data-switch-card={row.id} className="h-full">
                <SwitchStrategyCardItem
                  row={row}
                  prompt={notices[row.id]?.tone === 'ok' ? null : prompts[row.id]}
                  notice={notices[row.id] || null}
                  answering={answeringId === row.id}
                  onAnswerSwitch={openAnswerSwitch}
                  onAnswerSkip={handleAnswerSkip}
                  onUndoNotice={handleUndoNotice}
                  busy={busyRuleId === row.id}
                  testing={testingRuleId === row.id}
                  onToggle={() => handleToggleRule(row)}
                  onEdit={() => { setEditingRuleId(row.id); setModalOpen(true); }}
                  onTest={() => handleTestRule(row)}
                  onDelete={() => handleDeleteRule(row)}
                />
                </div>
              </motion.div>
            ))}
          </AnimatePresence>
        </div>
      ) : (
        <SwitchStrategyTable
          rows={visibleRows}
          busyRuleId={busyRuleId}
          testingRuleId={testingRuleId}
          onEdit={(row) => { setEditingRuleId(row.id); setModalOpen(true); }}
          onToggle={(row) => handleToggleRule(row)}
          onTest={(row) => handleTestRule(row)}
          onDelete={(row) => handleDeleteRule(row)}
        />
      )}

      <SwitchAnswerDialog
        open={Boolean(answerTarget)}
        onOpenChange={(open) => { if (!open && !answeringId) setAnswerTarget(null); }}
        row={answerTarget?.row || null}
        prompt={answerTarget?.prompt || null}
        available={answerTarget?.available || 0}
        saving={Boolean(answeringId)}
        onConfirm={handleConfirmSwitch}
      />

      {/* 规则弹窗 */}
      <SwitchStrategyRuleModal
        open={modalOpen}
        row={editingRow}
        initialRule={editingRow}
        onClose={() => setModalOpen(false)}
        onSave={handleSaveRule}
        existingRules={config.rules || []}
      />
    </div>
  );
}

export default SwitchStrategyBoardExperience;
