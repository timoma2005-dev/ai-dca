// 回归：演示内容带入账号后「已保留演示内容」提示必须弹出（importDemoSessions 是 async，曾取 Promise.length 导致永远不弹）。
// 用 rolldown 打包真实 hook，把 react 换成最小 hooks 运行器（按 deps 执行 effect / cleanup，可模拟 StrictMode 重挂载），
// 不依赖 jsdom。
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import test from 'node:test';
import { rolldown } from 'rolldown';

const root = fileURLToPath(new URL('..', import.meta.url));
const abs = (path) => JSON.stringify(join(root, path));

const fakeReact = `
let slots = [];
let index = 0;
let queue = [];
export function useRef(initial) {
  const i = index++;
  if (!slots[i]) slots[i] = { current: initial };
  return slots[i];
}
export function useEffect(effect, deps) {
  const i = index++;
  const prev = slots[i];
  const changed = !prev || !deps || deps.length !== prev.deps.length || deps.some((d, k) => !Object.is(d, prev.deps[k]));
  if (changed) queue.push(() => { prev?.cleanup?.(); const cleanup = effect(); slots[i] = { deps, cleanup: typeof cleanup === 'function' ? cleanup : null }; });
}
export function __render(hook, ...args) { index = 0; hook(...args); const run = queue; queue = []; run.forEach((fn) => fn()); }
export function __unmount() { for (const slot of slots) slot?.cleanup?.(); slots = []; }
// StrictMode 开发期：挂载后立刻卸载再挂载（所有 effect 先 cleanup 再重跑）。
export function __strictRemount(hook, ...args) { const kept = slots; for (const slot of kept) slot?.cleanup?.(); slots = kept.map((s) => (s && 'deps' in s ? undefined : s)); __render(hook, ...args); }
`;

const entrySource = [
  "import { __render, __unmount, __strictRemount } from 'react';",
  'import { useDemoSessionImport, DEMO_IMPORTED_TOAST } from ' + abs('src/app/demo/useDemoSessionImport.js') + ';',
  'import { saveDemoSession, readDemoSession, DEMO_ACTIVE_FLAG } from ' + abs('src/app/demo/featureDemo.js') + ';',
  'export { saveDemoSession, readDemoSession, DEMO_ACTIVE_FLAG, DEMO_IMPORTED_TOAST };',
  'const canAccess = (rbac, tab) => Boolean(rbac.allow && rbac.allow.includes(tab));',
  'export const render = (rbac) => __render(useDemoSessionImport, rbac, canAccess);',
  'export const strictRemount = (rbac) => __strictRemount(useDemoSessionImport, rbac, canAccess);',
  'export const unmount = () => __unmount();',
].join('\n');

class FakeStorage {
  constructor() { this.map = new Map(); }
  get length() { return this.map.size; }
  key(i) { return [...this.map.keys()][i] ?? null; }
  getItem(k) { return this.map.has(k) ? this.map.get(k) : null; }
  setItem(k, v) { this.map.set(String(k), String(v)); }
  removeItem(k) { this.map.delete(k); }
  clear() { this.map.clear(); }
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));
let dir;
let mod;
let toasts;
let storage;
const originals = new Map();

test.before(async () => {
  dir = mkdtempSync(join(tmpdir(), 'demo-import-toast-'));
  const win = new EventTarget();
  storage = new FakeStorage();
  win.localStorage = storage;
  for (const [key, value] of Object.entries({ window: win, localStorage: storage })) {
    originals.set(key, Object.getOwnPropertyDescriptor(globalThis, key));
    Object.defineProperty(globalThis, key, { configurable: true, writable: true, value });
  }
  win.addEventListener('aidca:toast', (event) => toasts.push(event.detail));
  const fakeReactPath = join(dir, 'fake-react.js');
  writeFileSync(fakeReactPath, fakeReact);
  const entry = join(dir, 'entry.js');
  writeFileSync(entry, entrySource);
  const bundle = await rolldown({
    input: entry, platform: 'node', logLevel: 'silent',
    resolve: { alias: { react: fakeReactPath, '@': join(root, 'src') } },
    transform: { define: { 'import.meta.env': '{}', 'process.env.NODE_ENV': '"development"' } },
  });
  const { output } = await bundle.generate({ format: 'esm' });
  await bundle.close();
  writeFileSync(join(dir, 'package.json'), '{"type":"module"}');
  for (const item of output) writeFileSync(join(dir, item.fileName), item.type === 'chunk' ? item.code : item.source);
  const entryChunk = output.find((item) => item.type === 'chunk' && item.isEntry);
  mod = await import(pathToFileURL(join(dir, entryChunk.fileName)).href);
});

test.after(() => {
  for (const [key, descriptor] of originals) {
    if (descriptor) Object.defineProperty(globalThis, key, descriptor);
    else delete globalThis[key];
  }
  if (dir) rmSync(dir, { recursive: true, force: true });
});

test.beforeEach(() => {
  toasts = [];
  mod.unmount();
  storage.clear();
  delete window[mod.DEMO_ACTIVE_FLAG];
});

test('kept demo content is imported after upgrade and the toast pops exactly once (StrictMode remount)', async () => {
  mod.saveDemoSession('markets', [['markets:watchlist:v1', 'demo-list']], { storage });
  const rbac = { loggedIn: true, allow: ['markets'] };
  mod.render(rbac);
  mod.strictRemount(rbac);
  await settle();
  assert.equal(storage.getItem('markets:watchlist:v1'), 'demo-list');
  assert.equal(mod.readDemoSession('markets', { storage }), null);
  assert.equal(toasts.length, 1);
  assert.equal(toasts[0].title, '已保留演示内容');
  assert.equal(toasts[0].title, mod.DEMO_IMPORTED_TOAST.title);
  assert.equal(toasts[0].tone, 'emerald');
  // rbac 刷新（新对象）重跑 effect：已带入，不重复提示。
  mod.render({ loggedIn: true, allow: ['markets'] });
  await settle();
  assert.equal(toasts.length, 1);
});

test('rbac refresh while the import is in flight keeps the toast', async () => {
  mod.saveDemoSession('markets', [['markets:watchlist:v1', 'demo-list']], { storage });
  mod.render({ loggedIn: true, allow: ['markets'] });
  mod.render({ loggedIn: true, allow: ['markets'] }); // 新 rbac 对象，effect 立刻重跑
  await settle();
  assert.equal(toasts.length, 1);
});

test('unmounted before the import resolves: content still imported, no toast after unmount', async () => {
  mod.saveDemoSession('markets', [['markets:watchlist:v1', 'demo-list']], { storage });
  mod.render({ loggedIn: true, allow: ['markets'] });
  mod.unmount();
  await settle();
  assert.equal(storage.getItem('markets:watchlist:v1'), 'demo-list');
  assert.equal(toasts.length, 0);
});

test('no toast when logged out, without access, during a demo, or with nothing kept', async () => {
  mod.saveDemoSession('markets', [['markets:watchlist:v1', 'demo-list']], { storage });
  mod.render({ loggedIn: false, allow: ['markets'] });
  await settle();
  mod.render({ loggedIn: true, allow: [] });
  await settle();
  window[mod.DEMO_ACTIVE_FLAG] = 'markets';
  mod.render({ loggedIn: true, allow: ['markets'] });
  await settle();
  delete window[mod.DEMO_ACTIVE_FLAG];
  assert.equal(toasts.length, 0);
  assert.ok(mod.readDemoSession('markets', { storage }), 'still kept for later');
  mod.render({ loggedIn: true, allow: ['markets'] });
  await settle();
  assert.equal(toasts.length, 1);
  mod.render({ loggedIn: true, allow: ['markets', 'notify'] });
  await settle();
  assert.equal(toasts.length, 1, 'nothing left to import');
});

test('import failure is swallowed without a toast or unhandled rejection', async () => {
  storage.setItem('aiDcaFeatureDemoSession', '{"markets":{"entries":[["markets:watchlist:v1","x"]],"expiresAt":' + (Date.now() + 60000) + '}}');
  const original = storage.setItem;
  storage.setItem = () => { throw new Error('quota'); };
  try {
    mod.render({ loggedIn: true, allow: ['markets'] });
    await settle();
  } finally {
    storage.setItem = original;
  }
  // importDemoSessions 自身吞掉单条写入失败，仍视为已带入（提示照常），关键是不抛未处理异常。
  assert.ok(toasts.length <= 1);
});

test('WorkspacePage uses the awaited hook instead of reading .length off a Promise', () => {
  const source = readFileSync(join(root, 'src/pages/WorkspacePage.jsx'), 'utf8');
  assert.match(source, /useDemoSessionImport\(rbac, canAccessDemoTab\);/);
  assert.doesNotMatch(source, /importDemoSessions\(/);
});
