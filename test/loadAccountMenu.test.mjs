import assert from 'node:assert/strict';
import { test } from 'node:test';
import { ACCOUNT_MENU_RELOAD_KEY, loadAccountMenu } from '../src/app/loadAccountMenu.js';

function browserOptions() {
  const items = new Map();
  let reloads = 0;
  return {
    get reloads() { return reloads; },
    items,
    getSessionStorage: () => ({
      getItem: (key) => items.get(key) ?? null,
      setItem: (key, value) => items.set(key, value),
    }),
    reload: () => {
      assert.equal(items.get(ACCOUNT_MENU_RELOAD_KEY), '1', 'mark the session before reloading');
      reloads += 1;
    },
  };
}

test('AccountMenu imports successfully without retrying or marking the session', async () => {
  const options = browserOptions();
  const module = { AccountMenu() {} };
  let attempts = 0;
  assert.equal(await loadAccountMenu(async () => { attempts += 1; return module; }, options), module);
  assert.equal(attempts, 1);
  assert.equal(options.reloads, 0);
  assert.equal(options.items.size, 0);
});

test('AccountMenu retries one failed import and recovers without reloading', async () => {
  const options = browserOptions();
  const module = { AccountMenu() {} };
  let attempts = 0;
  const result = await loadAccountMenu(async () => {
    attempts += 1;
    if (attempts === 1) throw new TypeError('Failed to fetch dynamically imported module');
    return module;
  }, options);
  assert.equal(result, module);
  assert.equal(attempts, 2);
  assert.equal(options.reloads, 0);
  assert.equal(options.items.size, 0);
});

test('continuous AccountMenu failures reload only once, including after a page reload', async () => {
  const options = browserOptions();
  let attempts = 0;
  const error = new TypeError('account chunk is unavailable');
  const fail = async () => { attempts += 1; throw error; };
  await assert.rejects(loadAccountMenu(fail, options), (caught) => caught === error);
  assert.equal(attempts, 2);
  assert.equal(options.reloads, 1);
  // Reload the helper module too: only sessionStorage survives a full page reload.
  const { loadAccountMenu: afterPageReload } = await import('../src/app/loadAccountMenu.js?after-page-reload');
  await assert.rejects(afterPageReload(fail, options), (caught) => caught === error);
  assert.equal(attempts, 4);
  assert.equal(options.reloads, 1);
  await afterPageReload(async () => ({ AccountMenu() {} }), options);
  await assert.rejects(afterPageReload(fail, options), (caught) => caught === error);
  assert.equal(attempts, 6);
  assert.equal(options.reloads, 1, 'a successful import must not reset the session guard');
});

test('AccountMenu preserves the retry error if automatic reload is unavailable', async (t) => {
  const denied = () => { throw new Error('storage denied'); };
  const cases = {
    'missing sessionStorage': () => null,
    'sessionStorage getter throws': denied,
    'sessionStorage read throws': () => ({ getItem: denied }),
    'sessionStorage write throws': () => ({ getItem: () => null, setItem: denied }),
  };
  for (const [name, getSessionStorage] of Object.entries(cases)) {
    await t.test(name, async () => {
      const error = new Error('second import failed');
      let attempts = 0;
      let reloads = 0;
      await assert.rejects(loadAccountMenu(async () => {
        attempts += 1;
        throw attempts === 1 ? new Error('first import failed') : error;
      }, { getSessionStorage, reload: () => { reloads += 1; } }), (caught) => caught === error);
      assert.equal(attempts, 2);
      assert.equal(reloads, 0, 'do not reload without a persistent loop guard');
    });
  }
});

test('AccountMenu preserves the import error when reload itself throws', async () => {
  const options = browserOptions();
  const error = new Error('import failed');
  await assert.rejects(loadAccountMenu(async () => { throw error; }, {
    ...options,
    reload: () => { throw new Error('reload blocked'); },
  }), (caught) => caught === error);
  assert.equal(options.items.get(ACCOUNT_MENU_RELOAD_KEY), '1');
});
