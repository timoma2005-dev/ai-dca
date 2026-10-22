# 管理员雷达页竞价看板 Tab 接入计划

## 挂载方式

- 将用户提供的 `/home/hatch/workspace/user/files/________2__0_zj1r.html` 原样复制为 `public/auction-board.html`，保留全部内联样式、脚本、第三方 JSONP 请求及 localStorage 行为，不修改 HTML 内容。
- 新建 `src/pages/radar/AuctionBoardPanel.jsx`，复用 `ArticlesExperience` 的 section + iframe 结构、圆角、边框、阴影与响应式高度。section 的 `aria-label` 为“竞价看板”；iframe 使用 `/auction-board.html`、标题“纳指期指与ETF竞价看板”和 `loading="eager"`。
- 仅在管理员雷达页选中 `auction` 子 tab 时挂载面板；切换离开即卸载 iframe，避免未显示时发起第三方请求。

## 改动点

1. 新增本计划文档并按计划实施。
2. 新增原样复制的 `public/auction-board.html`，使用 `cmp` 和 SHA-256 校验字节一致性。
3. 新增 `src/pages/radar/AuctionBoardPanel.jsx`：section 使用 `h-[calc(100vh-10rem)] min-h-[560px] w-full overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm sm:h-[calc(100vh-8rem)] sm:min-h-[640px]`，iframe 使用 `h-full w-full border-0` 和与文章页相同的 referrer policy。
4. 修改 `src/pages/AdminRadarExperience.jsx`：在 shares 之后新增 `{ key: 'auction', label: '竞价看板', href: '#auction' }`；抽出统一的 hash 映射函数供初始状态与 hashchange 监听共用，`#shares` 映射 shares、`#auction` 映射 auction、其余映射 radar；新增 `panel-auction`、`aria-labelledby="tab-auction"` 和对应 hidden 条件，内容使用 `{activeTab === 'auction' && <AuctionBoardPanel />}`；文件头注明静态页来源。
5. 新增 `test/adminRadarAuctionTab.test.mjs`，沿用仓库源码断言测试风格，覆盖 tab/面板、共享 hash 映射、懒挂载、iframe 地址与样式、静态页标题及管理员门控。

## 门控与边界

- 原样保留 `activeTab !== 'shares' && !isAnalyticsAdmin(session)` 判定；shares 仍公开，radar 和 auction 均要求管理员权限。
- 管理员门控保护的是 React 页内入口；`public/auction-board.html` 是可直接访问的静态资源，不新增服务端鉴权。
- 不改顶级导航、`WorkspacePage` 或 `screens.js`，不增加本站后端接口，不改用户 HTML，也不碰未跟踪的 `docs/plan-react-router-migration.md`。
- 本次只改本仓库文件并验证，不 commit、push、release，也不修改任何线上目录或构建产出。

## 验收方式

- 对源文件和复制文件执行 `cmp` 与 `sha256sum`，报告退出状态、文件大小及完整哈希。
- 运行 `node --test test/adminRadarAuctionTab.test.mjs test/radarClient.test.mjs test/radarModel.test.mjs` 并报告实际通过/失败数。
- 对改动的 JSX 和测试文件单独运行 ESLint；运行 `npm run lint -- --quiet`，与实现前基线对比，只报告既有问题。
- 运行 `npm run check:refactor` 并与实现前基线对比，如失败列出既有超限文件及行数。
- 运行 `git diff --check`，审阅变更范围，确认只涉及本计划所列文件。
- 页面验收预期：管理员访问 `#auction` 或点击“竞价看板”可见 iframe；刷新和 hashchange 均正确选中；非管理员在 `#auction` 被现有门控拦截，在 `#shares` 仍可访问；未选中 auction 时不挂载 iframe。

## 风险

- 东财、新浪、腾讯等第三方数据源由浏览器直连，受可用性、限流与 JSONP 兼容性影响；本次不验证或调整其既有数据逻辑。
- 部署环境的 CSP（内联脚本/样式、第三方脚本、frame 限制）可能影响静态页；保持原页不变，后续上线时需在实际响应头环境验收。
- 固定 URL `/auction-board.html` 可能被浏览器或 CDN 缓存，后续更新应通过正常发布流程及既有缓存刷新策略处理；同源 localStorage 延续用户现有行为。

## 设计变更：22:06 用户指令（覆盖前述子 tab 挂载方案）

用户于 22:06 指定：竞价看板改为与监控雷达平行的顶级管理员 tab；雷达移除“份额新增”与“竞价看板”子 tab。此次在 `afdb389f` 之上修改源码，保留前述内容作为历史方案记录，不改写提交历史。

### 最终挂载与兼容行为

- `ADMIN_TAB_ORDER` 为 `['adminQuant', 'adminRadar', 'adminAuction']`；竞价在 `PRIMARY_TAB_META` 标记 `adminOnly: true`，链接使用 `?tab=adminAuction`，场景可见列表末尾添加同名 tab。
- `WorkspacePage` 为竞价注册标题“竞价看板”、`Gavel` 图标与懒加载的 `AdminAuctionExperience`；仅管理员选中竞价 tab 时挂载 iframe，非管理员维持 `HoldingsExperience` 兜底。移动端“更多”菜单同步添加管理员竞价入口与 `Gavel` 图标。
- 原 `AuctionBoardPanel` 的 section、iframe、标题、高度、`aria-label`、加载方式与 referrer policy 原样迁入 `src/pages/AdminAuctionExperience.jsx`，删除旧组件。
- `AdminRadarExperience` 仅保留 `isAnalyticsAdmin(session)` 门控、现有无权限提示、容器和 `RadarPanel`，移除子 tab、hash 状态与监听，不再引用份额和竞价页面；保留文件头数据来源说明。
- 公开 `?tab=shares` 继续直接渲染 `SharesExperience`。旧 `?tab=adminRadar#shares` 在 `WorkspacePage` 的 `adminRadar` 分支直接渲染同一组件，管理员与非管理员一致；两处 `isPublicShares` 判定保持不动。其他 hash 仍由管理员进入雷达，非管理员进入持仓兜底。
- `?tab=adminRadar#auction` 不再挂载竞价 iframe；竞价入口改为 `?tab=adminAuction`，不新增旧竞价 hash 重定向。
- `public/auction-board.html` 不修改，预期 SHA-256 为 `c01108707aa76ca59866c63a379c8856004dfcb932664ef9fe5f291ee54a9a89`；静态资源直接访问与第三方数据源边界延续原方案。

### 新验收点

- 重写 `test/adminRadarAuctionTab.test.mjs`：覆盖顶级 tab 顺序、管理员元数据、两种页面目录下的链接、场景可见性、工作台标题与图标、懒加载与权限门控、旧份额深链、雷达单面板、iframe 属性与静态 HTML 标题。
- 更新 `test/sharesWorkspaceRedirect.test.mjs`：保留两处公开份额访问例外的行为测试，执行实际 `renderActivePanel` 验证管理员和非管理员的份额深链、雷达分流及竞价兜底。
- 更新 `test/mobileBottomNavConfig.test.mjs`：竞价在雷达之后，管理员在“更多”中可见，非管理员不可见。
- 更新 `test/etfSharesDetailUi.test.mjs`：复用工作台真实分流函数，验证旧 `#shares` 直达公开看板、无雷达子 tab、hash 切换与 history 长度，保留其余份额详情和请求测试。
- 运行 `node --test test/*.test.mjs` 全量测试并报告通过、失败数；对每个失败在 `afdb389f` 基线上复核，区分本次引入与既有失败。e2e spec 不运行、不修改，报告其中明显过时的雷达子 tab 断言。
- 单独对改动 JS、JSX 与测试执行 ESLint；运行 `npm run lint -- --quiet`、`npm run check:refactor` 和 `git diff --check`，如有失败与改动前基线对比。
- 最后校验静态 HTML 哈希与变更范围；不修改 `docs/plan-react-router-migration.md`，不 commit、push、release，不编辑线上目录或构建产出物。
