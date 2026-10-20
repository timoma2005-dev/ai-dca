# 移动端「更多」弹窗与顶栏按钮修复计划

## 背景与目标

- 分支：`cn`；问题引入提交：`76f4d8d8`；用户反馈日期：2026-10-20。
- 保留方案 A 垂直列表，使「更多」能够稳定打开、关闭及选择页面。
- 恢复顶栏 `UserRound` 账号按钮（`aria-label="账户"`），移除打开侧边栏的汉堡按钮（`aria-label="打开导航"`）。
- 顶栏与「更多」账号入口共用 WorkspacePage 的受控 AccountMenu 单实例。
- 本文仅制定实现计划；不代表代码已修复、已部署或线上已验收。行号以编写本文时的工作区为准，实施时以函数和代码锚点定位。

## 已确认的根因与修复边界

### Bug 1：打开后闪烁、无法保持展开

`MobileBottomNav` 将 `moreOpen` 设为 true 后，其第 98–104 行 effect 调用 `setMobileBottomSheetOpen('mobile-nav-more', true)`。WorkspacePage 接收事件并设置 `mobileBottomSheetHidden`，再经 `hidden` prop 传回导航。导航第 106 行返回 null，导航和弹窗 DOM 一起消失；第 81–83 行 hidden effect 又将 moreOpen 设为 false，触发注册 effect 的 cleanup，恢复导航，形成自关闭反馈环。

严格说，`return null` 隐去渲染子树，并不直接卸载 MobileBottomNav 自身；本次修复针对已确认的事件与 hidden 状态反馈链，不依赖“组件自身一定卸载”的解释。

「更多」是锚定底部导航上方的小 popover，应删除它对全局 bottom sheet 隐藏机制的注册。此处按用户明确要求处理；AGENTS.md 中真正从底部展开的 Dialog/Sheet 仍须登记隐藏状态。不能通过删除 WorkspacePage 的监听、绕过所有 hidden 判断或修改全局事件管理器来解决。

### Bug 2：移错顶栏按钮

`76f4d8d8` 删除了账号按钮，却保留了汉堡按钮。应恢复纯账号触发按钮，点击 dispatch `ACCOUNT_AUTH_OPEN_EVENT`，复用 WorkspacePage 第 246–252 行监听和第 705–709 行受控实例。不能照搬旧版 BrandPreviewBar 的 lazy AccountMenu、Suspense、accountMenuMounted 状态及事件监听，否则会出现双实例。

## 改动文件与实现步骤

| 步骤 | 文件 / 精确位置 | 计划改动 |
| --- | --- | --- |
| 1 | `src/components/mobile-bottom-nav.jsx`：第 4 行 import；`MobileBottomNav` 第 98–104 行 effect | 删除 `setMobileBottomSheetOpen` import 和整个 `mobile-nav-more` 注册/清理 effect。加简短注释说明更多为依附导航的 popover，不登记全局 sheet 状态。 |
| 1 | 同文件：第 81–96 行 effects、第 106 行 hidden guard、第 108–116 行 `selectOverflowTab` / `selectAccount`、第 122–205 行 JSX | 保留外部 sheet 打开时关闭更多、切页关闭、Escape、遮罩、关闭按钮、更多按钮切换等逻辑；保留方案 A 的样式、通知和账号行。 |
| 2 | `src/components/brand-preview-bar.jsx`：第 1–7 行 imports / `BrandPreviewBar` 参数；第 57–61 行汉堡按钮块 | 移除 `Menu` 与 `onOpenNav` 参数；引入 `UserRound` 和 `ACCOUNT_AUTH_OPEN_EVENT`。将汉堡块替换成始终可见的普通按钮，使用 `aria-label="账户"`、已有 `app-header__utility` 样式和 UserRound 图标；点击执行 `window.dispatchEvent(new CustomEvent(ACCOUNT_AUTH_OPEN_EVENT))`。不额外指定注册模式，不挂载 AccountMenu。 |
| 2 | `src/pages/WorkspacePage.jsx`：第 645–657 行 BrandPreviewBar 调用，第 654 行 `onOpenNav` | 删除已无消费者的 `onOpenNav` prop 及其 `console:open-mobile-nav` dispatch。保留第 211–218 行 sheet 监听、第 246–252 行账号事件监听、第 695–709 行导航账号回调与受控 AccountMenu。 |
| 2 | `src/components/header-actions.css`：第 1–24 行三个 menu-button 规则，第 70–72 行移动端规则 | 移除无消费者的 `.app-header__menu-button` 样式；保留其它布局规则。账号复用 `brand-preview-bar.css` 第 148 行起的 utility 样式。 |
| 3 | `test/headerActionsPort.test.mjs`：第 11–16 行首个测试及第 18 行起账号入口测试 | 改名称和断言：账号按钮存在、menu-button 与打开导航按钮不存在；删除 `onClick={onOpenNav}` 正向断言。增加账号事件 dispatch、无局部 AccountMenu 挂载及 WorkspacePage 单实例接线断言；保留更多账号入口和通知测试。 |
| 3 | `test/brandPreviewBarStylePort.test.mjs`：第 10–15 行公共 props 测试、第 24–27 行账号测试 | 从保留 props 列表移除 `onOpenNav`，移除其点击回调断言，保留其余有效 props/callback 检查。第 25 行账号按钮断言由 `doesNotMatch` 改为 `match`，同步改测试名称；继续禁止导入 `account-menu`。 |
| 3 | 新增 `test/mobileBottomNavPopover.test.mjs` | 按现有源码契约测试风格，断言导航不导入/调用 `setMobileBottomSheetOpen`，不含 `mobile-nav-more` 注册；仍保留 hidden 关闭保护与关闭入口，防止再次引入自隐藏链。源码断言只检查代码约束，实际状态行为由浏览器回归验证。 |

实施顺序：先更新/新增回归断言，确认其在旧实现上失败；再完成步骤 1、2，运行全部相关检查，最后按下述移动端清单验收。无需新增依赖，也不涉及行情接口、缓存、Worker 或数据迁移。

## 验证命令与基线

实现后运行：

```bash
node --test test/headerActionsPort.test.mjs test/brandPreviewBarStylePort.test.mjs test/mobileBottomNavConfig.test.mjs test/mobileBottomNavPopover.test.mjs
npm run lint -- --quiet
npm run check:refactor
git diff --check
```

2026-10-20 编写计划时已实跑基线（尚未更改实现与测试）：

- 三个现有相关测试文件共 11 项通过；这些旧断言仍认可错误按钮行为，通过不代表 bug 已解决。
- `git diff --check` 通过。
- `npm run check:refactor` 既有失败：`src/pages/NotifyExperience.jsx` 933 行，预算 880；`workers/ocr-proxy/src/index.js` 287 行，预算 250。
- `npm run lint -- --quiet` 既有 12 个错误：`src/app/networkTrace.js` 5 个未定义变量错误；`account-data-migration-modal.jsx` 1 个 Hook 调用错误；`CnHomeExperience.jsx` 1 个空块错误；`DataRepairExperience.jsx` 2 个空块错误；`NewPlanSelectionCards.jsx` 2 个未转义引号错误；`NotifyEventDetailDialog.jsx` 1 个空块错误。

实施后须重跑并记录结果。相关测试与 diff 检查必须通过；全量 lint / refactor 的既有失败须与基线对照，不得新增错误或扩展本次范围修复无关问题。可另跑 `npx eslint src/components/mobile-bottom-nav.jsx src/components/brand-preview-bar.jsx src/pages/WorkspacePage.jsx --quiet` 验证修改文件。

## 风险与应对

1. **移动端侧边栏失去可见入口**：删除汉堡按钮且 `ConsoleLayout` 已使用 `showMobileBar={false}`，移动端将没有侧边栏入口；用户已明确要求并接受。不补其它侧边栏按钮，验收时记录这一行为。
2. **AccountMenu 双实例**：BrandPreviewBar 只能发事件；唯一挂载点仍在 WorkspacePage。静态检查结合浏览器 DOM / React 检查，确认顶栏和更多入口不会创建两份面板、遮罩或重复监听实例。
3. **全局 sheet 隐藏机制回归**：仅移除更多的注册。打开真实 sheet 时导航仍隐藏，关闭后恢复；若打开真实 sheet 前更多已展开，更多必须随 hidden 关闭且不自动重开。
4. **账号异步加载与重复点击**：复用现有 lazy 单实例；分别在未登录、已登录以及首次加载时测试，连续点击不应产生双层面板，关闭后能再次打开。
5. **样式和测试契约遗漏**：同时移除 onOpenNav 的消费者、传参、失效 CSS 与旧断言，避免只改第 25 行导致另一条测试继续要求汉堡回调；在窄屏确认账号按钮不溢出、不被隐藏。

## 验收标准

修复部署后，在 `https://fast.freebacktrack.tech` 的真实移动端或浏览器移动设备模式（至少 375px、390px 宽）执行并记录版本、设备、结果；本计划不包含部署或宣称已完成线上验证。

- [ ] 点击底部「更多」后，方案 A 列表稳定显示，等待超过 300ms 入场动画后仍保持展开；底部导航持续可见，无闪烁或自动关闭。
- [ ] 关闭按钮、点击遮罩、再次点击更多均可关闭；连接键盘时 Escape 可关闭；连续打开/关闭至少 10 次结果一致，`aria-expanded` 与显示状态一致。
- [ ] 选择换基、通知、文章等列表页面时正常导航并关闭更多；通知未读标记与账号行保持原有表现。
- [ ] 顶栏显示 UserRound「账户」按钮，不存在汉堡图标或 `aria-label="打开导航"` 按钮；移动端侧边栏无入口符合已接受要求。桌面顶栏账号入口也正常。
- [ ] 顶栏账户和更多中的账号行均打开 WorkspacePage 的同一个 AccountMenu；更多账号行先关闭 popover；未登录、已登录状态均可正常打开、关闭、再次打开，无双份账号面板或遮罩。
- [ ] 打开已有真实底部 sheet，导航按原规则隐藏；关闭后恢复，更多不会意外重开。更多自身不会发出 `mobile-nav-more` 的全局 sheet 注册事件。
- [ ] 相关 node 测试、修改文件 eslint、`git diff --check` 通过；全量 eslint 与 refactor guard 记录结果，除上述已核对的基线失败外无新增问题。
