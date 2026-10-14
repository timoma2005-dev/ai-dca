import { useCallback, useEffect, useRef, useState } from 'react';
import { radarClient } from '../../app/radarClient.js';
import { RADAR_COMPUTE_LEVEL, radarSession, validRadarEtfs } from '../../app/radarModel.js';

/**
 * 计算状态机（plan §5.1）：
 * idle → waitingNotice | regularConfirm | riskConfirm → submitting → success | failure → idle
 * waitingNotice 只能关闭；riskConfirm 每次打开复位 acknowledged；submitting 期间禁用全部入口。
 */
export const RADAR_COMPUTE_STATE = Object.freeze({
  IDLE: 'idle',
  WAITING_NOTICE: 'waitingNotice',
  REGULAR_CONFIRM: 'regularConfirm',
  RISK_CONFIRM: 'riskConfirm',
  SUBMITTING: 'submitting',
  SUCCESS: 'success',
  FAILURE: 'failure'
});

const DIALOG_STATES = [
  RADAR_COMPUTE_STATE.WAITING_NOTICE,
  RADAR_COMPUTE_STATE.REGULAR_CONFIRM,
  RADAR_COMPUTE_STATE.RISK_CONFIRM
];

const READ_ERRORS = {
  redirect_rejected: '读取被重定向拒绝，已停止加载',
  http_error: '雷达接口返回异常，读取失败',
  invalid_json: '雷达接口返回内容无法解析',
  business_error: '雷达接口返回业务错误',
  invalid_snapshot: '雷达数据校验失败（来源或结构不符）',
  timeout: '读取超时，请稍后重试',
  network: '网络错误，读取失败'
};

function dialogModeForSession(session) {
  if (session.computeLevel === RADAR_COMPUTE_LEVEL.WAIT) return RADAR_COMPUTE_STATE.WAITING_NOTICE;
  if (session.computeLevel === RADAR_COMPUTE_LEVEL.REGULAR) return RADAR_COMPUTE_STATE.REGULAR_CONFIRM;
  return RADAR_COMPUTE_STATE.RISK_CONFIRM;
}

/**
 * 雷达数据与计算生命周期（plan §5.1 / §5.2）：
 * - 读取：idle → loading → ready | empty | error，保留 lastValidData 与 readError；
 * - 计算入口共享同一状态机；确认前重新读取当前时间，时段改变则重新分流；
 * - POST 用同步 ref 锁防同一帧双击；卸载 / 权限丢失后的结果不写组件状态。
 */
export function useRadarData({ enabled = false } = {}) {
  const [readState, setReadState] = useState('idle'); // idle | loading | ready | empty | error
  const [readPending, setReadPending] = useState(false);
  const [data, setData] = useState(null); // lastValidData：计算失败 / 读取失败不清空
  const [receivedAt, setReceivedAt] = useState(null);
  const [readError, setReadError] = useState('');
  const [notice, setNotice] = useState(''); // aria-live：仅播报计算结果与错误
  const [noticeKind, setNoticeKind] = useState(''); // notice 的类别（success | failure），独立于短暂状态机
  const [computeState, setComputeState] = useState(RADAR_COMPUTE_STATE.IDLE);
  const [riskAcknowledged, setRiskAcknowledged] = useState(false);
  const [selectedCode, setSelectedCode] = useState(null);
  const [readTick, setReadTick] = useState(0); // 显式“重新读取”代次
  const submitLockRef = useRef(false);
  const aliveRef = useRef(true);
  const computeStateRef = useRef(RADAR_COMPUTE_STATE.IDLE);

  useEffect(() => {
    aliveRef.current = true;
    return () => {
      aliveRef.current = false;
    };
  }, []);

  useEffect(() => {
    computeStateRef.current = computeState;
  }, [computeState]);

  const applyReadResult = useCallback((result) => {
    if (result.state === 'ready') {
      setData(result.data);
      setReceivedAt(result.receivedAt);
      setReadState('ready');
      setReadError('');
    } else if (result.state === 'empty') {
      // 成功无数据进入空态；旧快照由上层决定是否继续展示（不自动变“新鲜”）。
      setReceivedAt(result.receivedAt);
      setReadState('empty');
      setReadError('');
    } else if (result.state === 'error') {
      setReadState('error');
      setReadError(READ_ERRORS[result.reason] || '读取失败，请稍后重试');
    }
    // aborted / superseded：卸载或已被 POST 结果取代，一律不写组件状态。
    if (result.state !== 'idle') setReadPending(false);
  }, []);

  // 挂载 / 重试 / 权限恢复共用同一 client；重试（readTick > 0）是明确刷新入口，
  // 跳过 memory 直读网络；卸载 release，不 abort 其它订阅的共享请求。
  useEffect(() => {
    if (!enabled) return undefined;
    let active = true;
    setReadPending(true);
    setReadState((prev) => (prev === 'idle' || prev === 'error' || prev === 'empty' ? 'loading' : prev));
    const subscription = radarClient.subscribe({ enabled: true, refresh: readTick > 0 });
    subscription.promise.then((result) => {
      if (!active) return; // 卸载后的返回不渲染旧数据
      applyReadResult(result);
    });
    return () => {
      active = false;
      subscription.release();
    };
  }, [enabled, readTick, applyReadResult]);

  // 权限丢失：清理计算弹窗状态（订阅由上方 effect 的 enabled 清理）。
  useEffect(() => {
    if (!enabled && computeStateRef.current !== RADAR_COMPUTE_STATE.IDLE) {
      setComputeState(RADAR_COMPUTE_STATE.IDLE);
    }
  }, [enabled]);

  // success | failure → idle：结果提示停留由 notice 承载，状态机回到 idle。
  useEffect(() => {
    if (computeState !== RADAR_COMPUTE_STATE.SUCCESS && computeState !== RADAR_COMPUTE_STATE.FAILURE) return undefined;
    const timer = setTimeout(() => {
      if (aliveRef.current) setComputeState(RADAR_COMPUTE_STATE.IDLE);
    }, 5000);
    return () => clearTimeout(timer);
  }, [computeState]);

  // 刷新后重算选中项：代码从有效集合消失则清除选择。
  useEffect(() => {
    if (!selectedCode) return;
    if (!data || !validRadarEtfs(data).some((etf) => etf.code === selectedCode)) setSelectedCode(null);
  }, [data, selectedCode]);

  const requestCompute = useCallback(() => {
    if (!enabled) return;
    if (computeStateRef.current === RADAR_COMPUTE_STATE.SUBMITTING) return;
    // 每次点击都重新读取当前时间并按时段分流；risk 每次打开均复位勾选。
    const mode = dialogModeForSession(radarSession(Date.now()));
    if (mode === RADAR_COMPUTE_STATE.RISK_CONFIRM) setRiskAcknowledged(false);
    setComputeState(mode);
  }, [enabled]);

  const closeComputeDialog = useCallback(() => {
    // submitting 期间弹窗已关闭；取消 / Esc / 遮罩 / 权限变化 / Tab 切换都回到 idle。
    if (computeStateRef.current !== RADAR_COMPUTE_STATE.SUBMITTING) {
      setComputeState(RADAR_COMPUTE_STATE.IDLE);
    }
  }, []);

  const submitCompute = useCallback(async () => {
    if (!enabled || submitLockRef.current) return; // 同一帧双击被同步锁拦下
    // 确认前重新读取当前时间：时段改变则重新分流，已开弹窗不能跨时段直接提交。
    const mode = dialogModeForSession(radarSession(Date.now()));
    if (mode === RADAR_COMPUTE_STATE.WAITING_NOTICE) {
      setComputeState(RADAR_COMPUTE_STATE.WAITING_NOTICE);
      return;
    }
    if (mode === RADAR_COMPUTE_STATE.RISK_CONFIRM) {
      if (!riskAcknowledged) {
        setRiskAcknowledged(false);
        setComputeState(RADAR_COMPUTE_STATE.RISK_CONFIRM);
        return;
      }
    }
    submitLockRef.current = true;
    setRiskAcknowledged(false);
    // 提交前关闭弹窗恢复底部导航，控制台显示 loading。
    setComputeState(RADAR_COMPUTE_STATE.SUBMITTING);
    const result = await radarClient.compute();
    submitLockRef.current = false;
    if (!aliveRef.current) return; // 卸载后的结果不写组件状态
    setNotice(result.message || '');
    if (result.state === 'success') {
      setData(result.data); // 成功以返回真实数据原子替换
      setReceivedAt(result.receivedAt);
      setReadState('ready');
      setReadError('');
      setNoticeKind('success');
      setComputeState(RADAR_COMPUTE_STATE.SUCCESS);
    } else {
      // 失败 / 无有效结果：保留旧快照，只提示“结果未确认”。
      setNoticeKind('failure');
      setComputeState(RADAR_COMPUTE_STATE.FAILURE);
    }
  }, [enabled, riskAcknowledged]);

  const retryRead = useCallback(() => {
    setNotice('');
    setNoticeKind('');
    setReadTick((tick) => tick + 1);
  }, []);

  const toggleSelected = useCallback((code) => {
    setSelectedCode((prev) => (prev === code ? null : code)); // 重复点击关闭
  }, []);

  return {
    readState,
    readPending,
    data,
    receivedAt,
    readError,
    notice,
    noticeKind,
    computeState,
    riskAcknowledged,
    selectedCode,
    isDialogOpen: DIALOG_STATES.includes(computeState),
    requestCompute,
    closeComputeDialog,
    submitCompute,
    retryRead,
    toggleSelected,
    setRiskAcknowledged,
    clearNotice: useCallback(() => {
      setNotice('');
      setNoticeKind('');
    }, [])
  };
}

export default useRadarData;
