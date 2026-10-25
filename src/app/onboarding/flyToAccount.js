// 新手入门全部完成后：一枚「新手入门」小标签从任务卡飞向右上角账户按钮，告诉用户随时能在那里再看。
// 纯 DOM 实现（任务卡收起后会卸载，动画不能依赖它）。

export const FLY_HINT_TEXT = '新手入门随时可以在个人中心再看';

function visibleTarget(root) {
  const nodes = root.querySelectorAll('[data-account-trigger]');
  for (const node of nodes) {
    const rect = node.getBoundingClientRect();
    if (rect.width > 0 && rect.height > 0 && node.getClientRects().length) return node;
  }
  return null;
}

function showHint(doc, rect, text) {
  const tip = doc.createElement('div');
  tip.setAttribute('role', 'status');
  tip.setAttribute('data-onboarding-fly-hint', 'true');
  tip.textContent = text;
  const right = Math.max(8, doc.documentElement.clientWidth - rect.right - 4);
  tip.style.cssText = `position:fixed;z-index:160;top:${rect.bottom + 10}px;right:${right}px;max-width:240px;padding:8px 12px;border-radius:12px;background:#0f172a;color:#fff;font-size:12px;font-weight:700;line-height:1.5;box-shadow:0 12px 28px -10px rgba(15,23,42,.55);opacity:0;transform:translateY(-4px);transition:opacity .2s,transform .2s`;
  doc.body.appendChild(tip);
  requestAnimationFrame(() => { tip.style.opacity = '1'; tip.style.transform = 'none'; });
  const remove = () => { tip.style.opacity = '0'; window.setTimeout(() => tip.remove(), 250); };
  const timer = window.setTimeout(remove, 3800);
  tip.addEventListener('click', () => { window.clearTimeout(timer); remove(); });
}

/** fromRect：起点（任务卡）位置。返回 true 表示找到了账户按钮。 */
export function flyToAccount({ fromRect, label = '新手入门', hint = FLY_HINT_TEXT, doc = typeof document !== 'undefined' ? document : null } = {}) {
  if (!doc || !fromRect) return false;
  const target = visibleTarget(doc);
  if (!target) return false;
  const to = target.getBoundingClientRect();
  const reduce = typeof window.matchMedia === 'function' && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  const pulse = () => {
    target.animate?.([
      { transform: 'scale(1)', boxShadow: '0 0 0 0 rgba(99,102,241,.55)' },
      { transform: 'scale(1.18)', boxShadow: '0 0 0 10px rgba(99,102,241,0)' },
      { transform: 'scale(1)', boxShadow: '0 0 0 0 rgba(99,102,241,0)' }
    ], { duration: 650, iterations: 2 });
    showHint(doc, target.getBoundingClientRect(), hint);
  };
  if (reduce || typeof Element === 'undefined' || !Element.prototype.animate) { pulse(); return true; }
  const chip = doc.createElement('div');
  chip.setAttribute('aria-hidden', 'true');
  chip.setAttribute('data-onboarding-fly', 'true');
  chip.textContent = `🎓 ${label}`;
  chip.style.cssText = 'position:fixed;z-index:161;left:0;top:0;padding:8px 14px;border-radius:999px;background:#4f46e5;color:#fff;font-size:13px;font-weight:800;white-space:nowrap;box-shadow:0 12px 30px -8px rgba(79,70,229,.6);pointer-events:none;will-change:transform,opacity';
  doc.body.appendChild(chip);
  const w = chip.offsetWidth || 110;
  const h = chip.offsetHeight || 34;
  const sx = fromRect.left + fromRect.width / 2 - w / 2;
  const sy = fromRect.top + Math.min(fromRect.height / 2, 120) - h / 2;
  const ex = to.left + to.width / 2 - w / 2;
  const ey = to.top + to.height / 2 - h / 2;
  // 抛物线：先往上抬一点再飞过去
  const mx = sx + (ex - sx) * 0.45;
  const my = Math.min(sy, ey) - 60;
  const anim = chip.animate([
    { transform: `translate(${sx}px,${sy}px) scale(.6)`, opacity: 0 },
    { transform: `translate(${sx}px,${sy - 12}px) scale(1.08)`, opacity: 1, offset: 0.18 },
    { transform: `translate(${mx}px,${my}px) scale(.9)`, opacity: 1, offset: 0.6 },
    { transform: `translate(${ex}px,${ey}px) scale(.18)`, opacity: 0.2 }
  ], { duration: 1100, easing: 'cubic-bezier(.45,0,.25,1)', fill: 'forwards' });
  anim.onfinish = () => { chip.remove(); pulse(); };
  return true;
}
