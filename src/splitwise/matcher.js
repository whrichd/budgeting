import api from '@actual-app/api';

/**
 * Search for a bank transaction matching a Splitwise expense.
 * Looks for transactions with the same absolute amount within ±1 day.
 *
 * @param {number} amountCents - the total amount paid (positive = cents)
 * @param {string} date - YYYY-MM-DD
 * @param {string[]} accountIds - Actual Budget account IDs to search
 * @returns {{ transaction: object, confidence: string } | null}
 */
export async function findBankMatch(amountCents, date, accountIds) {
  // Search ±1 day
  const d = new Date(date);
  const before = new Date(d);
  before.setDate(before.getDate() - 1);
  const after = new Date(d);
  after.setDate(after.getDate() + 1);

  const startDate = before.toISOString().split('T')[0];
  const endDate = after.toISOString().split('T')[0];

  // The amount in Actual is negative for outflows
  const targetAmount = -amountCents;

  for (const accountId of accountIds) {
    const transactions = await api.getTransactions(accountId, startDate, endDate);

    for (const txn of transactions) {
      if (txn.amount === targetAmount) {
        const confidence = txn.date === date ? 'high' : 'medium';
        return { transaction: txn, confidence };
      }
    }
  }

  return null;
}
