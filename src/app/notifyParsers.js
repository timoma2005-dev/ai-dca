export function parseBarkInput(input = '') {
  const value = String(input || '').trim();
  if (!value) return '';

  try {
    const url = new URL(value);
    if (String(url.hostname || '').toLowerCase() === 'api.day.app') {
      return decodeURIComponent(url.pathname.split('/').filter(Boolean)[0] || '').trim();
    }
  } catch {
    // Not a full URL; fall through to regex extraction.
  }

  const match = value.match(/api\.day\.app\/([^\s/?#]+)/i);
  if (match) {
    return decodeURIComponent(match[1]).trim();
  }

  return value;
}

export function normalizeBarkDeviceKey(input = '') {
  try {
    const key = parseBarkInput(input);
    return /^[A-Za-z0-9_-]{8,128}$/.test(key) ? key : '';
  } catch {
    return '';
  }
}

export function parseNotifyInput(input = '', platform = 'ios') {
  return parseBarkInput(input);
}
