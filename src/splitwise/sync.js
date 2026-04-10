import api from '@actual-app/api';
import { getCurrentUser, getExpenses, parseExpense } from './client.js';
import { findBankMatch } from './matcher.js';
import { isApplied, markApplied, getDefaultSinceDate } from './state.js';
import { loadConfig, getAccountId } from '../config.js';
import { createInterface } from 'readline';

/**
 * Build proposed actions for Splitwise expenses.
 */
export async function buildProposals(since) {
  const sinceDate = since || getDefaultSinceDate();
  console.log(`Fetching Splitwise expenses since ${sinceDate}...\n`);

  const user = await getCurrentUser();
  const expenses = await getExpenses(sinceDate);
  console.log(`Found ${expenses.length} expenses.\n`);

  // Get all on-budget account IDs for bank matching
  const accounts = await api.getAccounts();
  const onBudgetIds = accounts
    .filter(a => !a.offbudget && !a.closed)
    .map(a => a.id);

  const proposals = [];

  for (const raw of expenses) {
    const expense = parseExpense(raw, user.id);
    if (!expense) continue;

    // Skip already-applied expenses
    if (isApplied(expense.id)) continue;

    // Skip expenses where your share is 0
    if (expense.yourShareCents === 0 && !expense.isPayment) continue;

    let proposal;

    if (expense.isPayment) {
      // Settlement payment
      const match = await findBankMatch(expense.paidCents, expense.date, onBudgetIds);
      proposal = {
        type: 'settlement',
        expense,
        bankMatch: match,
        description: expense.youPaid
          ? `Settlement: you paid $${(expense.paidCents / 100).toFixed(2)}`
          : `Settlement: you received $${(expense.paidCents / 100).toFixed(2)}`,
      };
    } else if (expense.youPaid) {
      // You paid — need to split the bank transaction
      const match = await findBankMatch(expense.paidCents, expense.date, onBudgetIds);
      proposal = {
        type: 'you_paid',
        expense,
        bankMatch: match,
        description: `Split: $${(expense.yourShareCents / 100).toFixed(2)} your expense + $${(expense.othersShareCents / 100).toFixed(2)} receivable`,
      };
    } else {
      // They paid — create a payable entry
      proposal = {
        type: 'they_paid',
        expense,
        bankMatch: null,
        description: `Create: $${(expense.yourShareCents / 100).toFixed(2)} payable`,
      };
    }

    proposals.push(proposal);
  }

  return proposals;
}

/**
 * Display proposals in a table and return them.
 */
export function displayProposals(proposals) {
  if (proposals.length === 0) {
    console.log('No new Splitwise expenses to process.');
    return;
  }

  // Header
  console.log(
    'Date'.padEnd(12) +
    'Description'.padEnd(30) +
    'Total'.padEnd(10) +
    'Your Share'.padEnd(12) +
    'Bank Match?'.padEnd(22) +
    'Action'
  );
  console.log('-'.repeat(110));

  for (const p of proposals) {
    const e = p.expense;
    const date = e.date;
    const desc = e.description.slice(0, 28).padEnd(30);
    const total = `$${(e.totalCents / 100).toFixed(2)}`.padEnd(10);
    const share = e.isPayment
      ? '-'.padEnd(12)
      : `$${(e.yourShareCents / 100).toFixed(2)}`.padEnd(12);

    let matchStr;
    if (p.bankMatch) {
      const t = p.bankMatch.transaction;
      const name = (t.payee || t.imported_payee || '').slice(0, 12);
      matchStr = `${name} ${(t.amount / 100).toFixed(2)} [${p.bankMatch.confidence}]`;
    } else if (p.type === 'they_paid') {
      matchStr = '(they paid)';
    } else {
      matchStr = '(no match)';
    }

    console.log(
      date.padEnd(12) +
      desc +
      total +
      share +
      matchStr.padEnd(22) +
      p.description
    );
  }

  console.log('');
}

/**
 * Apply confirmed proposals to Actual Budget.
 */
export async function applyProposals(proposals) {
  const receivableId = getAccountId('splitwise_receivable');
  const payableId = getAccountId('splitwise_payable');
  const appliedIds = [];

  for (const p of proposals) {
    const e = p.expense;

    try {
      if (p.type === 'you_paid' && p.bankMatch) {
        // Convert bank transaction to split transaction
        const txn = p.bankMatch.transaction;
        await api.updateTransaction(txn.id, {
          notes: `[Splitwise] ${e.description}`,
          subtransactions: [
            {
              amount: -e.yourShareCents,
              notes: 'Your share',
            },
            {
              amount: -e.othersShareCents,
              account: receivableId,
              notes: `Splitwise receivable`,
            },
          ],
        });
        console.log(`  ✓ Split: ${e.description} → $${(e.yourShareCents / 100).toFixed(2)} expense + $${(e.othersShareCents / 100).toFixed(2)} receivable`);

      } else if (p.type === 'you_paid' && !p.bankMatch) {
        // No bank match — just log it, user needs to handle manually
        console.log(`  ⚠ No bank match for "${e.description}" ($${(e.paidCents / 100).toFixed(2)}) — skipping, handle manually`);
        continue; // Don't mark as applied

      } else if (p.type === 'they_paid') {
        // Create payable transaction
        await api.importTransactions(payableId, [{
          date: e.date,
          amount: -e.yourShareCents,
          payee_name: `Splitwise: ${e.description}`,
          imported_id: `sw-${e.id}`,
          notes: `[Splitwise] They paid, your share`,
        }]);
        console.log(`  ✓ Payable: ${e.description} → $${(e.yourShareCents / 100).toFixed(2)}`);

      } else if (p.type === 'settlement') {
        if (p.bankMatch && e.youPaid) {
          // You sent money — mark as transfer to payable
          const txn = p.bankMatch.transaction;
          await api.updateTransaction(txn.id, {
            account: payableId,
            notes: `[Splitwise] Settlement payment`,
          });
          console.log(`  ✓ Settlement: marked $${(e.paidCents / 100).toFixed(2)} as payable offset`);
        } else if (p.bankMatch && !e.youPaid) {
          // You received money — mark as transfer from receivable
          const txn = p.bankMatch.transaction;
          await api.updateTransaction(txn.id, {
            account: receivableId,
            notes: `[Splitwise] Settlement received`,
          });
          console.log(`  ✓ Settlement: marked $${(e.paidCents / 100).toFixed(2)} as receivable offset`);
        } else {
          console.log(`  ⚠ No bank match for settlement "${e.description}" — skipping`);
          continue;
        }
      }

      appliedIds.push(e.id);
    } catch (err) {
      console.error(`  ✗ Failed: ${e.description} — ${err.message}`);
    }
  }

  if (appliedIds.length > 0) {
    markApplied(appliedIds);
  }

  return appliedIds.length;
}

/**
 * Prompt user for yes/no confirmation.
 */
export function confirm(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.toLowerCase().startsWith('y'));
    });
  });
}
