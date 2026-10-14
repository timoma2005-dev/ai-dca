/**
 * 纳指 ETF 套利雷达：时间边界 / 新鲜度 / 数据校验与展示派生的纯函数层。
 *
 * 所有时段判断绑定 Asia/Shanghai（UTC+8），与运行环境时区无关：
 * 输入一律为 epoch 毫秒，用 UTC+8 平移提取日历字段，再以
 * Date.UTC(...) 构造目标时刻，日期进位交给 UTC 日历运算，
 * 覆盖月末、年末与闰日，禁止浏览器本地 setHours。
 */
import {
  isChinaMarketHoliday,
  isTradingDayShanghai,
  isWeekendShanghai,
  getNearestTradingDayShanghai,
  getPreviousTradingDayShanghai
} from './holidaysCN.js';

export const RADAR_PREMIUM_SOURCE = 'eastmoney-fundmobapi-nav';
export const RADAR_TIMEZONE_LABEL = '北京时间（Asia/Shanghai）';

// 计划计算窗口：北京时间 21:35（cron `35 13 * * MON-FRI` 的 UTC 时间）。
export const RADAR_SCHEDULE_HOUR = 21;
export const RADAR_SCHEDULE_MINUTE = 35;
const SCHEDULE_MS_OF_DAY = (RADAR_SCHEDULE_HOUR * 60 + RADAR_SCHEDULE_MINUTE) * 60000;

// 时段边界（秒级，含边界值：09:30:00 属盘中，15:00:00 进入等待，21:35:00 进入计划窗口）。
const SEC_0930 = 9 * 3600 + 30 * 60;
const SEC_1500 = 15 * 3600;
const SEC_2135 = SCHEDULE_MS_OF_DAY / 1000;

export const RADAR_SESSION = Object.freeze({
  PRE_MARKET: 'pre-market',
  INTRADAY_RISK: 'intraday-risk',
  WAIT_NAV: 'wait-nav',
  POST_CLOSE: 'post-close',
  MARKET_CLOSED: 'market-closed',
  CALENDAR_UNCONFIRMED: 'calendar-unconfirmed'
});

export const RADAR_COMPUTE_LEVEL = Object.freeze({
  WAIT: 'wait',
  REGULAR: 'regular',
  RISK: 'risk'
});

const SESSION_META = {
  [RADAR_SESSION.PRE_MARKET]: {
    label: '盘前 · 当日收盘数据未形成',
    shortLabel: '盘前',
    computeLevel: RADAR_COMPUTE_LEVEL.RISK
  },
  [RADAR_SESSION.INTRADAY_RISK]: {
    label: '盘中风险窗口（含午休）',
    shortLabel: '盘中',
    computeLevel: RADAR_COMPUTE_LEVEL.RISK
  },
  [RADAR_SESSION.WAIT_NAV]: {
    label: '收盘后等待净值披露',
    shortLabel: '等待净值',
    computeLevel: RADAR_COMPUTE_LEVEL.WAIT
  },
  [RADAR_SESSION.POST_CLOSE]: {
    label: '已到计划计算窗口 · 净值日期未验证',
    shortLabel: '计划窗口',
    computeLevel: RADAR_COMPUTE_LEVEL.REGULAR
  },
  [RADAR_SESSION.MARKET_CLOSED]: {
    label: '休市 · 无当日交易',
    shortLabel: '休市',
    computeLevel: RADAR_COMPUTE_LEVEL.RISK
  },
  [RADAR_SESSION.CALENDAR_UNCONFIRMED]: {
    label: '交易日历待确认',
    shortLabel: '日历待确认',
    computeLevel: RADAR_COMPUTE_LEVEL.RISK
  }
};

function pad2(value) {
  return String(value).padStart(2, '0');
}

/**
 * 安全数值转换：null / undefined / '' 一律视为缺失（Number(null) === 0 的坑），
 * 缺失返回 fallback，绝不补 0。
 */
function finiteOr(value, fallback = null) {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/** UTC+8 平移后提取上海日历字段（纯函数，不读本地时区）。 */
export function shanghaiDateParts(epochMs) {
  const shifted = new Date(epochMs + 8 * 3600000);
  const year = shifted.getUTCFullYear();
  const month = shifted.getUTCMonth() + 1;
  const day = shifted.getUTCDate();
  return {
    year,
    month,
    day,
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    second: shifted.getUTCSeconds(),
    millisecond: shifted.getUTCMilliseconds(),
    dateStr: `${year}-${pad2(month)}-${pad2(day)}`,
    secondOfDay:
      shifted.getUTCHours() * 3600 + shifted.getUTCMinutes() * 60 + shifted.getUTCSeconds()
  };
}

/** 上海时区日期串 YYYY-MM-DD。 */
export function shanghaiDateStr(epochMs) {
  return shanghaiDateParts(epochMs).dateStr;
}

/** 上海时区 HH:mm:ss。 */
export function shanghaiTimeStr(epochMs) {
  const p = shanghaiDateParts(epochMs);
  return `${pad2(p.hour)}:${pad2(p.minute)}:${pad2(p.second)}`;
}

/**
 * holidaysCN.js 未导出年份表；用每年必休的元旦探测该年份假期表是否已收录。
 * 缺失年份不得视为已确认交易日（plan §3.1）。
 */
function isCalendarYearKnown(year) {
  return isChinaMarketHoliday(`${year}-01-01`);
}

/**
 * 时段分级（plan §3.1 时段表）。
 * 返回 key / label / shortLabel / computeLevel / dateStr / tradingDay / calendarConfirmed。
 */
export function radarSession(epochMs) {
  const parts = shanghaiDateParts(epochMs);
  const dateStr = parts.dateStr;
  const calendarConfirmed = isCalendarYearKnown(parts.year);
  const weekend = isWeekendShanghai(dateStr);

  let key;
  if (weekend) {
    key = RADAR_SESSION.MARKET_CLOSED;
  } else if (!calendarConfirmed) {
    key = RADAR_SESSION.CALENDAR_UNCONFIRMED;
  } else if (isChinaMarketHoliday(dateStr)) {
    key = RADAR_SESSION.MARKET_CLOSED;
  } else if (parts.secondOfDay < SEC_0930) {
    key = RADAR_SESSION.PRE_MARKET;
  } else if (parts.secondOfDay < SEC_1500) {
    key = RADAR_SESSION.INTRADAY_RISK;
  } else if (parts.secondOfDay < SEC_2135) {
    key = RADAR_SESSION.WAIT_NAV;
  } else {
    key = RADAR_SESSION.POST_CLOSE;
  }

  const meta = SESSION_META[key];
  return {
    key,
    dateStr,
    label: meta.label,
    shortLabel: meta.shortLabel,
    computeLevel: meta.computeLevel,
    tradingDay: key === RADAR_SESSION.PRE_MARKET
      || key === RADAR_SESSION.INTRADAY_RISK
      || key === RADAR_SESSION.WAIT_NAV
      || key === RADAR_SESSION.POST_CLOSE,
    calendarConfirmed,
    secondOfDay: parts.secondOfDay
  };
}

/** 上海某自然日 21:35:00.000 的 epoch（用 UTC 日历构造，进位安全）。 */
function scheduleEpochFor(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  return Date.UTC(y, m - 1, d, RADAR_SCHEDULE_HOUR, RADAR_SCHEDULE_MINUTE, 0, 0) - 8 * 3600000;
}

function nextNaturalDay(dateStr) {
  const [y, m, d] = String(dateStr).split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d + 1));
  return `${dt.getUTCFullYear()}-${pad2(dt.getUTCMonth() + 1)}-${pad2(dt.getUTCDate())}`;
}

/**
 * 下一次计划计算目标（plan §3.2）：当天 21:35:00.000；已过则次日自然日 21:35。
 * 倒计时目标使用自然日，不改成下一交易日；日期进位交给 UTC 日历运算。
 */
export function nextScheduledCompute(epochMs) {
  const { dateStr } = shanghaiDateParts(epochMs);
  const todayTarget = scheduleEpochFor(dateStr);
  if (epochMs < todayTarget) {
    return { target: todayTarget, dateStr, isToday: true, maySkip: !isTradingDayShanghai(dateStr) };
  }
  const nextDateStr = nextNaturalDay(dateStr);
  return {
    target: scheduleEpochFor(nextDateStr),
    dateStr: nextDateStr,
    isToday: false,
    maySkip: !isTradingDayShanghai(nextDateStr) || !isCalendarYearKnown(Number(nextDateStr.slice(0, 4)))
  };
}

/** 距目标秒数：floor(max(0, target - now) / 1000)，每秒由最新 now 重算。 */
export function countdownSeconds(epochMs) {
  const { target } = nextScheduledCompute(epochMs);
  return Math.floor(Math.max(0, target - epochMs) / 1000);
}

/** HH:mm:ss（支持 24:00:00 这一精确到达值）。 */
export function formatCountdown(totalSeconds) {
  const s = Math.max(0, Math.floor(totalSeconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(sec)}`;
}

/** 倒计时完整展示信息（标签附日期与时区，目标日非交易日附提示）。 */
export function countdownView(epochMs) {
  const schedule = nextScheduledCompute(epochMs);
  return {
    ...schedule,
    seconds: countdownSeconds(epochMs),
    text: formatCountdown(countdownSeconds(epochMs)),
    label: `距${schedule.isToday ? '今日' : '明日'} 21:35 计划触发`,
    timezone: RADAR_TIMEZONE_LABEL
  };
}

/**
 * 预期快照日（plan §3.2.5，本地交易日历推导）：
 * 交易日 21:35 前预期上一交易日，之后预期当天；休市日预期最近交易日。
 * 日历未确认的工作日按交易日尽力推导，界面另行提示“交易日历待确认”。
 */
export function expectedSnapshotDate(epochMs) {
  const session = radarSession(epochMs);
  if (!session.tradingDay) return getNearestTradingDayShanghai(session.dateStr);
  const schedule = nextScheduledCompute(epochMs);
  return schedule.isToday ? getPreviousTradingDayShanghai(session.dateStr) : session.dateStr;
}

export const RADAR_FRESHNESS = Object.freeze({
  UNKNOWN: 'unknown',
  OK: 'ok',
  STALE: 'stale',
  ANOMALY: 'anomaly'
});

function isValidDateStr(value) {
  return /^\d{4}-\d{2}-\d{2}$/.test(String(value || ''));
}

/**
 * 新鲜度结论（plan §3.2.5）：只使用 data.date 与 computedAt，
 * 不用浏览器今天伪造基准。缺日期 → 基准日期未知；畸形或未来日期 → 日期异常；
 * 落后预期 → 待更新。旧数据读取成功不会自动变“新鲜”。
 */
export function snapshotFreshness(data, epochMs) {
  const dateStr = data?.date;
  if (!dateStr) return { status: RADAR_FRESHNESS.UNKNOWN, expectedDate: null, label: '基准日期未知' };
  if (!isValidDateStr(dateStr)) return { status: RADAR_FRESHNESS.ANOMALY, expectedDate: null, label: '日期异常' };
  const expected = expectedSnapshotDate(epochMs);
  if (dateStr > expected) return { status: RADAR_FRESHNESS.ANOMALY, expectedDate: expected, label: '日期异常' };
  if (dateStr < expected) return { status: RADAR_FRESHNESS.STALE, expectedDate: expected, label: '待更新' };
  return { status: RADAR_FRESHNESS.OK, expectedDate: expected, label: '已到预期基准日' };
}

/** 解析 computedAt 为 epoch；无法解析返回 null（界面显示 —）。 */
export function computedAtEpoch(data) {
  const raw = data?.computedAt;
  if (typeof raw !== 'string' || !raw) return null;
  const t = Date.parse(raw);
  return Number.isFinite(t) ? t : null;
}

/**
 * 盘前/盘中计算的 computedAt 风险提示（plan §3.2.5）：
 * 若可辨识则附提示；不据此认证数据来源或完整性。
 */
export function computedAtRiskNote(data) {
  const t = computedAtEpoch(data);
  if (t == null) return '';
  const session = radarSession(t);
  if (session.key === RADAR_SESSION.PRE_MARKET) return '该快照的计算时间处于盘前时段，当日收盘数据尚未形成，溢价参考价值存疑';
  if (session.key === RADAR_SESSION.INTRADAY_RISK) return '该快照的计算时间处于盘中时段，净值与现价可能错配，溢价参考价值存疑';
  return '';
}

/**
 * 快照校验（plan §5.2）：premiumSource 必须为 eastmoney-fundmobapi-nav；
 * etfs 集合内至少一只具备有效溢价；缺失可选字段（date/computedAt/bestPair/
 * maturity/recentOpportunities）局部降级，不因此判定整体失败。
 */
export function validRadarEtfs(data) {
  if (!Array.isArray(data?.etfs)) return [];
  return data.etfs.filter(
    (etf) => etf && typeof etf.code === 'string' && etf.code.trim() !== '' && finiteOr(etf.premium) != null
  );
}

export function validateRadarSnapshot(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) return false;
  if (data.premiumSource !== RADAR_PREMIUM_SOURCE) return false;
  return validRadarEtfs(data).length > 0;
}

/**
 * 排行（plan §4）：只用后端返回的有效标的；按溢价降序、并列按代码稳定排序；
 * 最高/最低仅在有效集合内选择。单标的（或全部无效）不产生套利对。
 */
export function rankRadarEtfs(data) {
  return validRadarEtfs(data)
    .map((etf) => ({ code: etf.code, name: typeof etf.name === 'string' ? etf.name : '', premium: Number(etf.premium) }))
    .sort((a, b) => (a.premium !== b.premium ? b.premium - a.premium : a.code.localeCompare(b.code)));
}

export function lowestPremiumEtf(data) {
  const ranked = rankRadarEtfs(data);
  return ranked.length ? ranked[ranked.length - 1] : null;
}

export function highestPremiumEtf(data) {
  const ranked = rankRadarEtfs(data);
  return ranked.length ? ranked[0] : null;
}

/**
 * 候选对：在有效集合内取最高/最低；不足两只返回 null。
 * 与 bestPair 独立：bestPair 缺失（partial）时候选标识仍可展示。
 */
export function candidatePair(data) {
  const ranked = rankRadarEtfs(data);
  if (ranked.length < 2) return null;
  return { sell: ranked[0], buy: ranked[ranked.length - 1] };
}

/** bestPair 局部校验：结构完整且数值有限才展示 Hero；缺失字段一律为 null，不补 0。 */
export function validBestPair(data) {
  const pair = data?.bestPair;
  if (!pair || typeof pair !== 'object') return null;
  const sell = pair.sell;
  const buy = pair.buy;
  if (!sell?.code || !buy?.code) return null;
  const sellPremium = finiteOr(sell.premium);
  const buyPremium = finiteOr(buy.premium);
  const spread = finiteOr(pair.spread);
  if (sellPremium == null || buyPremium == null || spread == null) return null;
  return {
    sell: { code: String(sell.code), name: typeof sell.name === 'string' ? sell.name : '', premium: sellPremium },
    buy: { code: String(buy.code), name: typeof buy.name === 'string' ? buy.name : '', premium: buyPremium },
    spread,
    percentile: finiteOr(pair.percentile),
    historyDays: finiteOr(pair.historyDays)
  };
}

/** 分位展示门槛（plan §4）：沿用 historyDays >= 5；缺失不是 0 分位。 */
export function percentileView(data) {
  const pair = validBestPair(data);
  if (!pair) return { visible: false, percentile: null, historyDays: null, attention: false };
  const historyDays = pair.historyDays;
  const visible = historyDays != null && historyDays >= 5;
  const percentile = visible ? pair.percentile : null;
  return {
    visible,
    percentile,
    historyDays,
    maxHistoryDays: 20,
    attention: visible && percentile != null && percentile >= 85
  };
}

/**
 * 轮动建议（plan §4）：差价来自当前快照 premium；
 * 点击最低者显示无需切换；文案为“当前有效标的中最低溢价”；
 * 溢价差单位为百分点，未计交易成本。
 */
export function rotationAdvice(data, selectedCode) {
  if (!selectedCode) return null;
  const ranked = rankRadarEtfs(data);
  const selected = ranked.find((etf) => etf.code === selectedCode);
  if (!selected) return null;
  const lowest = ranked[ranked.length - 1];
  if (ranked.length < 2 || selected.code === lowest.code) {
    return {
      isLowest: true,
      selected,
      lowest,
      spreadPoints: 0,
      note: `已是当前有效标的中最低溢价（${selected.premium.toFixed(2)}%），无需切换`
    };
  }
  return {
    isLowest: false,
    selected,
    lowest,
    spreadPoints: +(selected.premium - lowest.premium).toFixed(2),
    note: '溢价差（百分点），未计交易成本'
  };
}

/** 数据成熟度安全读取（plan §4）：只强调历史覆盖与已具备的权重组，不新增已评分承诺。 */
export function maturityView(data) {
  const maturity = data?.maturity;
  if (!maturity || typeof maturity !== 'object') return null;
  const groupsRaw = maturity.enabledWeights && typeof maturity.enabledWeights === 'object' ? maturity.enabledWeights : {};
  const toList = (value) => (Array.isArray(value) ? value.filter((item) => typeof item === 'string' && item) : []);
  const groups = [
    { key: 'base', label: '基础（第 1 天起）', items: toList(groupsRaw.base), enabled: true },
    { key: 'premiumStats20', label: '溢价统计（20 天起）', items: toList(groupsRaw.premiumStats20), enabled: true },
    { key: 'liquidityStats30', label: '流动性稳定性（30 天起）', items: toList(groupsRaw.liquidityStats30), enabled: true }
  ];
  const enabledCount = groups.reduce((sum, group) => sum + (group.items.length ? 1 : 0), 0);
  return {
    days: finiteOr(maturity.days),
    label: typeof maturity.label === 'string' ? maturity.label : '',
    dots: typeof maturity.dots === 'string' ? maturity.dots : '',
    level: finiteOr(maturity.level),
    groups,
    enabledCount
  };
}

/** 近期机会安全读取：无效条目局部降级为 null，不发额外请求。 */
export function recentOpportunities(data) {
  if (!Array.isArray(data?.recentOpportunities)) return [];
  return data.recentOpportunities
    .filter((item) => item && typeof item === 'object' && isValidDateStr(item.date))
    .map((item) => ({
      date: String(item.date),
      pair: typeof item.pair === 'string' ? item.pair : '—',
      spread: finiteOr(item.spread)
    }));
}

/** 四阶段预期流水线（plan §4）：时间只决定“预期阶段”，不显示已运行/已入库实况。 */
export const RADAR_PIPELINE_STAGES = Object.freeze([
  { key: 'close', time: '15:00', title: '场内交易收盘', desc: '沪深交易所收盘，锁定当日场内收盘价。' },
  { key: 'nav', time: '21:00 ~ 21:30', title: '净值通常披露', desc: '各基金公司完成清算后发布当日单位净值，披露时间可能延迟。' },
  { key: 'cron', time: '21:35', title: '计划触发', desc: '工作日 21:35 定时触发计算；节假日可能跳过。' },
  { key: 'done', time: '约 21:36', title: '预期完成', desc: '矩阵溢价扫描、最优价差对计算并写入正式快照与历史。' }
]);

/**
 * 当前时间对应的“预期阶段”索引：0=等待收盘，1=收盘后待净值，
 * 2=净值披露窗口，3=计划触发窗口，4=预期完成之后。
 */
export function expectedPipelineStage(epochMs) {
  const { secondOfDay } = shanghaiDateParts(epochMs);
  if (secondOfDay < SEC_1500) return 0;
  if (secondOfDay < 21 * 3600) return 1;
  if (secondOfDay < SEC_2135) return 2;
  if (secondOfDay < SEC_2135 + 60) return 3;
  return 4;
}
