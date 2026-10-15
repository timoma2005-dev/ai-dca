import { HttpError } from '../authSession.js';
import { nowIso } from '../db.js';
import { normalizeBarkDeviceKey } from './barkChannel.js';
import { maskServerChan3SendKey } from './serverChan3Channel.js';
import { writeUserRecord } from './routes.js';
import { loadTestDeliverySettings } from './testDelivery.js';

export function normalizeBarkConfig(value = {}) {
  const input = typeof value === 'string' ? { deviceKey: value } : value || {};
  const deviceKey = normalizeBarkDeviceKey(input.deviceKey ?? input.barkDeviceKey ?? '');
  return { deviceKey, enabled: Boolean(deviceKey && input.enabled !== false) };
}

export function normalizeServerChan3Config(value = {}) {
  const input = value || {};
  const uid = String(input.uid || '').trim();
  const sendKey = String(input.sendKey || '').trim();
  return { uid, sendKey, enabled: Boolean(uid && sendKey && input.enabled !== false) };
}


export function readBark(db, account) {
  return normalizeBarkConfig(loadTestDeliverySettings(db, account).bark);
}

export function readServerChan3(db, account) {
  return normalizeServerChan3Config(loadTestDeliverySettings(db, account).serverChan3);
}

export function writeBark(db, account, config) {
  const value = normalizeBarkConfig(config);
  writeUserRecord(db, account, 'client-channel', `${account.clientId}::bark`,
    { barkDeviceKey: value.deviceKey, enabled: value.enabled }, nowIso());
}

export function writeServerChan3(db, account, config) {
  const { uid, sendKey, enabled } = normalizeServerChan3Config(config);
  writeUserRecord(db, account, 'client-channel', `${account.clientId}::serverchan3`,
    { serverChan3: { uid, sendKey }, enabled }, nowIso());
}

export function publicBark(config) {
  const value = normalizeBarkConfig(config);
  return { ...value, configured: Boolean(value.deviceKey) };
}

export function publicServerChan3(config) {
  const { uid, sendKey, enabled } = normalizeServerChan3Config(config);
  return { uid, sendKeyMasked: maskServerChan3SendKey(sendKey), configured: Boolean(uid && sendKey), enabled };
}

export function handleChannelToggle(db, account, channel, enable) {
  const bark = channel === 'bark';
  const current = bark ? readBark(db, account) : readServerChan3(db, account);
  if (enable && (bark ? !current.deviceKey : !(current.uid && current.sendKey))) {
    throw new HttpError(400, bark ? 'BARK_NOT_CONFIGURED' : 'SERVERCHAN3_NOT_CONFIGURED',
      bark ? '请先配置 Bark Device Key。' : '请先配置 Server酱 UID 和 SendKey。');
  }
  const value = { ...current, enabled: Boolean(enable) };
  if (bark) writeBark(db, account, value);
  else writeServerChan3(db, account, value);
  return { ok: true, [bark ? 'bark' : 'serverChan3']: bark ? publicBark(value) : publicServerChan3(value) };
}
