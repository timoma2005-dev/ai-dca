// 新手入门任务与步骤提示定义。stepId / taskId 保持稳定，调整文案不会让已保存的进度错位。

export const GUEST_TASKS = [
  {
    id: 'register',
    title: '注册账号，领 3 个月 VIP',
    description: '溢价拉开时推送换基信号，近 6 周已推送 9,000+ 条',
    cta: '去注册',
    action: 'register'
  },
  {
    id: 'demo',
    title: '先看看能做什么',
    description: '用示例数据看看切换方案怎么提醒，不会保存',
    cta: '体验',
    badge: '无需注册',
    badgeTone: 'muted',
    action: 'demo',
    tab: 'fundSwitch'
  }
];

// 核心价值是「溢价拉开时把换基信号推到手机」：切换方案 + 通知两步都完成才算用起来。
// 持仓是配角（自动算每一轮换基赚了多少），可选，不计入进度。
export const USER_TASKS = [
  {
    id: 'switch',
    title: '设一个切换方案',
    description: '填你现在持有的基金代码，自动生成方案和阈值',
    doneDescription: '已保存切换方案',
    cta: '去设置',
    badge: 'VIP',
    badgeTone: 'vip',
    tab: 'fundSwitch',
    flow: 'switch',
    activation: true
  },
  {
    id: 'notify',
    title: '接通手机通知',
    description: 'Bark / Server酱³ / 邮件选一种，发条测试确认能收到',
    doneDescription: '通知通道已接通',
    cta: '去接通',
    badge: 'VIP',
    badgeTone: 'vip',
    tab: 'notify',
    flow: 'notify',
    activation: true
  },
  {
    id: 'holdings',
    title: '录入持仓',
    description: '自动算出每一轮换基赚了多少',
    doneDescription: '已录入持仓',
    cta: '去录入',
    badge: '可选',
    badgeTone: 'muted',
    tab: 'holdings',
    flow: 'holdings',
    optional: true
  }
];

// 每个步骤指向一个 data-onboarding 目标；advanceOnClick 表示用户点了目标即进入下一步。
// 步骤只做讲解，从不替用户保存、生成或发送任何东西。
export const ONBOARDING_FLOWS = {
  holdings: {
    task: 'holdings',
    steps: [
      {
        id: 'holdings.create',
        target: 'holding-create',
        title: '从这里录入第一笔交易',
        body: '填写基金代码、份额、成本和日期即可；也可以用截图导入，识别结果核对无误后再保存。',
        advanceOnClick: true
      }
    ]
  },
  switch: {
    task: 'switch',
    steps: [
      {
        id: 'switch.create',
        target: 'switch-create',
        title: '点「新建方案」',
        body: '方案就是一组跟踪同一指数的基金。溢价差够大时会提醒你从贵的换到便宜的。',
        advanceOnClick: true
      },
      {
        id: 'switch.autofill',
        target: 'switch-autofill',
        title: '用「自动填充」省掉手填',
        body: '填你现在持有的场内基金代码和佣金（万分之几），会自动匹配候选基金并算出切换阈值。',
        advanceOnClick: true,
        waitMs: 20000
      },
      {
        id: 'switch.save',
        target: 'switch-save',
        title: '核对后再保存',
        body: '看一下 H/L 两组基金和阈值是否合理，确认无误再点「保存方案」。自动生成的结果不会自动保存。',
        waitMs: 30000
      }
    ]
  },
  notify: {
    task: 'notify',
    steps: [
      {
        id: 'notify.channel',
        target: 'notify-channel',
        title: '选一种通知方式',
        body: 'iPhone 用 Bark，Android 用 Server酱³，也可以绑定邮箱。配好后点「发送测试」，手机收到了才算接通，之后换基信号就推到这里。',
        placement: 'top'
      }
    ]
  },
  watchlist: {
    task: 'watchlist',
    steps: [
      {
        id: 'watchlist.search',
        target: 'market-search',
        title: '搜索并加入自选',
        body: '输入基金代码或名称，在结果里点「加入自选」，以后就能在这里一眼看到它的价格和溢价。',
        advanceOnClick: true
      }
    ]
  }
};

/**
 * 根据身份、真实数据信号和权限生成任务卡内容。
 * @param {object} input
 * @param {boolean} input.loggedIn
 * @param {{holdings?:boolean, switch?:boolean, notify?:boolean}} input.signals
 * @param {{done?:object, seenDemo?:boolean}} input.state
 * @param {(tab:string)=>{status:string}} [input.accessOf] 返回 ok / login / forbidden
 */
export function buildOnboardingTasks({ loggedIn, signals = {}, state = {}, accessOf } = {}) {
  const done = state.done || {};
  if (!loggedIn) {
    const items = GUEST_TASKS.map((task) => ({
      ...task,
      status: task.id === 'demo' && state.seenDemo ? 'seen' : 'todo'
    }));
    return { mode: 'guest', items, doneCount: 0, total: items.length, allDone: false, activated: false };
  }
  const items = USER_TASKS.map((task) => {
    const isDone = Boolean(signals[task.id]) || Boolean(done[task.id]);
    if (isDone) return { ...task, status: 'done' };
    const access = typeof accessOf === 'function' ? accessOf(task.tab) : { status: 'ok' };
    if (access?.status === 'forbidden') return { ...task, status: 'locked' };
    return { ...task, status: 'todo' };
  });
  const required = items.filter((item) => !item.optional);
  const doneCount = required.filter((item) => item.status === 'done').length;
  const activationItems = items.filter((item) => item.activation);
  return {
    mode: 'user',
    items,
    doneCount,
    total: required.length,
    allDone: required.every((item) => item.status === 'done'),
    activated: activationItems.length > 0 && activationItems.every((item) => item.status === 'done')
  };
}

/** 任务卡是否应该出现在首页。 */
export function shouldShowGettingStarted({ tasks, state = {}, demoActive = false } = {}) {
  if (demoActive || !tasks) return false;
  if (state.dismissed) return false;
  if (tasks.allDone && state.celebrated) return false;
  return true;
}
