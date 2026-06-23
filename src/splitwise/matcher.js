import api from '@actual-app/api';

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

function isTransfer(txn) {
  return Boolean(txn.transfer_id);
}

function isExistingSplitwise(txn) {
  return /\[Splitwise/.test(txn.notes || '');
}

function isEligible(txn, { allowTransfers = false } = {}) {
  if (txn.reconciled) return false;
  if (txn.is_child) return false;
  if (txn.is_parent && !/\[Splitwise pending\]/.test(txn.notes || '')) return false;
  if (isExistingSplitwise(txn) && !/\[Splitwise pending\]/.test(txn.notes || '')) return false;
  if (!allowTransfers && isTransfer(txn)) return false;
  return true;
}

function targetAmountFor(amountCents) {
  // Actual stores outflows as negative and inflows as positive.
  return amountCents > 0 ? -amountCents : Math.abs(amountCents);
}

/**
 * Search for bank transactions matching an amount.
 *
 * @param {number} amountCents - positive for outflows, negative for inflows
 * @param {string} date - YYYY-MM-DD
 * @param {string[]} accountIds - Actual account IDs to search
 * @param {{ windowDays?: number, allowTransfers?: boolean }} opts
 * @returns {Promise<Array<{ transaction: object, confidence: string, dayDistance: number }>>}
 */
export async function findBankCandidates(amountCents, date, accountIds, opts = {}) {
  const windowDays = opts.windowDays ?? 3;
  const startDate = addDays(date, -windowDays);
  const endDate = addDays(date, windowDays);
  const targetAmount = targetAmountFor(amountCents);
  const candidates = [];

  for (const accountId of accountIds) {
    const transactions = await api.getTransactions(accountId, startDate, endDate);

    for (const txn of transactions) {
      if (txn.amount !== targetAmount) continue;
      if (!isEligible(txn, opts)) continue;

      const dayDistance = Math.abs((new Date(txn.date) - new Date(date)) / 86400000);
      candidates.push({
        transaction: txn,
        confidence: txn.date === date ? 'exact' : 'nearby',
        dayDistance,
      });
    }
  }

  return candidates.sort((a, b) => (
    a.dayDistance - b.dayDistance ||
    a.transaction.date.localeCompare(b.transaction.date) ||
    (a.transaction.imported_payee || '').localeCompare(b.transaction.imported_payee || '')
  ));
}

/**
 * Backward-compatible helper for simple callers.
 */
export async function findBankMatch(amountCents, date, accountIds) {
  const candidates = await findBankCandidates(amountCents, date, accountIds, { windowDays: 1 });
  return candidates[0] || null;
}
