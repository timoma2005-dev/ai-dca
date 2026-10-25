// 新手入门任务与步骤提示定义。stepId / taskId 保持稳定，调整文案不会让已保存的进度错位。

export const GUEST_TASKS = [
  {
    id: 'register',
    title: '注册账号，领 3 个月 VIP',
    description: '行情、基金切换提醒、通知全部解锁',
    cta: '去注册',
    action: 'register'
  },
  {
    id: 'demo',
    title: '先看看能做什么',
    description: '用示例数据体验切换提醒，不会保存',
    cta: '体验',
    badge: '无需注册',
    badgeTone: 'muted',
    action: 'demo',
    tab: 'fundSwitch'
  }
];

export const USER_TASKS = [
  {
    id: 'holdings',
    title: '录入我的持仓',
    description: '手动录入或上传截图识别，约 1 分钟',
    doneDescription: '已录入持仓',
    cta: '去录入',
    tab: 'holdings',
    flow: 'holdings',
    activation: true
  },
  {
    id: 'switch',
    title: '设置切换提醒',
    description: '溢价拉开时提醒你换到更划算的那只',
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
    description: 'Bark / Android / 邮件，选一种并发送测试',
    doneDescription: '通知通道已接通',
    cta: '去接通',
    tab: 'notify',
    flow: 'notify'
  },
  {
    id: 'watchlist',
    title: '加一只自选',
    description: '在行情里关注你常看的基金',
    doneDescription: '已添加自选',
    cta: '去添加',
    badge: '可选',
    badgeTone: 'muted',
    tab: 'markets',
    flow: 'watchlist',
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
        body: 'iPhone 用 Bark，Android 用 Server酱³，也可以绑定邮箱。配好后点「发送测试」确认能收到。',
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
  const doneCount = items.filter((item) => item.status === 'done').length;
  return {
    mode: 'user',
    items,
    doneCount,
    total: items.length,
    allDone: required.every((item) => item.status === 'done'),
    activated: items.some((item) => item.activation && item.status === 'done')
  };
}

/** 任务卡是否应该出现在首页。 */
export function shouldShowGettingStarted({ tasks, state = {}, demoActive = false } = {}) {
  if (demoActive || !tasks) return false;
  if (state.dismissed) return false;
  if (tasks.allDone && state.celebrated) return false;
  return true;
}
