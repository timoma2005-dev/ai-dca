import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { KeyRound, Loader2, LogOut, UserRound, X } from 'lucide-react';
import { useRbac } from '../app/rbac/useRbac.js';
import { clearRbacState, notifyServerLogout } from '../app/rbac/rbacStore.js';
import { RoleAvatar, RoleList } from './rbac/role-badge.jsx';
import { clearCloudSession, CLOUD_SYNC_SESSION_EVENT, loadCloudSession, loginCloudAccount, registerCloudAccount } from '../app/authClient.js';
import { ACCOUNT_AUTH_OPEN_EVENT, consumeAccountAuthIntent } from '../app/accountAuthEvents.js';
import { clearRememberedKey } from '../app/secureVault.js';
import { showToast } from '../app/toast.js';
import { cx, inputClass, primaryButtonClass } from './experience-ui.jsx';
import { PrivacyNotice } from './PrivacyNotice.jsx';
import { GettingStartedEntry } from './onboarding/GettingStartedSlot.jsx';
import { LoginSyncPendingEntry } from './login-sync-pending-entry.jsx';
import { evaluateTabAccess } from '../app/rbac/menuModel.js';
import { authFieldAttrs, missingAuthField, resolveAuthFormHint } from '../app/authFormState.js';

// 头像菜单锚点：顶栏账户按钮（brand-preview-bar 上的 data-account-trigger）。
// 菜单通过 portal 挂到 body 并用 fixed 定位到按钮正下方，
// 避免受 WorkspacePage 末尾容器位置影响而“掉到页面底部”。
const ACCOUNT_TRIGGER_SELECTOR = '[data-account-trigger]';
const VIEWPORT_GUTTER = 12;

export function computeAccountMenuAnchor(rect, viewportWidth) {
  const width = Number(viewportWidth) || 0;
  if (!rect || !(rect.bottom > 0)) return { top: VIEWPORT_GUTTER, right: VIEWPORT_GUTTER, arrowRight: null };
  const right = Math.max(VIEWPORT_GUTTER, Math.round(width - rect.right));
  const arrowCenter = Math.round(width - right - (rect.left + rect.width / 2));
  return {
    top: Math.round(rect.bottom + 8),
    right,
    arrowRight: arrowCenter >= 12 ? arrowCenter - 6 : null
  };
}

// 认证失败的唯一文案出口：401/409/400/5xx/网络失败/超时/异常 2xx 各有明确提示。
// 云端同步阶段的错误（迁移 401、D1 session 未就绪等）不经过这里，绝不显示成密码错误。
function formatAuthError(err, action = 'login') {
  const label = action === 'register' ? '注册' : '登录';
  const message = String(err?.message || err || '').trim();
  switch (err?.code) {
    case 'AUTH_TIMEOUT':
      return `${label}请求超时，请检查网络后重试。`;
    case 'AUTH_NETWORK_ERROR':
      return '网络连接失败，请检查网络后重试。';
    case 'AUTH_INVALID_RESPONSE':
      return `${label}服务返回数据异常，请稍后重试。`;
    default:
      break;
  }
  const status = Number(err?.status || 0);
  if (status === 401) return '用户名或密码不正确。';
  if (status === 409) return '该用户名已被注册，请更换用户名。';
  if (status === 400) return message || '请求参数不合法，请检查后重试。';
  if (status >= 500) return `${label}服务暂时不可用，请稍后重试。`;
  if (status > 0) return message || `${label}失败（HTTP ${status}），请稍后重试。`;
  return message || `${label}失败，请稍后重试。`;
}

export function AccountMenu({ initialOpen = false, open: controlledOpen, onClose, hideTrigger = false }) {
  const [initialAuthIntent] = useState(() => consumeAccountAuthIntent());
  const [session, setSession] = useState(() => loadCloudSession());
  const rbac = useRbac();
  // 认证错误只在未登录对话框内展示。
  const [authError, setAuthError] = useState('');
  const [form, setForm] = useState({ username: '', password: '', rememberDevice: true });
  const [busy, setBusy] = useState('');
  const [formTouch, setFormTouch] = useState({ touched: false, submitted: false });
  const [open, setOpen] = useState(initialOpen || Boolean(initialAuthIntent));
  const [anchor, setAnchor] = useState(null);
  const isControlled = controlledOpen !== undefined;
  const effectiveOpen = isControlled ? controlledOpen : open;
  const openRef = useRef(effectiveOpen);
  const onCloseRef = useRef(onClose);
  openRef.current = effectiveOpen;
  onCloseRef.current = onClose;
  const closeMenu = useCallback(() => {
    if (isControlled) {
      onCloseRef.current?.();
    } else {
      setOpen(false);
    }
  }, [isControlled]);
  const [authMode, setAuthMode] = useState(initialAuthIntent ? (initialAuthIntent.mode === 'login' ? 'login' : 'register') : 'login');
  const dropdownRef = useRef(null);
  const loggedIn = Boolean(session?.accessToken);

  useEffect(() => {
    function refreshSession(event) {
      setSession(event?.detail?.session || loadCloudSession());
    }
    function syncStorage(event) {
      if (!event.key || event.key.startsWith('aiDca')) refreshSession();
    }
    window.addEventListener(CLOUD_SYNC_SESSION_EVENT, refreshSession);
    window.addEventListener('storage', syncStorage);
    return () => {
      window.removeEventListener(CLOUD_SYNC_SESSION_EVENT, refreshSession);
      window.removeEventListener('storage', syncStorage);
    };
  }, []);

  useEffect(() => {
    function handleOpenAuth(event) {
      if (isControlled) {
        // 受控模式：已登录且菜单已打开时，再点一次头像即关闭（父组件的 setOpen(true) 先执行）。
        if (openRef.current && loadCloudSession()?.accessToken && !event?.detail?.mode) {
          window.setTimeout(() => onCloseRef.current?.(), 0);
        }
        return;
      }
      const mode = event?.detail?.mode === 'login' ? 'login' : 'register';
      setAuthMode(mode);
      setOpen(true);
    }
    window.addEventListener(ACCOUNT_AUTH_OPEN_EVENT, handleOpenAuth);
    return () => window.removeEventListener(ACCOUNT_AUTH_OPEN_EVENT, handleOpenAuth);
  }, [isControlled]);

  useLayoutEffect(() => {
    if (!effectiveOpen || !loggedIn || typeof window === 'undefined') return undefined;
    function place() {
      const trigger = document.querySelector(ACCOUNT_TRIGGER_SELECTOR);
      setAnchor(computeAccountMenuAnchor(trigger?.getBoundingClientRect?.() || null, window.innerWidth));
    }
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [effectiveOpen, loggedIn]);

  useEffect(() => {
    if (!effectiveOpen || typeof document === 'undefined') return undefined;
    const isDropdown = loggedIn;
    const prev = document.body.style.overflow;
    if (!isDropdown) document.body.style.overflow = 'hidden';
    function onKey(event) { if (event.key === 'Escape') closeMenu(); }
    function onClickOutside(event) {
      const target = event.target;
      if (dropdownRef.current?.contains(target)) return;
      // 顶栏头像自己负责开关；隐私说明等弹层（Radix dialog）里的点击不算点外部。
      if (target?.closest?.(ACCOUNT_TRIGGER_SELECTOR) || target?.closest?.('[role="dialog"]')) return;
      closeMenu();
    }
    window.addEventListener('keydown', onKey);
    if (isDropdown) document.addEventListener('mousedown', onClickOutside);
    return () => {
      if (!isDropdown) document.body.style.overflow = prev;
      window.removeEventListener('keydown', onKey);
      if (isDropdown) document.removeEventListener('mousedown', onClickOutside);
    };
  }, [effectiveOpen, loggedIn, closeMenu]);

  function updateField(field, value) {
    setForm((current) => ({ ...current, [field]: value }));
    if (field !== 'rememberDevice') setFormTouch((current) => (current.touched ? current : { ...current, touched: true }));
  }

  function handleAuthSubmit(event) {
    event.preventDefault();
    if (busy) return;
    setFormTouch({ touched: true, submitted: true });
    if (missingAuthField(form)) return;
    void handleAuth(authMode);
  }

  async function handleAuth(action) {
    // 重新提交时清理旧认证错误；认证错误与同步错误（lastError）严格分离。
    setBusy(action);
    setAuthError('');
    try {
      // 只等待认证本身：requestSync 带有限超时与成功 session 形态验证；
      // 迁移检查与首次同步由 authClient 调度的 postAuthSync 协调器在后台执行。
      const nextSession = action === 'register'
        ? await registerCloudAccount(form)
        : await loginCloudAccount(form);
      // 有效 session 已保存：立即完成登录 UI、解除认证 busy，不等待云同步。
      setSession(nextSession || loadCloudSession());
      showToast({
        title: action === 'register' ? '账户已注册' : '已登录',
        description: '云端数据正在后台同步。',
        tone: 'emerald'
      });
      closeMenu();
    } catch (err) {
      // 只有认证本身的失败才显示为登录失败；云端迁移/同步失败由
      // cloud-sync 事件另行展示，绝不冒充密码错误。
      const message = formatAuthError(err, action);
      setAuthError(message);
      showToast({ title: action === 'register' ? '注册失败' : '登录失败', description: message, tone: 'red' });
    } finally {
      setBusy('');
    }
  }

  function handleLogout() {
    // 清除服务端 httpOnly 会话 cookie 并作废本地 session（尽力而为，不阻塞退出）。
    void notifyServerLogout(session?.accessToken);
    clearCloudSession();
    clearRbacState();
    clearRememberedKey();
    setSession(null);
    setAuthError('');
    showToast({ title: '已退出账户', tone: 'slate' });
  }

  const authHint = resolveAuthFormHint({ busy, ...form, ...formTouch });
  const authFields = authFieldAttrs(authMode);
  const initial = loggedIn ? String(session.username || '?').slice(0, 1).toUpperCase() : '';
  const topRoleName = rbac.topRole?.name || '';

  const dropdown = effectiveOpen && loggedIn && typeof document !== 'undefined' ? createPortal((
    <>
      <div className="fixed inset-0 z-[125] bg-slate-900/30 sm:hidden" aria-hidden="true" data-account-menu-backdrop />
      <div
        ref={dropdownRef}
        role="dialog"
        aria-modal="false"
        aria-label="账户菜单"
        data-account-menu-panel
        className="fixed z-[130] max-h-[calc(100dvh-5rem)] w-[min(20rem,calc(100vw-1.5rem))] overflow-y-auto overscroll-contain rounded-2xl border border-slate-200 bg-white p-4 text-slate-900 shadow-xl"
        style={{ top: anchor?.top ?? 64, right: anchor?.right ?? 12 }}
        onClick={(event) => event.stopPropagation()}
      >
        {anchor?.arrowRight != null ? (
          <span
            aria-hidden="true"
            className="pointer-events-none fixed z-[131] h-3 w-3 rotate-45 border-l border-t border-slate-200 bg-white"
            style={{ top: anchor.top - 6, right: anchor.right + anchor.arrowRight }}
          />
        ) : null}
        <div className="space-y-3">
          <div className="flex items-center gap-3">
            <RoleAvatar topRole={rbac.topRole} initial={initial} size="lg" showChip />
            <div className="min-w-0">
              <div className="truncate text-sm font-bold text-slate-900">{session.username}</div>
              <div className="truncate text-xs text-slate-500">{topRoleName || '已登录'}</div>
            </div>
          </div>
          {rbac.roles?.length ? (
            <div>
              <div className="mb-1.5 text-[11px] font-semibold text-slate-400">我的角色</div>
              <RoleList roles={rbac.roles} />
            </div>
          ) : null}
          <LoginSyncPendingEntry onOpened={closeMenu} />
          <GettingStartedEntry loggedIn accessOf={(tab) => evaluateTabAccess(rbac, tab)} onOpened={closeMenu} />
          <PrivacyNotice variant="row" />
          <button
            type="button"
            className="inline-flex h-9 w-full items-center justify-center gap-2 rounded-xl border border-rose-200 bg-white text-xs font-bold text-rose-600 transition-colors hover:bg-rose-50"
            onClick={() => { handleLogout(); closeMenu(); }}
          >
            <LogOut className="h-4 w-4" aria-hidden="true" />
            退出登录
          </button>
        </div>
      </div>
    </>
  ), document.body) : null;

  return (
    <div className="relative ml-auto">
      {hideTrigger ? null : (
      <button
        type="button"
        data-account-trigger
        onClick={() => setOpen((value) => !value)}
        className={cx(
          'inline-flex h-8 items-center gap-2 rounded-full border px-2.5 text-xs font-bold shadow-sm transition-colors',
          loggedIn
            ? 'border-indigo-200 bg-indigo-50 text-indigo-700 hover:bg-indigo-100'
            : 'border-slate-200 bg-white text-slate-600 hover:border-indigo-200 hover:text-indigo-700'
        )}
        aria-label={loggedIn ? `账户：${session.username}` : '登录账户'}
      >
        <span className={cx(
          'inline-flex h-5 w-5 items-center justify-center rounded-full',
          loggedIn ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-500'
        )}>
          {loggedIn ? initial : <UserRound className="h-3.5 w-3.5" aria-hidden="true" />}
        </span>
        <span className="hidden max-w-[7rem] truncate sm:inline">{loggedIn ? session.username : '登录'}</span>
      </button>
      )}

      {dropdown}

      {effectiveOpen && !loggedIn && typeof document !== "undefined" ? createPortal((
        <div
          className="fixed inset-0 z-[120] flex items-end justify-center bg-slate-900/60 p-0 sm:items-center sm:p-4"
          onClick={() => closeMenu()}
        >
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby="account-auth-dialog-title"
            className="relative flex max-h-[95vh] w-full max-w-md flex-col overflow-hidden rounded-t-2xl bg-white shadow-2xl sm:max-h-[90vh] sm:rounded-2xl"
            onClick={(event) => event.stopPropagation()}
          >
            <div className="flex items-center justify-between gap-3 border-b border-slate-100 px-5 py-3.5">
              <div className="min-w-0">
                <div id="account-auth-dialog-title" className="text-sm font-bold text-slate-900">{authMode === 'register' ? '注册账户' : '账户登录'}</div>
                <div className="mt-0.5 truncate text-xs text-slate-500">登录后按变更自动同步</div>
              </div>
              <button
                type="button"
                onClick={() => closeMenu()}
                className="inline-flex h-8 w-8 items-center justify-center rounded-full text-slate-400 hover:bg-slate-100 hover:text-slate-700"
                aria-label="关闭"
              >
                <X className="h-4 w-4" />
              </button>
            </div>
            <div className="overflow-y-auto px-5 py-4 text-slate-900">
                <div className="space-y-3">
                  <div className="flex gap-1 rounded-xl bg-slate-100 p-1 text-xs font-semibold">
                    <button
                      type="button"
                      onClick={() => { setAuthError(''); setFormTouch({ touched: false, submitted: false }); setAuthMode('login'); }}
                      className={cx(
                        'flex-1 rounded-lg py-2 transition-colors',
                        authMode === 'login' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                      )}
                    >登录</button>
                    <button
                      type="button"
                      onClick={() => { setAuthError(''); setFormTouch({ touched: false, submitted: false }); setAuthMode('register'); }}
                      className={cx(
                        'flex-1 rounded-lg py-2 transition-colors',
                        authMode === 'register' ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
                      )}
                    >注册</button>
                  </div>
                  <div className="space-y-1.5 rounded-xl border border-indigo-100 bg-indigo-50/70 px-3 py-2.5 text-[11px] leading-5 text-indigo-900">
                    <p><span className="font-semibold">用户名 / 登录密码</span>用于账号保护及多设备云端自动同步。</p>
                  </div>
                  <PrivacyNotice compact />
                  <form className="space-y-3" onSubmit={handleAuthSubmit} noValidate aria-label={authMode === 'register' ? '注册表单' : '登录表单'}>
                  <div className="space-y-1.5">
                    <label htmlFor={authFields.username.id} className="block text-xs font-semibold text-slate-600">用户名</label>
                    <input className={inputClass} {...authFields.username} type="text" required value={form.username} onChange={(event) => updateField('username', event.target.value)} spellCheck="false" autoCapitalize="none" aria-invalid={authHint === '请填写用户名' ? 'true' : undefined} aria-describedby="account-auth-hint" />
                  </div>
                  <div className="space-y-1.5">
                    <label htmlFor={authFields.password.id} className="block text-xs font-semibold text-slate-600">登录密码</label>
                    <input className={inputClass} {...authFields.password} type="password" required value={form.password} onChange={(event) => updateField('password', event.target.value)} aria-invalid={authHint === '请填写登录密码' ? 'true' : undefined} aria-describedby="account-auth-hint" />
                  </div>
                  <label className="inline-flex items-center gap-2 text-xs font-semibold text-slate-600">
                    <input type="checkbox" checked={form.rememberDevice} onChange={(event) => updateField('rememberDevice', event.target.checked)} />
                    记住本设备
                  </label>
                  {authError ? (
                    <div
                      role="alert"
                      aria-live="assertive"
                      className="rounded-xl border border-red-100 bg-red-50 px-3 py-2 text-xs leading-5 text-red-600"
                    >
                      {authError}
                    </div>
                  ) : null}
                  <button
                    type="submit"
                    className={cx(primaryButtonClass, 'w-full justify-center')}
                    disabled={Boolean(busy)}
                    aria-busy={busy ? 'true' : undefined}
                  >
                    {busy === authMode ? <Loader2 className="h-4 w-4 animate-spin" /> : (authMode === 'register' ? <KeyRound className="h-4 w-4" /> : <UserRound className="h-4 w-4" />)}
                    {authMode === 'register' ? '注册并登录' : '登录'}
                  </button>
                  <div id="account-auth-hint" aria-live="polite" className={cx('text-xs', authHint ? 'text-amber-600' : 'sr-only')}>{authHint}</div>
                  </form>
                  <GettingStartedEntry loggedIn={false} accessOf={(tab) => evaluateTabAccess(rbac, tab)} variant="auth" onOpened={closeMenu} />
                </div>
            </div>
          </div>
        </div>
      ), document.body) : null}
    </div>
  );
}
