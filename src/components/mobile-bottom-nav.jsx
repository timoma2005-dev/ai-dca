import { useEffect, useState } from 'react';
import { Bell, BookOpen, ChevronRight, House, LineChart, ListChecks, MoreHorizontal, Shuffle, UserRound, Wallet, X } from 'lucide-react';
import { splitMobileBottomNavItems } from './mobile-bottom-nav-config.js';
import { setMobileBottomSheetOpen } from '../app/mobileBottomSheet.js';

const ITEM_ICONS = {
  home: House,
  markets: LineChart,
  holdings: Wallet,
  tradePlans: ListChecks,
  fundSwitch: Shuffle,
  notify: Bell,
  articles: BookOpen,
};

function MobileNavItem({ item, active, onSelect }) {
  const Icon = ITEM_ICONS[item.key];
  if (!Icon) return null;
  return (
    <button
      key={item.key}
      type="button"
      className="mobile-bottom-nav__item"
      data-active={active || undefined}
      aria-current={active ? 'page' : undefined}
      onClick={() => onSelect?.(item.key)}
    >
      <Icon className="mobile-bottom-nav__icon" strokeWidth={active ? 2 : 1.8} aria-hidden="true" />
      <span>{item.label}</span>
    </button>
  );
}

function MoreListRow({ item, active, unreadCount = 0, onSelect }) {
  const Icon = ITEM_ICONS[item.key];
  if (!Icon) return null;
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
}) {
  const [{ directItems, overflowItems }, setItems] = useState(() => splitMobileBottomNavItems(visibleTabs));
  const [moreOpen, setMoreOpen] = useState(false);
  const overflowActive = overflowItems.some((item) => item.key === activeKey);

  useEffect(() => {
    setItems(splitMobileBottomNavItems(visibleTabs));
  }, [visibleTabs]);

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

  useEffect(() => {
    if (moreOpen) {
      setMobileBottomSheetOpen('mobile-nav-more', true);
      return () => setMobileBottomSheetOpen('mobile-nav-more', false);
    }
    return undefined;
  }, [moreOpen]);

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
