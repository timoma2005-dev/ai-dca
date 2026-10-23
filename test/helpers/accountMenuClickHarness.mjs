// 打包真实组件并执行 jsdom 点击流；调用方注入 JSDOM。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MessageChannel } from 'node:worker_threads';
import { rolldown } from 'rolldown';

const root = fileURLToPath(new URL('../../', import.meta.url));
const requireFromRoot = createRequire(join(root, 'package.json'));
const abs = (path) => JSON.stringify(join(root, path));
const roles = [
  ['superadmin', '超级管理员'], ['admin', '管理员'], ['svip', 'SVIP'], ['vip', 'VIP'],
  ['user', '普通用户'], ['guest', '游客'], ['auction_viewer', '竞价看板'],
].map(([code, name]) => ({ code, name, expiresAt: null }));
const rbac = {
  roles, topRole: roles[0], isAdmin: true, permVersion: 'account-click-superadmin',
  menus: [], perms: ['api:rbac-admin', 'api:rbac-grant-admin'],
};

export async function runAccountMenuClickChecks(JSDOM) {
  const dir = mkdtempSync(join(tmpdir(), 'account-menu-click-'));
  const dom = new JSDOM('<div id="root"></div>', { url: 'https://fast.example/home.html', pretendToBeVisual: true });
  const originals = new Map();
  // 打包后的 React act 使用 MessageChannel；记录并关闭端口，避免测试进程挂起。
  const channels = [];
  const globals = {
    window: dom.window, document: dom.window.document, navigator: dom.window.navigator,
    CustomEvent: dom.window.CustomEvent, Storage: dom.window.Storage, IS_REACT_ACT_ENVIRONMENT: true,
    MessageChannel: class extends MessageChannel {
      constructor() { super(); channels.push(this); }
    },
    fetch: async (input) => {
      const path = new URL(String(input), dom.window.location.href).pathname;
      const data = path.endsWith('/auth/me') ? rbac
        : path.endsWith('/migrations/legacy') ? { status: 'no-legacy', legacy: { exists: false } }
        : path.endsWith('/manifest') ? { resources: [] } : { keys: [], payload: {} };
      return new Response(JSON.stringify(data), { headers: { 'content-type': 'application/json' } });
    },
  };
  for (const [key, value] of Object.entries(globals)) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  let mod;
  try {
    const workspace = readFileSync(join(root, 'src/pages/WorkspacePage.jsx'), 'utf8');
    const listener = workspace.match(/useEffect\(\(\) => \{\s*function handleOpenAccountAuth\(\) \{[\s\S]*?\}, \[\]\);/)?.[0];
    assert.ok(listener, 'exercise the actual WorkspacePage account event listener');
    const entry = join(dir, 'entry.jsx');
    writeFileSync(entry, `
      import { createElement as h, Fragment, act, useEffect, useState } from ${JSON.stringify(requireFromRoot.resolve('react'))};
      import { createRoot } from ${JSON.stringify(requireFromRoot.resolve('react-dom/client'))};
      import { AccountMenu } from ${abs('src/components/account-menu.jsx')};
      import { BrandPreviewBar } from ${abs('src/components/brand-preview-bar.jsx')};
      import { ACCOUNT_AUTH_OPEN_EVENT } from ${abs('src/app/accountAuthEvents.js')};
      import { applyRbacPayload, __rbacStoreInternals } from ${abs('src/app/rbac/rbacStore.js')};
      const payload = ${JSON.stringify(rbac)};
      let mounted;
      export const errors = [];
      function Harness() {
        const [accountMenuOpen, setAccountMenuOpen] = useState(false);
        ${listener}
        return h(Fragment, null, h(BrandPreviewBar, { topRole: payload.topRole }),
          h(AccountMenu, { open: accountMenuOpen, onClose: () => setAccountMenuOpen(false), hideTrigger: true }));
      }
      export async function mount(legacy) {
        __rbacStoreInternals.reset();
        window.localStorage.clear();
        const session = { userId: 'usr_superadmin', username: 'lovexl', accessToken: 'acc_long_session', isAdmin: true };
        if (!legacy) Object.assign(session, payload);
        window.localStorage.setItem('aiDcaCloudSyncSession', JSON.stringify(session));
        if (!legacy) applyRbacPayload(payload, { session });
        mounted = createRoot(document.getElementById('root'), {
          onUncaughtError: (error) => errors.push(error), onCaughtError: (error) => errors.push(error),
          onRecoverableError: (error) => errors.push(error),
        });
        await act(async () => { mounted.render(h(Harness)); });
      }
      export async function click() {
        await act(async () => { document.querySelector('button[aria-label="账户"]').click(); });
      }
      export async function close() {
        await act(async () => { window.dispatchEvent(new window.KeyboardEvent('keydown', { key: 'Escape' })); });
      }
      export async function unmount() {
        if (mounted) await act(async () => { mounted.unmount(); mounted = null; });
      }
    `);
    const bundle = await rolldown({
      input: entry, platform: 'node', logLevel: 'silent',
      resolve: { alias: { '@': join(root, 'src') } },
      moduleTypes: { '.css': 'empty', '.jpg': 'empty', '.png': 'empty', '.svg': 'empty' },
      transform: { jsx: 'react-jsx', define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"development"' } },
    });
    const { output } = await bundle.generate({ format: 'esm' });
    await bundle.close();
    writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
    for (const item of output) writeFileSync(join(dir, item.fileName), item.type === 'chunk' ? item.code : item.source);
    const entryChunk = output.find((item) => item.type === 'chunk' && item.isEntry);
    mod = await import(pathToFileURL(join(dir, entryChunk.fileName)).href);
    const results = [];
    for (const legacy of [false, true]) {
      await mod.mount(legacy);
      assert.equal(document.querySelector('[role="dialog"]'), null);
      let events = 0;
      const count = () => { events += 1; };
      window.addEventListener('ai-dca:account-auth-open', count);
      await mod.click();
      assert.equal(events, 1, 'BrandPreviewBar emits the window event');
      const panel = document.querySelector('[role="dialog"]');
      assert.ok(panel, 'the controlled AccountMenu opens');
      assert.equal(document.querySelector('button[aria-label="账户：lovexl"]'), null, 'hideTrigger stays controlled by WorkspacePage');
      assert.match(panel.textContent, /lovexl/);
      assert.equal(panel.querySelectorAll('[aria-label="我的角色"] li').length, roles.length);
      for (const role of roles) assert.ok(panel.textContent.includes(role.name), `${role.code} renders`);
      assert.equal(panel.querySelector('[data-role-badge="shield"]').getAttribute('title'), '超级管理员');
      assert.deepEqual(mod.errors, [], 'no React render errors');
      await mod.close();
      assert.equal(document.querySelector('[role="dialog"]'), null, 'controlled close works');
      await mod.click();
      assert.ok(document.querySelector('[role="dialog"]'), 'the menu reopens');
      window.removeEventListener('ai-dca:account-auth-open', count);
      await mod.unmount();
      results.push(`${legacy ? 'legacy session without RBAC cache' : 'cached full superadmin role chain'}: click → event → panel, close/reopen OK`);
    }
    return results;
  } finally {
    try {
      await mod?.unmount();
    } finally {
      dom.window.close();
      for (const channel of channels) { channel.port1.close(); channel.port2.close(); }
      for (const [key, descriptor] of originals) {
        if (descriptor) Object.defineProperty(globalThis, key, descriptor);
        else delete globalThis[key];
      }
      rmSync(dir, { recursive: true, force: true });
    }
  }
}
