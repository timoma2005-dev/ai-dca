import { receiveSync, required, dataOf, invalid, collectWrites } from '../../shared/internalSync.js';
import { ensureSchema, writeResource } from './store.js';
import { getResourceDescriptor } from './catalog.js';
import { ensureTransactionSchema, writeTransactionRow, deleteTransactionRow } from './transactions.js';

export async function handleInternalAccountSync(request, env, origin = '*') {
  return receiveSync(request, env, 'DB', ['upsert-transaction', 'delete-transaction', 'upsert-resource'], async ({ eventType, payload: p }) => {
    const user = required(p.user_id, 'user_id');
    await ensureSchema(env);
    await ensureTransactionSchema(env);
    const end = { id: p.updated_by_end_id || '', type: p.updated_by_end_type || '' };
    if (eventType === 'upsert-resource') {
      const descriptor = getResourceDescriptor(required(p.resource, 'resource'));
      if (!descriptor) invalid('Unknown resource');
      const collected = collectWrites(env.DB);
      await writeResource({ ...env, DB: collected.db }, user, descriptor, { data: dataOf(p, 'resource_data'), deleted: Boolean(p.deleted), force: true, end });
      return collected;
    }
    const id = required(p.transaction_id, 'transaction_id');
    // Transaction helpers rebuild the manifest from rows after their writes.
    // Supply the incoming row to that read while collecting the atomic batch.
    const collected = collectWrites(env.DB);
    const db = collected.db;
    const prepare = db.prepare.bind(db);
    const deleting = eventType === 'delete-transaction' || Boolean(p.deleted);
    const data = deleting ? null : dataOf(p, 'transaction_data');
    db.prepare = sql => {
      const statement = prepare(sql);
      if (sql.includes('FROM account_holdings_transactions WHERE user_id = ? AND deleted = 0 ORDER BY')) {
        const bind = statement.bind;
        statement.bind = (...args) => {
          const bound = bind(...args);
          const all = bound.all;
          bound.all = async () => {
            const result = await all();
            const rows = (result.results || []).filter(row => row.transaction_id !== id);
            if (!deleting) rows.push({ transaction_id: id, payload: JSON.stringify({ ...data, id }), deleted: 0 });
            return { ...result, results: rows };
          };
          return bound;
        };
      }
      return statement;
    };
    const target = { ...env, DB: db };
    const result = deleting ? await deleteTransactionRow(target, user, id, { force: true, end }) : await writeTransactionRow(target, user, id, data, { force: true, end });
    if (result.invalid) invalid(result.code);
    return collected;
  }, origin);
}
