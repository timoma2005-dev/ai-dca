// 步骤提示气泡的定位（纯函数，便于测试）。

const GUTTER = 12;
const HINT_MAX_WIDTH = 300;
export const BOTTOM_NAV_ALLOWANCE = 76;

/**
 * 计算气泡位置。默认放在目标下方；下方空间不足（含手机底部导航）或指定 placement=top 时放上方；
 * 目标比半屏还高时贴在目标顶部内侧。
 */
export function computeHintPosition(rect, viewport, { placement = 'bottom', estimatedHeight = 170 } = {}) {
  const vw = Number(viewport?.width) || 0;
  const vh = Number(viewport?.height) || 0;
  const width = Math.max(200, Math.min(HINT_MAX_WIDTH, vw - GUTTER * 2));
  const centerX = rect.left + rect.width / 2;
  const left = Math.round(Math.min(Math.max(GUTTER, centerX - width / 2), Math.max(GUTTER, vw - width - GUTTER)));
  const arrowLeft = Math.round(Math.min(Math.max(16, centerX - left - 7), width - 30));
  if (rect.height > vh * 0.5) {
    return { mode: 'inside', top: Math.round(Math.max(rect.top + GUTTER, 72)), left, width, arrowLeft: null };
  }
  const spaceBelow = vh - rect.bottom - BOTTOM_NAV_ALLOWANCE;
  const spaceAbove = rect.top - 64;
  const wantTop = placement === 'top' ? spaceAbove >= estimatedHeight || spaceAbove > spaceBelow : spaceBelow < estimatedHeight && spaceAbove > spaceBelow;
  if (wantTop) {
    return { mode: 'above', bottom: Math.round(vh - rect.top + 12), left, width, arrowLeft };
  }
  return { mode: 'below', top: Math.round(rect.bottom + 12), left, width, arrowLeft };
}
