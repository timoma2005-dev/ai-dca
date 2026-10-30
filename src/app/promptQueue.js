// 自动弹出的提示（站点切换、注册引导、分享提醒条、新手提示…）排队：同一时刻只出现一个。
// 规则：
//  · 页面上已有对话框（用户自己打开的登录框、确认框等）时，自动提示一律等待；
//  · 多个自动提示同时想出现时按 priority 从高到低依次出现，前一个关闭后隔一小段再出下一个；
//  · yieldable 的提示（底部提醒条这种非模态条）在更高优先级的提示到来时先让位，之后再回来。
import { useEffect, useState } from 'react';

const GAP_MS = 600;
const waiting = new Map(); // id -> { priority, yieldable }
const listeners = new Set();
let holder = null;
let timer = null;
let observer = null;

function emit() { listeners.forEach((fn) => { try { fn(); } catch { /* ignore */ } }); }

function dialogOpen() {
  if (typeof document === 'undefined') return false;
  const nodes = document.querySelectorAll('[role="dialog"],[role="alertdialog"]');
  for (const el of nodes) {
    if (holder && el.closest(`[data-auto-prompt="${holder}"]`)) continue;
    if (el.getAttribute('aria-hidden') === 'true' || el.hidden) continue;
    const st = window.getComputedStyle(el);
    if (st.display === 'none' || st.visibility === 'hidden') continue;
    return true;
  }
  return false;
}

function best() {
  let top = null;
  for (const [id, it] of waiting) {
    if (id === holder) continue;
    if (!top || it.priority > top.priority) top = { id, ...it };
  }
  return top;
}

function pump() {
  timer = null;
  const next = best();
  if (holder) {
    const cur = waiting.get(holder);
    // 非模态条让位给更高优先级的提示
    if (cur?.yieldable && next && next.priority > cur.priority) { holder = null; emit(); schedule(GAP_MS); }
    return;
  }
  if (!next) return;
  if (dialogOpen()) { schedule(800); return; }
  holder = next.id;
  emit();
}

function schedule(ms = 0) {
  if (timer) clearTimeout(timer);
  timer = setTimeout(pump, ms);
}

function ensureObserver() {
  if (observer || typeof MutationObserver === 'undefined' || typeof document === 'undefined') return;
  observer = new MutationObserver(() => { if (!holder && waiting.size) schedule(GAP_MS); });
  observer.observe(document.body, { childList: true, subtree: true });
}

export function requestAutoPrompt(id, { priority = 50, yieldable = false } = {}) {
  waiting.set(id, { priority, yieldable });
  ensureObserver();
  schedule(holder ? 0 : 300);
}

export function releaseAutoPrompt(id) {
  waiting.delete(id);
  if (holder === id) { holder = null; emit(); schedule(GAP_MS); }
}

export function isAutoPromptBusy() { return Boolean(holder); }

/** 想显示时调用，返回现在能否显示。want 变 false 或卸载时自动让出。 */
export function useAutoPromptSlot(id, want, { priority = 50, yieldable = false } = {}) {
  const [granted, setGranted] = useState(false);
  useEffect(() => {
    if (!want) { releaseAutoPrompt(id); setGranted(false); return undefined; }
    const sync = () => setGranted(holder === id);
    listeners.add(sync);
    requestAutoPrompt(id, { priority, yieldable });
    sync();
    return () => { listeners.delete(sync); releaseAutoPrompt(id); };
  }, [id, want, priority, yieldable]);
  return granted;
}

/** 有自动提示正在显示（供新手提示等暂停用）。 */
export function useAutoPromptBusy(selfId = '') {
  const [busy, setBusy] = useState(() => Boolean(holder && holder !== selfId));
  useEffect(() => {
    const sync = () => setBusy(Boolean(holder && holder !== selfId));
    listeners.add(sync);
    sync();
    return () => { listeners.delete(sync); };
  }, [selfId]);
  return busy;
}
