export const HOLDINGS_GROUP_MODE_KEY = 'holdings.holdingsGroupMode';
export const TRANSACTIONS_GROUP_MODE_KEY = 'income.transactionsGroupMode';

export function createGroupModeStore(key, getWindow = () => globalThis.window) {
  const listeners = new Set();
  let fallback = 'company';
  const read = () => {
    try {
      const value = getWindow()?.localStorage.getItem(key);
      return value === 'list' ? 'list' : 'company';
    } catch {
      return fallback;
    }
  };
  const notify = () => listeners.forEach((listener) => listener());
  const onStorage = (event) => {
    if (event.key === key || event.key === null) notify();
  };
  return {
    getSnapshot: read,
    subscribe(listener) {
      if (!listeners.size) getWindow()?.addEventListener('storage', onStorage);
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
        if (!listeners.size) getWindow()?.removeEventListener('storage', onStorage);
      };
    },
    setMode(value) {
      fallback = value === 'list' ? 'list' : 'company';
      try {
        getWindow()?.localStorage.setItem(key, fallback);
      } catch { /* Keep the choice usable when storage is unavailable. */ }
      notify();
    },
  };
}

export const holdingsGroupModeStore = createGroupModeStore(HOLDINGS_GROUP_MODE_KEY);
export const transactionsGroupModeStore = createGroupModeStore(TRANSACTIONS_GROUP_MODE_KEY);
