import { AlertCircle, Coffee, LineChart, UserRound } from 'lucide-react';
import { useNotifyUnreadCount } from '../app/useNotifyUnreadCount.js';
import { ACCOUNT_AUTH_OPEN_EVENT } from '../app/accountAuthEvents.js';
import { NotifyPopover } from './notify-popover.jsx';
import { RoleBadge } from './rbac/role-badge.jsx';
import './brand-preview-bar.css';
import './header-actions.css';

export function BrandPreviewBar({ currentPageLabel, onBuyMeCoffee, onJoinGroup, onShowDisclaimer, topRole = null }) {
  const handleCoffeeClick = onBuyMeCoffee || onJoinGroup;
  useNotifyUnreadCount();

  return (
    <header className="app-header brand-preview-bar" data-testid="brand-preview-bar">
      <div className="app-header__inner">
        <div className="app-header__brand">
          <span className="app-header__mark" aria-hidden="true">
            <LineChart className="h-[17px] w-[17px]" strokeWidth={1.9} />
          </span>
          <span className="app-header__brand-copy">
            <span className="app-header__brand-name">美股策略助手</span>
            <span className="app-header__brand-badge">Beta</span>
          </span>
        </div>

        {currentPageLabel ? (
          <>
            <span className="app-header__divider" aria-hidden="true" />
            <span className="app-header__page-title">{currentPageLabel}</span>
          </>
        ) : null}

        <div className="app-header__actions">
          <div className="hidden items-center gap-1 md:flex" aria-label="帮助与社区">
            {handleCoffeeClick ? (
              <button
                type="button"
                onClick={handleCoffeeClick}
                className="inline-flex min-h-[34px] items-center gap-1.5 rounded-md px-3 text-sm font-medium text-amber-800 transition-colors hover:bg-amber-50 hover:text-amber-900 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
              >
                <Coffee className="h-4 w-4 text-amber-600" aria-hidden="true" />
                Buy me coffee
              </button>
            ) : null}
            {onShowDisclaimer ? (
              <button
                type="button"
                onClick={onShowDisclaimer}
                className="inline-flex min-h-[34px] items-center gap-2 rounded-md px-3 text-sm font-medium text-amber-700 transition-colors hover:bg-amber-50 hover:text-amber-800 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-amber-600"
              >
                <AlertCircle className="h-4 w-4" aria-hidden="true" />
                免责声明
              </button>
            ) : null}
          </div>
          <div className="hidden md:block">
            <NotifyPopover />
          </div>
          <button
            type="button"
            className="app-header__utility"
            aria-label="账户"
            title={topRole?.name ? `账户 · ${topRole.name}` : undefined}
            onClick={() => window.dispatchEvent(new CustomEvent(ACCOUNT_AUTH_OPEN_EVENT))}
          >
            <span className="relative inline-flex">
              <UserRound className="h-[18px] w-[18px]" aria-hidden="true" />
              <RoleBadge topRole={topRole} className="absolute -bottom-1.5 -right-1.5" />
            </span>
          </button>
        </div>
      </div>
    </header>
  );
}
