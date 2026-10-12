# Plan: Fix React #185 Infinite Loop on Logout (holdings page)

## Problem Summary

After logging out on the holdings page (`home.html?tab=holdings`), the app throws
`Minified React error #185` ("Maximum update depth exceeded"). The page becomes
unresponsive. The error does NOT occur on fresh logged-out page load, only during
the login → logout state transition.

## Root Cause

**File:** `src/app/holdingsRemoteSource.js`, in `refresh()`, logged-out branch.

```js
if (!session?.accessToken) {
  // 未登录时直接使用本地数据
  setLedger({ ...readLedgerState(), remoteLoading: false });  // ← always a NEW object
  setAccountSettings(readAccountAllocationSettings());
  setTradeLedgerEntries(readTradeLedger());
  return 'local';
}
```

The object spread `{ ...readLedgerState(), remoteLoading: false }` **always creates a new
reference**, even when the ledger content is byte-identical to current React state.

Loop chain (`persist → event → persist`):

1. Logout → `CLOUD_SYNC_SESSION_EVENT` → `useHoldingsStorageSync.onSessionChanged()`
   → `refreshFromCurrentSource()` → `source.refresh()`.
2. `source.refresh()` logged-out branch calls `setLedger(newObject)` — new reference
   every time.
3. New ledger object triggers `useEffect` in `src/pages/HoldingsExperience.jsx`:
   ```js
   useEffect(() => {
     if (remoteMode && !remoteReady) return;
     persistLedgerState(ledger);
   }, [ledger, remoteMode, remoteReady]);
   ```
4. `persistLedgerState` (`src/app/holdingsLedger.js`) writes to localStorage then
   **synchronously dispatches** the `holdings:ledger-updated` CustomEvent with
   `source: 'local-ledger'`.
5. `onLedgerUpdated` (`src/pages/holdings/useHoldingsStorageSync.js`) receives it.
   The logged-in branch has an `areHoldingTransactionsEqual` guard that returns the
   previous state reference when content is identical (the code comment even warns:
   "相同内容必须保持原 state 引用，否则会形成 persist -> event -> persist 循环").
   The logged-out path has **no such guard** — it falls through to bare
   `refresh(event)` → `source.refresh()` → back to step 2. Infinite loop.

The Radix Dialog frames in the stack trace are collateral damage — React throws #185
during whatever render happened to be in flight, not the cause.

## Fix Design

Modify the logged-out branch in `src/app/holdingsRemoteSource.js` to use the
functional `setLedger` form with the existing `areHoldingTransactionsEqual` guard
(same pattern as the logged-in path in `useHoldingsStorageSync.js` and the existing
`applyLedgerTransactions` helper in the same file):

```js
if (!session?.accessToken) {
  // 未登录时直接使用本地数据；内容无变化时保持原 state 引用，
  // 否则会触发 persist -> event -> persist 无限循环（React #185）。
  const localLedger = readLedgerState();
  setLedger((previous) => {
    if (areHoldingTransactionsEqual(previous?.transactions, localLedger?.transactions)) {
      if (previous?.remoteLoading === false) return previous;
      return { ...previous, remoteLoading: false };
    }
    return normalizeLedgerState({ ...localLedger, remoteLoading: false });
  });
  setAccountSettings(readAccountAllocationSettings());
  setTradeLedgerEntries(readTradeLedger());
  return 'local';
}
```

Notes:
- `areHoldingTransactionsEqual` and `normalizeLedgerState` are already imported in
  this file (used by `applyLedgerTransactions`).
- `setAccountSettings` / `setTradeLedgerEntries` set plain values read from storage;
  they do not go through the persist→event→refresh cycle (only `ledger` has the
  `useEffect` → `persistLedgerState` → event wiring), so they need no guard. If
  review finds otherwise, apply the same reference-stability pattern.
- Do NOT change the logged-in path, the event wiring, or `persistLedgerState`.

## Test Plan

Add a regression test (e.g. `test/holdingsRemoteSourceLogoutLoop.test.mjs`) that:

1. Mocks `loadCloudSession()` to return null (logged out).
2. Seeds localStorage ledger state via the real `holdingsLedger` read/write helpers.
3. Creates the remote source with a `setLedger` mock that applies functional updates
   against a local variable (mimicking React useState).
4. Calls `refresh()` twice.
5. Asserts the ledger object reference is **identical** (`===`) after the second
   refresh — i.e. no new object was minted when content did not change.
6. Asserts a changed localStorage ledger DOES produce a new reference (guard does
   not over-suppress legitimate updates).

Follow existing test conventions in `test/` (node:test, `.mjs`).

## Verification Steps

1. `npm run test:unit` (or the relevant test command) — new test passes, no regressions.
2. `npm run check:refactor` — passes (per repo AGENTS.md).
3. `npm run lint -- --quiet` — passes.
4. `git diff --check` — clean.
5. `git fetch origin && git rev-parse origin/cn` — confirm remote SHA before push;
   rebase or merge if diverged (no reset --hard, no force push).
6. Deploy via `scripts/deploy-unified.sh` (do NOT deploy manually).
7. Accept on `https://fast.freebacktrack.tech` only (never `cn.freebacktrack.tech:5000`):
   log in, go to holdings tab, log out — no React #185, page stays responsive.

## Risks

- **Low.** The change only affects the logged-out branch; logged-in behavior untouched.
- The guard uses the same `areHoldingTransactionsEqual` already trusted by the
  logged-in path. Edge case: if `readLedgerState()` returns malformed data, the
  guard falls back to creating a new normalized object — same as current behavior.
- If `previous` is undefined on first call, `previous?.transactions` is undefined
  and the guard correctly treats it as "not equal", producing a fresh object.
