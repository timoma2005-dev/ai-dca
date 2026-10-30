// 溢价日报页（/daily.html）的轻量登录 / 注册弹窗：复用 authClient 的登录注册逻辑，
// 成功后带到通知管理页。不挂 React，避免日报页变重。
import { loadCloudSession, loginCloudAccount, registerCloudAccount } from './app/authClient.js';
import { trackFeatureEvent } from './app/analytics.js';

const CSS = `
.da-mask{position:fixed;inset:0;z-index:50;background:rgba(15,23,42,.45);display:flex;align-items:center;justify-content:center;padding:16px}
.da-box{width:100%;max-width:380px;background:#fff;border-radius:16px;padding:20px;box-shadow:0 20px 50px rgba(15,23,42,.25);font:14px/1.5 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;color:#0f172a}
.da-hd{display:flex;justify-content:space-between;align-items:flex-start;gap:8px}
.da-hd b{font-size:17px}.da-hd small{display:block;color:#64748b;font-size:12px;margin-top:2px}
.da-x{border:0;background:transparent;font-size:22px;line-height:1;color:#94a3b8;cursor:pointer}
.da-tabs{display:flex;background:#f1f5f9;border-radius:10px;padding:3px;margin:14px 0 12px}
.da-tabs button{flex:1;border:0;background:transparent;padding:7px 0;border-radius:8px;font:inherit;color:#64748b;cursor:pointer}
.da-tabs button.on{background:#fff;color:#0f172a;font-weight:600;box-shadow:0 1px 2px rgba(0,0,0,.06)}
.da-f label{display:block;font-size:12px;color:#475569;margin:10px 0 4px}
.da-f input{width:100%;box-sizing:border-box;height:42px;border:1px solid #e2e8f0;border-radius:10px;padding:0 12px;font:inherit}
.da-f input:focus{outline:none;border-color:#6366f1;box-shadow:0 0 0 3px #eef2ff}
.da-gift{margin-top:10px;font-size:12px;color:#4338ca;background:#eef2ff;border-radius:8px;padding:6px 10px}
.da-err{margin-top:10px;font-size:12px;color:#dc2626;min-height:0}
.da-go{width:100%;height:44px;margin-top:14px;border:0;border-radius:999px;background:#4f46e5;color:#fff;font:inherit;font-weight:700;cursor:pointer}
.da-go:disabled{opacity:.6;cursor:default}
`;

let root = null;
let mode = 'register';
let opts = {};

function el(html) { const d = document.createElement('div'); d.innerHTML = html.trim(); return d.firstChild; }

function render() {
  const reg = mode === 'register';
  root.querySelector('[data-t="register"]').classList.toggle('on', reg);
  root.querySelector('[data-t="login"]').classList.toggle('on', !reg);
  root.querySelector('.da-gift').style.display = reg ? '' : 'none';
  root.querySelector('#da-pw').placeholder = reg ? '至少 8 位' : '输入登录密码';
  root.querySelector('#da-pw').autocomplete = reg ? 'new-password' : 'current-password';
  root.querySelector('.da-go').textContent = reg ? '注册并开启提醒' : '登录并开启提醒';
  root.querySelector('.da-err').textContent = '';
}

function close() { if (root) root.style.display = 'none'; }

async function submit(ev) {
  ev.preventDefault();
  const btn = root.querySelector('.da-go');
  const err = root.querySelector('.da-err');
  const username = root.querySelector('#da-user').value;
  const password = root.querySelector('#da-pw').value;
  err.textContent = '';
  btn.disabled = true;
  try {
    if (mode === 'register') await registerCloudAccount({ username, password });
    else await loginCloudAccount({ username, password });
    try { trackFeatureEvent('conversion', mode === 'register' ? 'register_success' : 'login_success', { trigger: 'daily_page' }); } catch { /* ignore */ }
    btn.textContent = '已登录，正在打开提醒设置…';
    // 留一点时间让登录后的后台同步完成首个写入（门禁标记已同步写入本地）。
    setTimeout(() => { window.location.assign(opts.next || '/home.html?tab=notify'); }, 400);
  } catch (e) {
    err.textContent = e?.message || '操作失败，请稍后重试';
    btn.disabled = false;
  }
}

function build() {
  const style = document.createElement('style');
  style.textContent = CSS;
  document.head.appendChild(style);
  root = el(`<div class="da-mask" role="dialog" aria-modal="true" aria-label="登录开启提醒">
  <form class="da-box da-f" novalidate>
    <div class="da-hd"><div><b>开启溢价提醒</b><small>登录后可配置 Bark、Server酱、邮件推送</small></div><button type="button" class="da-x" aria-label="关闭">×</button></div>
    <div class="da-tabs"><button type="button" data-t="register">注册</button><button type="button" data-t="login">登录</button></div>
    <label for="da-user">用户名</label><input id="da-user" autocomplete="username" autocapitalize="off" spellcheck="false" placeholder="至少 3 位" />
    <label for="da-pw">登录密码</label><input id="da-pw" type="password" />
    <div class="da-gift">新用户免费注册，送 3 个月 VIP</div>
    <div class="da-err" role="alert"></div>
    <button type="submit" class="da-go">注册并开启提醒</button>
  </form></div>`);
  root.addEventListener('click', (e) => { if (e.target === root) close(); });
  root.querySelector('.da-x').addEventListener('click', close);
  root.querySelectorAll('[data-t]').forEach((b) => b.addEventListener('click', () => { mode = b.getAttribute('data-t'); render(); }));
  root.querySelector('form').addEventListener('submit', submit);
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  document.body.appendChild(root);
}

window.__aiDcaDailyAuth = {
  loggedIn: () => Boolean(loadCloudSession()?.accessToken),
  open(o = {}) {
    opts = o;
    if (!root) build();
    mode = o.mode === 'login' ? 'login' : 'register';
    render();
    root.style.display = '';
    setTimeout(() => root.querySelector('#da-user').focus(), 30);
    try { trackFeatureEvent('conversion', 'prompt_view', { trigger: 'daily_page' }); } catch { /* ignore */ }
  }
};
