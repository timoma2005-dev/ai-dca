import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { X } from 'lucide-react';
import { ONBOARDING_FLOWS } from '../../app/onboarding/catalog.js';
import { ONBOARDING_FLOW_COMPLETE_EVENT, ONBOARDING_START_EVENT, setOnboardingHintActive } from '../../app/onboarding/state.js';
import { trackFeatureEvent } from '../../app/analytics.js';
import { BOTTOM_NAV_ALLOWANCE, computeHintPosition } from '../../app/onboarding/hintPosition.js';

const DEFAULT_WAIT_MS = 8000;
const completedRuns = new Set();

/** 教程最后一步完成：通知工作台（回到新手入门 / 演示记完成）。同一次运行只发一次。 */
function emitComplete(run) {
  if (!run || completedRuns.has(run.startedAt)) return;
  completedRuns.add(run.startedAt);
  window.setTimeout(() => window.dispatchEvent(new CustomEvent(ONBOARDING_FLOW_COMPLETE_EVENT, { detail: { flow: run.flowId } })), 0);
}

function isVisible(el) {
  if (!el || !el.isConnected) return false;
  if (typeof el.getClientRects === 'function' && el.getClientRects().length === 0) return false;
  const rect = el.getBoundingClientRect();
  return rect.width > 0 && rect.height > 0;
}

/** 同一标记可能同时存在于桌面 / 手机两套布局，取第一个可见的。 */
export function findOnboardingTarget(target, root = typeof document !== 'undefined' ? document : null) {
  if (!root || !target) return null;
  const nodes = root.querySelectorAll(`[data-onboarding="${target}"]`);
  for (const node of nodes) {
    if (isVisible(node)) return node;
  }
  return null;
}

const ACTIVE_STYLE = `[data-onboarding-active="true"]{outline:3px solid #6366f1!important;outline-offset:3px;box-shadow:0 0 0 9px rgba(99,102,241,.18)!important;border-radius:12px;transition:outline-color .2s}`;

/**
 * 步骤提示宿主：监听 onboarding:start，按 catalog 的步骤依次找到 data-onboarding 目标，
 * 轻度高亮并在旁边显示气泡。不加全屏遮罩、不替用户执行任何操作；目标找不到就安静结束。
 */
export function StepHintHost({ paused: pausedProp = false, demoActive = false }) {
  const [run, setRun] = useState(null);
  const [placementBox, setPlacementBox] = useState(null);
  const [keyboardOpen, setKeyboardOpen] = useState(false);
  const targetRef = useRef(null);
  const [locateNonce, setLocateNonce] = useState(0);
  // 「知道了」后只收起气泡、保留高亮，等用户自己点目标再进入下一步。
  const [quietStepId, setQuietStepId] = useState('');
  // requireInputs：目标里标了 data-onboarding-required 的输入框都填了，才能点「下一步」。
  const [inputsReady, setInputsReady] = useState(true);
  const flow = run ? ONBOARDING_FLOWS[run.flowId] : null;
  // run.steps：选了分支后的实际步骤（见 branches）；没有就用 catalog 的。
  const steps = run?.steps || flow?.steps || [];
  const step = flow ? steps[run.index] : null;
  const autoAdvancedRef = useRef('');
  // 付费功能演示进行中只展示专为演示写的引导（inDemo），其它引导暂停。
  const paused = pausedProp || (demoActive && !flow?.inDemo);

  const end = useCallback((reason) => {
    setRun((current) => {
      if (current) trackFeatureEvent('onboarding', 'flow_end', { flowId: current.flowId, stepIndex: current.index, reason, version: 2 });
      if (current && reason === 'complete') emitComplete(current);
      return null;
    });
  }, []);

  const next = useCallback((branchKey) => {
    setRun((current) => {
      if (!current) return null;
      let steps = current.steps || ONBOARDING_FLOWS[current.flowId]?.steps || [];
      const branch = steps[current.index]?.branches?.[branchKey];
      if (branch) steps = [...steps.slice(0, current.index + 1), ...branch];
      if (current.index + 1 < steps.length) return { ...current, steps, index: current.index + 1 };
      trackFeatureEvent('onboarding', 'flow_end', { flowId: current.flowId, stepIndex: current.index, reason: 'complete', version: 2 });
      emitComplete(current);
      return null;
    });
  }, []);

  useEffect(() => {
    function handleStart(event) {
      const flowId = event?.detail?.flow;
      if (!flowId || !ONBOARDING_FLOWS[flowId]) return;
      trackFeatureEvent('onboarding', 'flow_start', { flowId, version: 2 });
      autoAdvancedRef.current = "";
      setRun({ flowId, index: 0, startedAt: Date.now() });
    }
    window.addEventListener(ONBOARDING_START_EVENT, handleStart);
    return () => window.removeEventListener(ONBOARDING_START_EVENT, handleStart);
  }, []);

  // 找目标：轮询等待懒加载页面 / 弹窗挂载，超时结束（不算完成）。
  useEffect(() => {
    if (!step || paused) return undefined;
    let timer = 0;
    let cancelled = false;
    const startedAt = Date.now();
    const waitMs = step.waitMs || DEFAULT_WAIT_MS;
    function locate() {
      if (cancelled) return;
      const el = findOnboardingTarget(step.target);
      if (el) {
        targetRef.current = el;
        el.setAttribute('data-onboarding-active', 'true');
        const rect = el.getBoundingClientRect();
        if (rect.top < 64 || rect.bottom > window.innerHeight - BOTTOM_NAV_ALLOWANCE) {
          el.scrollIntoView?.({ block: rect.height > window.innerHeight * 0.5 ? 'start' : 'center', behavior: 'smooth' });
        }
        trackFeatureEvent('onboarding', 'step_view', { flowId: run.flowId, stepId: step.id, version: 2 });
        setPlacementBox(el.getBoundingClientRect());
        return;
      }
      // 「保存并连接」这类按钮：渠道已经存好（比如发送测试时一并保存了）就不再显示，算这一步完成。
      if (step.completeWhenGone && Date.now() - startedAt > 800) {
        next();
        return;
      }
      if (Date.now() - startedAt > waitMs) {
        trackFeatureEvent('onboarding', 'target_missing', { flowId: run.flowId, stepId: step.id, version: 2 });
        end('target_missing');
        return;
      }
      timer = window.setTimeout(locate, 250);
    }
    locate();
    return () => {
      cancelled = true;
      window.clearTimeout(timer);
      targetRef.current?.removeAttribute('data-onboarding-active');
      targetRef.current = null;
      setPlacementBox(null);
    };
    // run.flowId 随 step 变化，step 引用来自静态 catalog
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [step, paused, locateNonce, end, next]);

  // 跟随滚动 / 尺寸变化；目标被重新渲染掉时重新定位。
  useEffect(() => {
    if (!step || paused) return undefined;
    let frame = 0;
    const tick = () => {
      const el = targetRef.current;
      if (el && !el.isConnected) {
        setLocateNonce((n) => n + 1);
        return;
      }
      if (el) {
        const rect = el.getBoundingClientRect();
        setPlacementBox((prev) => (prev && Math.abs(prev.top - rect.top) < 1 && Math.abs(prev.left - rect.left) < 1 && Math.abs(prev.height - rect.height) < 1 ? prev : rect));
      }
      const vv = window.visualViewport;
      const kbOpen = Boolean(vv && vv.height < window.innerHeight * 0.75);
      setKeyboardOpen(kbOpen);
      if (step.requireInputs) {
        const required = el ? [...el.querySelectorAll('[data-onboarding-required="true"]')].filter(isVisible) : [];
        const ready = required.length > 0 && required.every((input) => String(input.value || '').trim());
        setInputsReady(ready || required.length === 0);
        // 填好且离开输入框（手机上收起键盘）后自动进入下一步。
        if (ready && step.advanceWhenFilled && !kbOpen && !required.includes(document.activeElement) && autoAdvancedRef.current !== step.id) {
          autoAdvancedRef.current = step.id;
          next();
          return;
        }
      } else {
        setInputsReady(true);
      }
      frame = window.setTimeout(tick, 200);
    };
    frame = window.setTimeout(tick, 200);
    return () => window.clearTimeout(frame);
  }, [step, paused, next]);

  // 用户点了目标本身：原点击照常生效，教程进入下一步。
  useEffect(() => {
    if (!step?.advanceOnClick || paused) return undefined;
    function handleClick(event) {
      if (!event.target?.closest?.(`[data-onboarding="${step.target}"]`)) return;
      const branchKey = event.target.closest('[data-onboarding-branch]')?.getAttribute('data-onboarding-branch') || '';
      window.setTimeout(() => next(branchKey), 0);
    }
    document.addEventListener('click', handleClick, true);
    return () => document.removeEventListener('click', handleClick, true);
  }, [step, paused, next]);

  useEffect(() => {
    if (!run) return undefined;
    function onKey(event) { if (event.key === 'Escape') end('escape'); }
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [run, end]);

  const visible = Boolean(step && placementBox && !paused && !keyboardOpen && quietStepId !== step.id);
  useLayoutEffect(() => {
    setOnboardingHintActive(Boolean(run));
    return () => setOnboardingHintActive(false);
  }, [run]);

  if (!visible || typeof document === 'undefined') return null;
  const pos = computeHintPosition(placementBox, { width: window.innerWidth, height: window.innerHeight }, { placement: step.placement });
  const total = steps.length;
  const style = { left: pos.left, width: pos.width, pointerEvents: 'auto' };
  if (pos.mode === 'above') style.bottom = pos.bottom; else style.top = pos.top;
  const last = run.index + 1 >= total;
  return createPortal(
    <>
      <style>{ACTIVE_STYLE}</style>
      <div
        role="dialog"
        aria-modal="false"
        aria-label={step.title}
        data-onboarding-hint={step.id}
        className="fixed z-[140] rounded-2xl bg-slate-900 px-4 py-3 text-white shadow-[0_14px_30px_-10px_rgba(15,23,42,0.55)]"
        style={style}
        onPointerDown={(event) => event.stopPropagation()}
        onMouseDown={(event) => { event.stopPropagation(); event.preventDefault(); }}
      >
        {pos.arrowLeft != null ? (
          <span
            aria-hidden="true"
            className="absolute h-3.5 w-3.5 rotate-45 bg-slate-900"
            style={pos.mode === 'above' ? { left: pos.arrowLeft, bottom: -6 } : { left: pos.arrowLeft, top: -6 }}
          />
        ) : null}
        <div className="flex items-start justify-between gap-2">
          <div className="text-[11px] font-bold text-indigo-300">{total > 1 ? `第 ${run.index + 1} 步 / 共 ${total} 步` : '新手入门'}</div>
          <button type="button" aria-label="关闭提示" className="-mr-1 -mt-0.5 inline-flex h-6 w-6 items-center justify-center rounded-md text-slate-400 hover:bg-white/10 hover:text-white" onClick={() => end('close')}>
            <X className="h-3.5 w-3.5" aria-hidden="true" />
          </button>
        </div>
        <div className="mt-0.5 text-sm font-extrabold">{step.title}</div>
        <p className="mt-1 text-xs leading-5 text-slate-300">{step.body}</p>
        {step.requireInputs && !inputsReady ? <p className="mt-1 text-[11px] font-semibold text-amber-300">先把输入框填好</p> : null}
        <div className="mt-2.5 flex items-center justify-between">
          <button type="button" className="text-xs text-slate-400 hover:text-slate-200" onClick={() => end('later')}>稍后继续</button>
          <button
            type="button"
            className="rounded-lg bg-indigo-500 px-3 py-1 text-xs font-extrabold hover:bg-indigo-400 disabled:cursor-not-allowed disabled:opacity-40"
            disabled={Boolean(step.requireInputs) && !inputsReady}
            onClick={step.advanceOnClick ? () => setQuietStepId(step.id) : last ? () => end('complete') : () => next()}
          >
            {step.advanceOnClick || last ? '知道了' : '下一步'}
          </button>
        </div>
      </div>
    </>,
    document.body
  );
}
