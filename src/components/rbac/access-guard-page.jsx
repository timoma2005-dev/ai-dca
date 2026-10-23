import { useEffect, useRef } from 'react';
import { Lock, LogIn, ShieldAlert } from 'lucide-react';
import { requiredRoleLabel } from '../../app/rbac/menuModel.js';

/**
 * 路由守卫页：
 * - status=login：游客访问需要登录的页面，展示登录入口（首次渲染自动弹一次登录框）；
 * - status=forbidden：已登录但角色不足，展示 403「需要 VIP / SVIP / 管理员」。
 */
export function AccessGuardPage({ status, requiredRole, menuLabel = '', onLogin, onBack, autoPromptLogin = true }) {
  const promptedRef = useRef(false);
  useEffect(() => {
    if (status !== 'login' || !autoPromptLogin || promptedRef.current) return;
    promptedRef.current = true;
    onLogin?.();
  }, [status, autoPromptLogin, onLogin]);

  const roleLabel = requiredRoleLabel(requiredRole);
  const isLogin = status === 'login';
  const Icon = isLogin ? Lock : ShieldAlert;

  return (
    <section
      className="mx-auto flex min-h-[50vh] max-w-lg flex-col items-center justify-center px-6 py-12 text-center"
      role="alert"
      data-testid={isLogin ? 'access-guard-login' : 'access-guard-forbidden'}
    >
      <span className={`inline-flex h-14 w-14 items-center justify-center rounded-2xl ${isLogin ? 'bg-indigo-50 text-indigo-600' : 'bg-amber-50 text-amber-600'}`}>
        <Icon className="h-7 w-7" aria-hidden="true" />
      </span>
      {isLogin ? (
        <>
          <h2 className="mt-4 text-lg font-bold text-slate-900">登录后可使用{menuLabel ? `「${menuLabel}」` : '此功能'}</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">该页面需要登录账号，数据会保存在你的账户中并在多端同步。</p>
          <button
            type="button"
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-indigo-700"
            onClick={() => onLogin?.()}
          >
            <LogIn className="h-4 w-4" aria-hidden="true" />
            登录 / 注册
          </button>
        </>
      ) : (
        <>
          <div className="mt-4 text-xs font-semibold uppercase tracking-[0.18em] text-amber-600">403</div>
          <h2 className="mt-1 text-lg font-bold text-slate-900">需要 {roleLabel}</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            当前账号的角色不足以访问{menuLabel ? `「${menuLabel}」` : '此页面'}。如需开通，请联系管理员。
          </p>
        </>
      )}
      {onBack ? (
        <button type="button" className="mt-3 text-sm font-semibold text-slate-500 hover:text-slate-800" onClick={onBack}>
          返回首页
        </button>
      ) : null}
    </section>
  );
}
