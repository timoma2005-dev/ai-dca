// cn-data port of workers/account/src/userNotice.js. The worker stored the
// notice on users table columns; cn-data has no users table, so the notice
// lives in account_data_notices (created by migrations/002-account-v1.sql).
// Rows are keyed by user_id and upserted on write.

export const ACCOUNT_DATA_NOTICE_VERSION = 'plain-resource-sync-v1';
export const ACCOUNT_DATA_NOTICE_CHOICES = Object.freeze([
  'migrate',
  'clear',
  'source',
  'continue'
]);

const NOTICE_CHOICE_SET = new Set(ACCOUNT_DATA_NOTICE_CHOICES);

export function normalizeAccountDataNotice(row = {}) {
  const noticeVersion = String(row?.noticeVersion ?? row?.notice_version ?? '');
  const choice = String(row?.choice ?? '');
  const updatedAt = String(row?.updatedAt ?? row?.updated_at ?? '');
  return {
    noticeVersion,
    choice: NOTICE_CHOICE_SET.has(choice) ? choice : '',
    updatedAt
  };
}

export function readAccountDataNotice(db, userId) {
  const row = db
    .prepare(`SELECT
      notice_version AS noticeVersion,
      choice AS choice,
      updated_at AS updatedAt
      FROM account_data_notices WHERE user_id = ?`)
    .get(String(userId || ''));
  return normalizeAccountDataNotice(row || {});
}

export function writeAccountDataNotice(db, userId, { noticeVersion = ACCOUNT_DATA_NOTICE_VERSION, choice, updatedAt = '' } = {}) {
  const normalizedChoice = String(choice || '').trim().toLowerCase();
  if (!NOTICE_CHOICE_SET.has(normalizedChoice)) {
    const error = new Error('通知选择不合法');
    error.code = 'INVALID_NOTICE_CHOICE';
    throw error;
  }
  const normalizedVersion = String(noticeVersion || '').trim().slice(0, 80);
  if (!normalizedVersion) {
    const error = new Error('通知版本不能为空');
    error.code = 'NOTICE_VERSION_REQUIRED';
    throw error;
  }
  const timestamp = String(updatedAt || new Date().toISOString());
  db.prepare(`INSERT INTO account_data_notices (user_id, notice_version, choice, updated_at)
    VALUES (?, ?, ?, ?)
    ON CONFLICT(user_id) DO UPDATE SET
      notice_version = excluded.notice_version,
      choice = excluded.choice,
      updated_at = excluded.updated_at`)
    .run(String(userId || ''), normalizedVersion, normalizedChoice, timestamp);
  return {
    noticeVersion: normalizedVersion,
    choice: normalizedChoice,
    updatedAt: timestamp
  };
}
