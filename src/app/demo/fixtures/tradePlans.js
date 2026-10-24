// 交易计划（tradePlans，含 #dca 定投 / #sell 止盈）演示 mock。数据见 ./tradePlansData.js（与持仓、通知演示同一套纳指 QDII ETF）。
// 交易计划页演示期间读取的数据：
//   本地存储（游客与已登录都先读，seed 覆盖）：aiDcaPlanStore / aiDcaPlanState（加仓计划与档位）、aiDcaDcaStore / aiDcaDcaState（定投）、
//     aiDcaSellPlanStore / aiDcaSellPlanDraft（止盈，演示中为空）、aiDcaMarketActionDraft（行情页带来的新建草稿）、
//     aiDcaCalcApply（计算器带入定投参数）、aiDcaNotifyClientConfig（通知渠道 chip，用通知演示的渠道）。
//   接口（游客带占位令牌、已登录带真实令牌，都只命中这里）：
//     GET /api/account/v1/migrations/legacy                       迁移门禁
//     GET /api/account/v1/plans/store | dca/store | sell-plans/store  列表页按子页拉取后「远端优先」合并进本地
//         结构同 account worker resourceResponse；data 取演示覆盖层当前值，合并后不会把演示中的修改改回去
//     GET /api/notify/status?view=summary|details                 通知渠道状态（同通知演示）
//   新建 / 编辑 / 删除只写覆盖层；PUT/DELETE plans/store/items、POST /api/notify/sync、/api/notify/test 由演示框架 403。
// 隔离：真实本地存储与账号 runtime 不被改动；演示中 resourceSync 不自动 push / pull（不触发云同步写回）。
// 保留：演示中新建的加仓 / 定投 / 止盈计划保留 15 分钟；注册 / 升级后按 id 带入 —— 服务端逐条 PUT items（不覆盖账号已有计划），
//   本地已加载账号计划时再按 id 并入本地；示例计划与对示例计划的改动不带入，关联到示例计划的定投 / 止盈去掉关联。
import { putAccountResourceItem } from '../../accountApi.js';
import notifyDemo, {
  NOTIFY_CLIENT_CONFIG_KEY, NOTIFY_STATUS_PATH, buildNotifyDemoEvents, buildNotifyDemoStatusDetails, buildNotifyDemoStatusSummary,
} from './notify.js';
import {
  DCA_STORE_KEY, PLAN_STORE_KEY, SELL_PLAN_STORE_KEY, TRADE_PLANS_DEMO_IDS, tradePlansDemoSeed,
} from './tradePlansData.js';

export const ACCOUNT_API_PREFIX = '/api/account/v1';
// [resource, feature, merge, localStorage key]
export const TRADE_PLAN_RESOURCES = Object.freeze([
  ['plans/store', 'plans', 'planStore', PLAN_STORE_KEY],
  ['dca/store', 'dca', 'dcaStore', DCA_STORE_KEY],
  ['sell-plans/store', 'sell-plans', 'arrayById', SELL_PLAN_STORE_KEY],
]);
const KEEP_KEYS = TRADE_PLAN_RESOURCES.map(([, , , key]) => key);

function parse(raw) {
  try { return JSON.parse(raw ?? 'null'); } catch { return null; }
}

const listOf = (key, value) => (key === SELL_PLAN_STORE_KEY ? value : value?.plans);
const isUserItem = (item) => item && typeof item === 'object' && String(item.id || '').trim() && !TRADE_PLANS_DEMO_IDS.has(String(item.id));

/** 演示中用户新建的计划：{ plans, dcaPlans, sellPlans }；关联到示例（或未保留）加仓计划的定投 / 止盈去掉关联。 */
export function userTradePlanAdditions(read) {
  const pick = (key) => {
    const list = listOf(key, parse(read(key)));
    return (Array.isArray(list) ? list : []).filter(isUserItem);
  };
  const plans = pick(PLAN_STORE_KEY);
  const planIds = new Set(plans.map((plan) => String(plan.id)));
  const unlink = (item) => (item.linkedPlanId && !planIds.has(String(item.linkedPlanId)) ? { ...item, linkedPlanId: '' } : item);
  return { plans, dcaPlans: pick(DCA_STORE_KEY).map(unlink), sellPlans: pick(SELL_PLAN_STORE_KEY).map(unlink) };
}

const hasAdditions = (added) => Boolean(added.plans.length || added.dcaPlans.length || added.sellPlans.length);
const entriesReader = (entries) => { const map = new Map(entries || []); return (key) => (map.has(key) ? map.get(key) : null); };

function resourceRoute(resource, feature, merge, key) {
  return () => {
    const data = parse(globalThis.window?.localStorage?.getItem(key));
    return {
      resource, feature, merge, revision: 3, contentHash: `demo-${feature}`, updatedAt: '2026-10-16T12:20:00.000Z',
      updatedByEndId: 'browser', updatedByEndType: 'PC Web', deleted: false, data,
    };
  };
}

export default {
  keepKeys: KEEP_KEYS,
  seed() {
    const notifySeed = new Map(notifyDemo.seed());
    return [
      ...tradePlansDemoSeed(),
      [NOTIFY_CLIENT_CONFIG_KEY, notifySeed.get(NOTIFY_CLIENT_CONFIG_KEY)],
      ['aiDcaMarketActionDraft', null],
      ['aiDcaCalcApply', null],
    ];
  },
  createFixtures() {
    const startedAt = Date.now();
    const events = buildNotifyDemoEvents(startedAt);
    const routes = {
      [`GET ${ACCOUNT_API_PREFIX}/migrations/legacy`]: () => ({ status: 'no-legacy', legacy: { exists: false }, needsMigration: false }),
      [`GET ${NOTIFY_STATUS_PATH}`]: ({ url }) => (url.searchParams.get('view') === 'details'
        ? buildNotifyDemoStatusDetails(events)
        : buildNotifyDemoStatusSummary(events, startedAt)),
    };
    for (const [resource, feature, merge, key] of TRADE_PLAN_RESOURCES) {
      routes[`GET ${ACCOUNT_API_PREFIX}/${resource}`] = resourceRoute(resource, feature, merge, key);
    }
    return {
      routes,
      // 演示结束时（覆盖层仍在）读出用户新建的计划，升级后逐条写到账号（importState）。
      getState() {
        const added = userTradePlanAdditions((key) => globalThis.window?.localStorage?.getItem(key) ?? null);
        return hasAdditions(added) ? added : null;
      },
    };
  },
  /** 没有新建计划就不保留（只改示例计划不弹「已保留演示内容」）；有则整份保留，再次体验时示例与新建计划都在。 */
  pruneKept(entries) {
    return hasAdditions(userTradePlanAdditions(entriesReader(entries))) ? entries : [];
  },
  /** 本地并入：只在本地已有账号计划（已加载）时按 id 追加，避免只含新增项的 store 被整份推送覆盖云端；服务端由 importState 逐条写入。 */
  prepareImport(entries, { storage } = {}) {
    const added = userTradePlanAdditions(entriesReader(entries));
    const byKey = { [PLAN_STORE_KEY]: added.plans, [DCA_STORE_KEY]: added.dcaPlans, [SELL_PLAN_STORE_KEY]: added.sellPlans };
    return KEEP_KEYS.flatMap((key) => {
      const current = parse(storage?.getItem(key));
      const list = listOf(key, current);
      if (!byKey[key].length || !Array.isArray(list)) return [];
      const ids = new Set(list.map((item) => String(item?.id || '')));
      const additions = byKey[key].filter((item) => !ids.has(String(item.id)));
      if (!additions.length) return [];
      const next = key === SELL_PLAN_STORE_KEY ? [...list, ...additions] : { ...current, plans: [...list, ...additions] };
      return [[key, JSON.stringify(next)]];
    });
  },
  /** 升级后逐条写入账号（PUT items，服务端按 id 合并，不覆盖、不删除已有计划）。 */
  async importState(state) {
    const jobs = [['plans/store', state?.plans], ['dca/store', state?.dcaPlans], ['sell-plans/store', state?.sellPlans]];
    for (const [resource, items] of jobs) {
      for (const item of Array.isArray(items) ? items : []) {
        if (!isUserItem(item)) continue;
        try { await putAccountResourceItem(resource, String(item.id), item); } catch { /* 单条失败不影响其余 */ }
      }
    }
  },
};
