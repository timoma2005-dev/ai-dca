import { resolveFundCompany } from '../fundCompany.js';
import { getTransactionAmount } from '../holdingsLedgerCore.js';

// Preserve the input order, including the order of each company's latest trade.
export function groupTransactionsByCompany(rows) {
  const groups = new Map();
  for (const tx of rows) {
    const name = resolveFundCompany(tx.name || tx.code).name;
    if (!groups.has(name)) {
      groups.set(name, { key: name, name, rows: [], buyCount: 0, sellCount: 0, buyAmount: 0, sellAmount: 0 });
    }
    const group = groups.get(name);
    group.rows.push(tx);
    const amount = getTransactionAmount(tx);
    if (tx.type === 'BUY' || tx.type === 'SELL') {
      const prefix = tx.type === 'BUY' ? 'buy' : 'sell';
      group[prefix + 'Count'] += 1;
      if (Number.isFinite(amount) && amount > 0) group[prefix + 'Amount'] += amount;
    }
  }
  return [...groups.values()];
}
