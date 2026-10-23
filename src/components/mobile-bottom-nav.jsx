import { useEffect, useState } from 'react';
import { ChevronRight, Lock, MoreHorizontal, UserRound, X } from 'lucide-react';
import { splitMobileBottomNavItems } from './mobile-bottom-nav-config.js';
import { resolveMenuIcon } from './rbac/menu-icons.js';

function MobileNavItem({ item, active, onSelect }) {
  const Icon = resolveMenuIcon(item.icon, item.key);
  return (
    <button
      key={item.key}
      type="button"
      className="mobile-bottom-nav__item"
      data-active={active || undefined}
      aria-current={active ? 'page' : undefined}
      data-locked={item.locked ? 'true' : undefined}
      onClick={() => onSelect?.(item.key)}
    >
      <span className="relative inline-flex">
        <Icon className="mobile-bottom-nav__icon" strokeWidth={active ? 2 : 1.8} aria-hidden="true" />
        {item.locked ? <Lock className="absolute -right-1.5 -top-1 h-3 w-3 rounded-full bg-white text-slate-500" aria-label="需要更高权限" /> : null}
      </span>
      <span>{item.label}</span>
    </button>
  );
}

function MoreListRow({ item, active, unreadCount = 0, onSelect }) {
  const Icon = resolveMenuIcon(item.icon, item.key);
  const showUnread = item.key === 'notify' && unreadCount > 0;
  return (
    <button
      key={item.key}
      type="button"
      className="mobile-more__row"
      data-active={active || undefined}
      aria-current={active ? 'page' : undefined}
      onClick={() => onSelect?.(item.key)}
    >
      <span className={`mobile-more__icon${item.primary ? ' mobile-more__icon--primary' : ''}`} aria-hidden="true">
        <Icon className="mobile-more__icon-svg" strokeWidth={1.9} />
        {showUnread ? <span className="mobile-more__unread-dot" /> : null}
      </span>
      <span className="mobile-more__text">
        <span className="mobile-more__title-row">
          <span className="mobile-more__title">{item.label}</span>
          {item.badge ? <span className="mobile-more__pill mobile-more__pill--indigo">{item.badge}</span> : null}
          {item.locked ? (
            <span className="mobile-more__pill mobile-more__pill--slate" data-locked="true">
              <Lock className="mr-0.5 inline h-3 w-3" aria-hidden="true" />
              {item.requiredRole?.name ? `需要${item.requiredRole.name}` : '需登录'}
            </span>
          ) : null}
          {showUnread ? <span className="mobile-more__pill mobile-more__pill--slate">{unreadCount}条未读</span> : null}
        </span>
        {item.subtitle ? <span className="mobile-more__subtitle">{item.subtitle}</span> : null}
      </span>
      <ChevronRight className="mobile-more__arrow" aria-hidden="true" />
    </button>
  );
}

export function MobileBottomNav({
  activeKey = '',
  visibleTabs = null,
  onSelectTab,
  onOpenAccount,
  accountSubtitle,
  unreadCount = 0,
  hidden = false,
  menus = [],
}) {
  const [{ directItems, overflowItems }, setItems] = useState(() =>
    splitMobileBottomNavItems(menus, visibleTabs),
  );
  const [moreOpen, setMoreOpen] = useState(false);
  const overflowActive = overflowItems.some((item) => item.key === activeKey);

  useEffect(() => {
    setItems(splitMobileBottomNavItems(menus, visibleTabs));
  }, [menus, visibleTabs]);

  useEffect(() => {
    if (hidden) setMoreOpen(false);
  }, [hidden]);

  useEffect(() => {
    setMoreOpen(false);
  }, [activeKey]);

  useEffect(() => {
    if (!moreOpen) return undefined;
    function handleKeyDown(event) {
      if (event.key === 'Escape') setMoreOpen(false);
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [moreOpen]);

  // 「更多」是锚定在底部导航上方的小 popover，不是从底部展开的全局 sheet，
  // 不登记全局 bottom sheet 隐藏状态；登记会经 hidden 回传形成自关闭反馈环。
  // 真正从底部展开的 Dialog/Sheet 仍须按 AGENTS.md 登记。

  if (hidden || (directItems.length === 0 && overflowItems.length === 0)) return null;

  function selectOverflowTab(key) {
    setMoreOpen(false);
    onSelectTab?.(key);
  }

  function selectAccount() {
    setMoreOpen(false);
    onOpenAccount?.();
  }

  const showAccountRow = typeof onOpenAccount === 'function';

  return (
    <>
      {moreOpen ? (
        <>
          <button
            type="button"
            className="fixed inset-0 z-[94] cursor-default bg-slate-950/10 sm:hidden"
            aria-label="关闭更多导航"
            onClick={() => setMoreOpen(false)}
          />
          <div
            id="mobile-bottom-nav-more"
            className="mobile-more"
            role="dialog"
            aria-modal="false"
            aria-label="更多页面"
          >
            <div className="mobile-more__header">
              <span className="mobile-more__header-title">更多</span>
              <button
                type="button"
                className="mobile-more__close"
                aria-label="关闭更多导航"
                onClick={() => setMoreOpen(false)}
              >
                <X className="h-5 w-5" aria-hidden="true" />
              </button>
            </div>
            <div className="mobile-more__list" role="list">
              {overflowItems.map((item) => (
                <MoreListRow
                  key={item.key}
                  item={item}
                  active={item.key === activeKey}
                  unreadCount={unreadCount}
                  onSelect={selectOverflowTab}
                />
              ))}
              {showAccountRow ? (
                <>
                  <div className="mobile-more__divider" aria-hidden="true" />
                  <button
                    type="button"
                    className="mobile-more__row"
                    onClick={selectAccount}
                  >
                    <span className="mobile-more__icon" aria-hidden="true">
                      <UserRound className="mobile-more__icon-svg" strokeWidth={1.9} />
                    </span>
                    <span className="mobile-more__text">
                      <span className="mobile-more__title-row">
                        <span className="mobile-more__title">账号</span>
                      </span>
                      <span className="mobile-more__subtitle">{accountSubtitle || '登录账号，管理云端同步'}</span>
                    </span>
                    <ChevronRight className="mobile-more__arrow" aria-hidden="true" />
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </>
      ) : null}

      <nav className="mobile-bottom-nav" aria-label="移动端主导航" data-testid="mobile-bottom-nav">
        {directItems.map((item) => (
          <MobileNavItem
            key={item.key}
            item={item}
            active={item.key === activeKey}
            onSelect={onSelectTab}
          />
        ))}
        {overflowItems.length > 0 || showAccountRow ? (
          <button
            type="button"
            className="mobile-bottom-nav__item"
            data-active={overflowActive || moreOpen || undefined}
            aria-label="更多页面"
            aria-expanded={moreOpen}
            aria-controls="mobile-bottom-nav-more"
            onClick={() => setMoreOpen((open) => !open)}
          >
            <MoreHorizontal className="mobile-bottom-nav__icon" strokeWidth={overflowActive ? 2 : 1.8} aria-hidden="true" />
            <span>更多</span>
          </button>
        ) : null}
      </nav>
    </>
  );
}
