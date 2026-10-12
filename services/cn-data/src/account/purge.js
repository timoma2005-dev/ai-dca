// cn-data port of workers/account/src/purge.js. The worker also purged the
// sync worker's backups table and the SYNC_BACKUPS KV copy; cn-data's
// equivalent legacy envelope is sync_backups, and there is no KV copy here
// (kvDeleted is always false, reported for response-shape parity).

export const ACCOUNT_PURGE_CONFIRMATION = 'DELETE_ALL_SYNC_DATA';

const PURGE_TABLES = [
  'account_resource_history',
  'account_resources',
  'account_holdings_transactions',
  'account_holdings_transaction_meta',
  'account_holdings_transaction_history',
  'account_resource_records',
  'account_migrations',
  'sync_backups'
];

export function purgeAccountData(db, userId) {
  const id = String(userId || '').trim();
  if (!id) throw new Error('缺少用户标识');
  const kvKey = `backup:${id}`;
  const tableChanges = {};
  for (const table of PURGE_TABLES) {
    const result = db.prepare(`DELETE FROM ${table} WHERE user_id = ?`).run(id);
    tableChanges[table] = Number(result?.changes || 0);
  }
  return {
    kvKey,
    kvDeleted: false,
    tableChanges,
    deletedRows: Object.values(tableChanges).reduce((sum, count) => sum + count, 0)
  };
}
