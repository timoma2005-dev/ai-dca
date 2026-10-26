// 演示次数文案：次数按功能分别计数（featureDemo.consumeDemoQuota 以 tab 为 key），
// 所以文案必须写明「本功能」，避免行情（剩 2 次）与竞价看板（剩 3 次）看起来自相矛盾。
import { DEMO_RUNS_PER_DAY } from './featureDemo.js';

export function demoQuotaText(demo) {
  if (!demo || demo.unlimited) return '';
  const perDay = Number.isFinite(demo.perDay) ? demo.perDay : DEMO_RUNS_PER_DAY;
  if (demo.remaining > 0) return `本功能今日还可体验 ${demo.remaining} 次（每个功能每天 ${perDay} 次）`;
  return `本功能今日体验次数已用完（每个功能每天 ${perDay} 次）`;
}
