import { useEffect, useState } from 'react';
import { Menu, ChevronsRight, ChevronsLeft, X, Lock, Info, CheckCircle2, XCircle, AlertTriangle } from 'lucide-react';
import { AnimatePresence, motion, useReducedMotion } from 'motion/react';
import { motionTokens } from './arc/lib/motion-tokens.js';
import { consumePendingToasts, subscribeToToasts } from '../app/toast.js';
import { AccountLoadingIndicator } from './account-loading-indicator.jsx';
import { sidenavLinkA11y } from './consoleSidenavA11y.js';

function cx(...classes) {
  return classes.filter(Boolean).join(' ');
}

const toastToneIcons = {
  slate: { Icon: Info, className: 'text-slate-500' },
  indigo: { Icon: Info, className: 'text-indigo-600' },
  emerald: { Icon: CheckCircle2, className: 'text-emerald-600' },
  red: { Icon: XCircle, className: 'text-red-600' },
  amber: { Icon: AlertTriangle, className: 'text-amber-600' }
};

function ConsoleToastViewport() {
  const [toasts, setToasts] = useState([]);
  const reduceMotion = useReducedMotion();

  useEffect(() => {
    function appendToast(toast) {
      setToasts((current) => [...current.filter((item) => item.id !== toast.id), toast].slice(-4));
    }

    consumePendingToasts().forEach(appendToast);
    return subscribeToToasts(appendToast);
  }, []);

  useEffect(() => {
    const timers = toasts.map((toast) =>
      window.setTimeout(() => {
        setToasts((current) => current.filter((item) => item.id !== toast.id));
      }, toast.durationMs || 3200)
    );

    return () => {
      timers.forEach((timer) => window.clearTimeout(timer));
    };
  }, [toasts]);

  useEffect(() => {
    if (!toasts.some((toast) => toast.dismissOnInteraction)) {
      return undefined;
    }

    function dismissInteractiveToasts() {
      setToasts((current) => current.filter((toast) => !toast.dismissOnInteraction));
    }

    window.addEventListener('pointerdown', dismissInteractiveToasts, { capture: true });
    return () => {
      window.removeEventListener('pointerdown', dismissInteractiveToasts, { capture: true });
    };
  }, [toasts]);

  // Arc toast stack: newest on top, each toast drops in from above on a spring, the rest slide down to make room,
  // and a leaving toast fades up and out quickly. Reduced motion keeps only the fades.
  return (
    <div className="pointer-events-none fixed right-4 top-4 z-[120] flex w-[min(92vw,24rem)] flex-col gap-2" role="status" aria-live="polite">
      <AnimatePresence initial={false}>
        {[...toasts].reverse().map((toast) => {
          const tone = toastToneIcons[toast.tone] || toastToneIcons.slate;
          const Icon = tone.Icon;
          return (
            <motion.div
              key={toast.id}
              layout={!reduceMotion}
              initial={reduceMotion ? { opacity: 0 } : { opacity: 0, y: -12, scale: 0.96 }}
              animate={{ opacity: 1, y: 0, scale: 1 }}
              exit={reduceMotion ? { opacity: 0, transition: { duration: 0.1 } } : { opacity: 0, y: -6, scale: 0.98, transition: { duration: motionTokens.duration.fast, ease: [...motionTokens.ease.standard] } }}
              transition={reduceMotion ? { duration: 0.1 } : motionTokens.spring.smooth}
              className="pointer-events-auto flex items-start gap-2.5 rounded-2xl border border-[var(--ds-border)] bg-[var(--ds-surface)] px-3.5 py-3 text-[var(--ds-ink)] shadow-[var(--arc-shadow-floating)]"
            >
              <Icon className={cx('mt-0.5 h-4 w-4 shrink-0', tone.className)} aria-hidden="true" />
              <div className="min-w-0">
                <div className="text-sm font-medium">{toast.title}</div>
                {toast.description ? (
                  <div className="mt-0.5 text-[13px] leading-5 text-[var(--ds-muted)]">{toast.description}</div>
                ) : null}
              </div>
            </motion.div>
          );
        })}
      </AnimatePresence>
    </div>
  );
}

/**
 * ConsoleLayout: a dashboard-style shell with left sidebar, optional topbar, main content,
 * and an optional right context panel. Replaces the previous PageShell + TopBar (tabs) combo.
 *
 * Props:
 * - sidebarNav: Array<{ key, label, href?, icon?, locked? }> — 主导航项（locked 显示锁图标）
 * - sidebarAdminNav: Array<{ key, label, href?, icon? }> — 管理项（可选，会在底部单独分组）
 * - activeKey: string
 * - onSelectNav: (key) => void
 * - brand: string (sidebar brand)
 * - topbarTitle / topbarDescription / topbarRight: optional. Topbar is hidden if all are empty.
 * - contextPanel / contextPanelTitle: optional right panel content.
 * - sidebarFooter: optional node rendered at the bottom of the sidebar (e.g. quick actions or market snapshot).
 */
function SidenavLink({ item, activeKey, onSelectNav, className = '' }) {
  const Icon = item.icon;
  const isActive = item.key === activeKey;
  return (
    <a
      href={item.href}
      {...sidenavLinkA11y(item, activeKey)}
      data-locked={item.locked ? 'true' : undefined}
      className={cx('console-sidenav__link', isActive && 'is-active', className)}
      onClick={(event) => {
        if (!onSelectNav) return;
        event.preventDefault();
        onSelectNav(item.key);
      }}
    >
      {Icon ? <Icon className="h-4 w-4 shrink-0" aria-hidden="true" /> : null}
      <span className="truncate">{item.label}</span>
      {item.locked ? <Lock className="ml-auto h-3.5 w-3.5 shrink-0 text-slate-400" aria-hidden="true" data-menu-lock="true" /> : null}
    </a>
  );
}

export function ConsoleLayout({
  sidebarNav = [],
  sidebarAdminNav = [],
  activeKey = '',
  onSelectNav,
  brand = 'ai-dca',
  topbarTitle,
  topbarDescription,
  topbarRight,
  contextPanel,
  contextPanelTitle,
  sidebarFooter,
  showMobileBar = true,
  autoCollapseOnActiveKeyChange = false,
  children
}) {
  const [mobileNavOpen, setMobileNavOpen] = useState(false);
  const [desktopNavCollapsed, setDesktopNavCollapsed] = useState(() => {
    if (autoCollapseOnActiveKeyChange) return true;
    if (typeof window === 'undefined') return false;
    try { return window.localStorage.getItem('console:navCollapsed') === '1'; } catch (_) { return false; }
  });
  const [isMobileViewport, setIsMobileViewport] = useState(false);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    try { window.localStorage.setItem('console:navCollapsed', desktopNavCollapsed ? '1' : '0'); } catch (_) { /* ignore */ }
  }, [desktopNavCollapsed]);

  useEffect(() => {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return undefined;
    const query = window.matchMedia('(max-width: 1023px)');
    const syncViewport = () => setIsMobileViewport(Boolean(query.matches));
    syncViewport();
    if (typeof query.addEventListener === 'function') {
      query.addEventListener('change', syncViewport);
      return () => query.removeEventListener('change', syncViewport);
    }
    query.addListener(syncViewport);
    return () => query.removeListener(syncViewport);
  }, []);

  useEffect(() => {
    setMobileNavOpen(false);
  }, [activeKey]);

  useEffect(() => {
    if (autoCollapseOnActiveKeyChange) {
      setDesktopNavCollapsed(true);
    }
  }, [activeKey, autoCollapseOnActiveKeyChange]);

  useEffect(() => {
    if (typeof window === 'undefined') return undefined;
    function handleOpenMobileNav() {
      setMobileNavOpen(true);
    }
    window.addEventListener('console:open-mobile-nav', handleOpenMobileNav);
    return () => window.removeEventListener('console:open-mobile-nav', handleOpenMobileNav);
  }, []);

  useEffect(() => {
    if (!mobileNavOpen) {
      return undefined;
    }
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previousOverflow;
    };
  }, [mobileNavOpen]);

  const hasTopbar = Boolean(topbarTitle || topbarDescription || topbarRight);
  const hasContext = Boolean(contextPanel);
  const mobileSidebarHidden = isMobileViewport && !mobileNavOpen;
  const currentNavItem = sidebarNav.find((item) => item.key === activeKey) || sidebarAdminNav.find((item) => item.key === activeKey);
  const mobileTitle = topbarTitle || currentNavItem?.label || brand;

  return (
    <div className="console-root">
      <ConsoleToastViewport />
      {/* 账号加载 / 保存 / 删除 的全局统一加载态提示 */}
      <AccountLoadingIndicator />

      {/* Mobile top bar with menu button */}
      {showMobileBar ? (
        <div className="console-mobilebar">
          <button
            type="button"
            aria-label="打开导航"
            className="console-iconbtn"
            onClick={() => setMobileNavOpen(true)}
          >
            <Menu className="h-5 w-5" aria-hidden="true" />
          </button>
          <div className="console-mobilebar__title">{mobileTitle}</div>
          {topbarRight ? <div className="console-mobilebar__right">{topbarRight}</div> : null}
        </div>
      ) : null}

      <div className={cx('console-shell', desktopNavCollapsed && 'is-nav-collapsed')}>
        <aside
          className={cx('console-sidebar', mobileNavOpen && 'is-open')}
          aria-label="模块导航"
          hidden={mobileSidebarHidden}
          aria-hidden={mobileSidebarHidden ? 'true' : undefined}
          {...(mobileSidebarHidden ? { inert: true } : {})}
        >
          <div className="console-sidebar__mobile-header">
            <span className="console-brand">{brand}</span>
            <button
              type="button"
              aria-label="关闭导航"
              className="console-sidebar__close-btn"
              onClick={() => setMobileNavOpen(false)}
            >
              <X className="h-5 w-5" aria-hidden="true" />
            </button>
          </div>
          <nav className="console-sidenav" aria-label="模块导航">
            {sidebarNav.map((item) => (
              <SidenavLink key={item.key} item={item} activeKey={activeKey} onSelectNav={onSelectNav} />
            ))}
            {sidebarAdminNav.length > 0 && (
              <>
                <div className="px-3 pt-4 pb-2 text-xs font-semibold uppercase tracking-wide text-slate-400">管理</div>
                {sidebarAdminNav.map((item) => (
                  <SidenavLink key={item.key} item={item} activeKey={activeKey} onSelectNav={onSelectNav} className="opacity-75" />
                ))}
              </>
            )}
          </nav>
          {sidebarFooter ? <div className="console-sidebar__footer">{sidebarFooter}</div> : null}
          <button
            type="button"
            aria-label={desktopNavCollapsed ? "展开导航" : "收起导航"}
            title={desktopNavCollapsed ? "展开导航" : "收起导航"}
            aria-expanded={!desktopNavCollapsed}
            className="console-sidebar__expand"
            onClick={() => setDesktopNavCollapsed((v) => !v)}
          >
            {desktopNavCollapsed ? (
              <ChevronsRight className="h-4 w-4" aria-hidden="true" />
            ) : (
              <ChevronsLeft className="h-4 w-4" aria-hidden="true" />
            )}
          </button>
        </aside>

        {mobileNavOpen ? (
          <button
            type="button"
            aria-label="关闭导航遮罩"
            className="console-backdrop"
            onClick={() => setMobileNavOpen(false)}
          />
        ) : null}

        <main className="console-main">
          {hasTopbar ? (
            <header className="console-topbar">
              <div className="console-topbar__title">
                {topbarTitle ? <div className="console-topbar__heading">{topbarTitle}</div> : null}
                {topbarDescription ? <div className="console-topbar__desc">{topbarDescription}</div> : null}
              </div>
              {topbarRight ? <div className="console-topbar__right">{topbarRight}</div> : null}
            </header>
          ) : null}
          <div className="console-main__body">{children}</div>
        </main>

        {hasContext ? (
          <aside className="console-ctx" aria-label="详情面板">
            <div className="console-ctx__header">
              <div className="console-ctx__title">{contextPanelTitle || '详情'}</div>
            </div>
            <div className="console-ctx__body">{contextPanel}</div>
          </aside>
        ) : null}
      </div>
    </div>
  );
}
