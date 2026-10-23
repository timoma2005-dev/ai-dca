import { useEffect, useRef } from 'react';
import { Coffee, Lock, LogIn, ShieldAlert, Sparkles } from 'lucide-react';
import { isPaidRole, requiredRoleLabel } from '../../app/rbac/menuModel.js';

/**
 * 路由守卫页：
 * - status=login：游客访问需要登录的页面，展示登录入口（首次渲染自动弹一次登录框）；
 * - status=forbidden + VIP/SVIP：付费功能，引导打赏并备注账号名，由管理员开通（onUpgrade 打开打赏二维码）；
 * - status=forbidden + 管理员：仅管理员可访问。
 */
export function AccessGuardPage({ status, requiredRole, menuLabel = '', username = '', onLogin, onUpgrade, onBack, autoPromptLogin = true }) {
  const promptedRef = useRef(false);
  useEffect(() => {
    if (status !== 'login' || !autoPromptLogin || promptedRef.current) return;
    promptedRef.current = true;
    onLogin?.();
  }, [status, autoPromptLogin, onLogin]);

  const roleLabel = requiredRoleLabel(requiredRole);
  const isLogin = status === 'login';
  const isPaid = !isLogin && isPaidRole(requiredRole);
  const Icon = isLogin ? Lock : isPaid ? Sparkles : ShieldAlert;
  const target = menuLabel ? `「${menuLabel}」` : '此功能';

  return (
    <section
      className="mx-auto flex min-h-[50vh] max-w-lg flex-col items-center justify-center px-6 py-12 text-center"
      role="alert"
      data-testid={isLogin ? 'access-guard-login' : isPaid ? 'access-guard-paid' : 'access-guard-forbidden'}
    >
      <span className={`inline-flex h-14 w-14 items-center justify-center rounded-2xl ${isLogin ? 'bg-indigo-50 text-indigo-600' : isPaid ? 'bg-amber-50 text-amber-500' : 'bg-slate-100 text-slate-500'}`}>
        <Icon className="h-7 w-7" aria-hidden="true" />
      </span>
      {isLogin ? (
        <>
          <h2 className="mt-4 text-lg font-bold text-slate-900">登录后即可使用{target}</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">免费注册，数据保存在你的账号里，换设备也能接着用。</p>
          <button
            type="button"
            className="mt-6 inline-flex items-center gap-2 rounded-xl bg-indigo-600 px-4 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-indigo-700"
            onClick={() => onLogin?.()}
          >
            <LogIn className="h-4 w-4" aria-hidden="true" />
            登录 / 注册
          </button>
        </>
      ) : isPaid ? (
        <>
          <div className="mt-4 inline-flex items-center rounded-full bg-amber-50 px-2.5 py-0.5 text-xs font-bold text-amber-700">{roleLabel} 专享</div>
          <h2 className="mt-2 text-lg font-bold text-slate-900">{target}为 {roleLabel} 会员功能</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">
            如需更多功能，请随意打赏并备注账号名{username ? <>「<span className="font-semibold text-slate-700">{username}</span>」</> : ''}，管理员看到后会尽快为您开通。
          </p>
          {onUpgrade ? (
            <button
              type="button"
              className="mt-6 inline-flex items-center gap-2 rounded-xl bg-amber-500 px-4 py-2.5 text-sm font-bold text-white shadow-sm hover:bg-amber-600"
              onClick={() => onUpgrade()}
            >
              <Coffee className="h-4 w-4" aria-hidden="true" />
              打赏开通
            </button>
          ) : null}
          <p className="mt-3 text-xs text-slate-400">开通后刷新页面即可使用</p>
        </>
      ) : (
        <>
          <div className="mt-4 text-xs font-semibold uppercase tracking-[0.18em] text-slate-400">403</div>
          <h2 className="mt-1 text-lg font-bold text-slate-900">仅{roleLabel}可访问</h2>
          <p className="mt-2 text-sm leading-6 text-slate-500">{target}仅对{roleLabel}开放。</p>
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
