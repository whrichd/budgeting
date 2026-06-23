import api from '@actual-app/api';
import { getCurrentUser, getExpenses, parseExpense } from './client.js';
import { findBankCandidates } from './matcher.js';
import { getAppliedRecord, getDefaultSinceDate, isApplied } from './state.js';
import { getAccountId, getCategoryId } from '../config.js';
import { createInterface } from 'readline';

const SPLITWISE_MARKER = '[Splitwise]';
const PENDING_MARKER = '[Splitwise pending]';

function splitwiseMarker(id) {
  return `[Splitwise:${id}]`;
}

function formatAmount(cents) {
  return `$${(Math.abs(cents) / 100).toFixed(2)}`;
}

function signedSettlementAmount(expense) {
  return expense.youPaid ? expense.settlementCents : -expense.settlementCents;
}

function addDays(date, days) {
  const d = new Date(date);
  d.setDate(d.getDate() + days);
  return d.toISOString().split('T')[0];
}

async function ask(question) {
  return new Promise((resolve) => {
    const rl = createInterface({ input: process.stdin, output: process.stdout });
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function yesNo(question, defaultValue = false) {
  const answer = await ask(question);
  if (!answer) return defaultValue;
  return answer.toLowerCase().startsWith('y');
}

async function getTransferPayeeId(accountId) {
  const payees = await api.getPayees();
  const payee = payees.find(p => p.transfer_acct === accountId);

  if (!payee) {
    throw new Error(`No transfer payee found for account ${accountId}`);
  }

  return payee.id;
}

function buildSplitChild(parent, fields) {
  return {
    account: parent.account,
    date: parent.date,
    payee: parent.payee ?? null,
    category: parent.category ?? null,
    cleared: parent.cleared ?? true,
    reconciled: parent.reconciled ?? false,
    is_child: true,
    parent_id: parent.id,
    ...fields,
  };
}

function buildApplicationRecord(expense, status, fields = {}) {
  return {
    splitwiseId: expense.id,
    status,
    amount: expense.isPayment ? expense.settlementCents : expense.yourShareCents,
    date: expense.date,
    splitwiseUpdatedAt: expense.updatedAt,
    ...fields,
  };
}

async function findMarkedTransaction(accountId, { date, amount, marker, windowDays = 0 }) {
  const startDate = addDays(date, -windowDays);
  const endDate = addDays(date, windowDays);
  const transactions = await api.getTransactions(accountId, startDate, endDate);
  const matches = transactions.filter(txn => (
    txn.amount === amount &&
    (txn.notes || '').includes(marker)
  ));

  if (matches.length > 1) {
    throw new Error(`Found multiple transactions for ${marker}; resolve manually before syncing`);
  }

  return matches[0] || null;
}

async function findMarkedTransactionInAccounts(accountIds, fields) {
  const matches = [];

  for (const accountId of accountIds) {
    const match = await findMarkedTransaction(accountId, fields);
    if (match) matches.push(match);
  }

  if (matches.length > 1) {
    throw new Error(`Found multiple transactions for ${fields.marker}; resolve manually before syncing`);
  }

  return matches[0] || null;
}

async function findCreatedTransaction(accountId, fields) {
  const created = await findMarkedTransaction(accountId, fields);
  if (!created) {
    throw new Error(`Expected one created transaction for ${fields.marker}, found 0`);
  }

  return created;
}

function usableAccounts(accounts, clearingId) {
  return accounts.filter(a => !a.offbudget && !a.closed && a.id !== clearingId);
}

async function chooseAccount(accounts, cache, expense) {
  if (cache.lastAccountId) {
    const cached = accounts.find(a => a.id === cache.lastAccountId);
    if (cached) {
      const useCached = await yesNo(`Use ${cached.name} for "${expense.description}"? [Y/n] `, true);
      if (useCached) return cached;
    }
  }

  console.log('\nChoose the bank/card account for this Splitwise item:');
  accounts.forEach((account, index) => {
    console.log(`  ${index + 1}. ${account.name}`);
  });

  while (true) {
    const answer = await ask('Account number (blank to skip): ');
    if (!answer) return null;
    const index = Number(answer) - 1;
    if (accounts[index]) {
      cache.lastAccountId = accounts[index].id;
      return accounts[index];
    }
    console.log('Invalid account number.');
  }
}

async function chooseCandidate(candidates, expense, allowPlaceholders) {
  console.log(`\nCandidates for "${expense.description}" (${formatAmount(expense.isPayment ? expense.settlementCents : expense.paidCents)}):`);
  candidates.forEach((candidate, index) => {
    const txn = candidate.transaction;
    const payee = txn.imported_payee || txn.payee || '(no payee)';
    console.log(`  ${index + 1}. ${txn.date} ${formatAmount(txn.amount)} ${payee} [${candidate.confidence}]`);
  });

  while (true) {
    const prompt = allowPlaceholders
      ? 'Use candidate number, p=create placeholder, s=skip: '
      : 'Use candidate number, s=skip: ';
    const answer = await ask(prompt);
    if (answer.toLowerCase() === 's' || answer === '') return { action: 'skip' };
    if (allowPlaceholders && answer.toLowerCase() === 'p') return { action: 'placeholder' };
    const index = Number(answer) - 1;
    if (candidates[index]) return { action: 'match', candidate: candidates[index] };
    console.log('Invalid choice.');
  }
}

export async function loadSplitwiseContext({ noPlaceholders = false } = {}) {
  const clearingId = getAccountId('splitwise_clearing');
  const reviewCategoryId = getCategoryId('splitwise_review');
  const [accounts, categories] = await Promise.all([
    api.getAccounts(),
    api.getCategories(),
  ]);

  const clearing = accounts.find(a => a.id === clearingId);
  if (!clearing) throw new Error('Configured splitwise_clearing account was not found in Actual.');
  if (clearing.closed) throw new Error('Configured splitwise_clearing account is closed.');
  if (clearing.offbudget) throw new Error('Configured splitwise_clearing account must be on-budget.');

  const reviewCategory = categories.find(c => c.id === reviewCategoryId);
  if (!reviewCategory) throw new Error('Configured splitwise_review category was not found in Actual.');

  return {
    clearingId,
    clearingPayeeId: await getTransferPayeeId(clearingId),
    reviewCategoryId,
    bankAccounts: usableAccounts(accounts, clearingId),
    canPrompt: Boolean(process.stdin.isTTY && process.stdout.isTTY),
    allowPlaceholders: Boolean(process.stdin.isTTY && process.stdout.isTTY && !noPlaceholders),
    noPlaceholders,
  };
}

/**
 * Build proposed actions for Splitwise expenses.
 */
export async function buildProposals(since, context) {
  const sinceDate = since || getDefaultSinceDate();
  console.log(`Fetching Splitwise expenses since ${sinceDate}...\n`);

  const user = await getCurrentUser();
  const expenses = await getExpenses(sinceDate);
  console.log(`Found ${expenses.length} expenses.\n`);

  const bankAccountIds = context.bankAccounts.map(a => a.id);
  const proposals = [];

  for (const raw of expenses) {
    const expense = parseExpense(raw, user.id);
    if (!expense) continue;

    const appliedRecord = getAppliedRecord(expense.id);
    const applied = isApplied(expense.id);
    if (applied && expense.deletedAt) {
      proposals.push({
        type: 'changed',
        expense,
        candidates: [],
        description: 'Already applied but deleted in Splitwise; review manually',
      });
      continue;
    }

    if (appliedRecord && expense.updatedAt && appliedRecord.splitwiseUpdatedAt && appliedRecord.splitwiseUpdatedAt !== expense.updatedAt) {
      proposals.push({
        type: 'changed',
        expense,
        candidates: [],
        description: 'Already applied but changed in Splitwise; review manually',
      });
      continue;
    }

    if (applied) continue;
    if (expense.deletedAt) continue;
    if (expense.currencyCode && expense.currencyCode !== 'CAD') {
      proposals.push({
        type: 'unsupported_currency',
        expense,
        candidates: [],
        description: `Skip non-CAD expense (${expense.currencyCode})`,
      });
      continue;
    }
    if (expense.yourShareCents === 0 && !expense.isPayment) continue;

    if (expense.isPayment) {
      const matchAmount = signedSettlementAmount(expense);
      const candidates = await findBankCandidates(matchAmount, expense.date, bankAccountIds, {
        windowDays: 3,
        allowTransfers: false,
      });
      proposals.push({
        type: 'settlement',
        expense,
        candidates,
        description: expense.youPaid
          ? `Settlement: you paid ${formatAmount(expense.settlementCents)}`
          : `Settlement: you received ${formatAmount(expense.settlementCents)}`,
      });
    } else if (expense.youPaid) {
      const candidates = await findBankCandidates(expense.paidCents, expense.date, bankAccountIds, {
        windowDays: 3,
        allowTransfers: false,
      });
      proposals.push({
        type: 'you_paid',
        expense,
        candidates,
        description: `Split: ${formatAmount(expense.yourShareCents)} your expense + ${formatAmount(expense.othersShareCents)} clearing`,
      });
    } else {
      proposals.push({
        type: 'they_paid',
        expense,
        candidates: [],
        description: `Create clearing expense: ${formatAmount(expense.yourShareCents)}`,
      });
    }
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

  console.log(
    'Date'.padEnd(12) +
    'Description'.padEnd(30) +
    'Total'.padEnd(10) +
    'Your Share'.padEnd(12) +
    'Candidates'.padEnd(14) +
    'Action'
  );
  console.log('-'.repeat(110));

  for (const p of proposals) {
    const e = p.expense;
    const total = `$${(e.totalCents / 100).toFixed(2)}`.padEnd(10);
    const share = e.isPayment
      ? '-'.padEnd(12)
      : `$${(e.yourShareCents / 100).toFixed(2)}`.padEnd(12);
    const exact = p.candidates.filter(c => c.transaction.date === e.date).length;
    const nearby = p.candidates.length - exact;
    const candidateStr = p.candidates.length ? `${exact} exact/${nearby} near` : '-';

    console.log(
      e.date.padEnd(12) +
      e.description.slice(0, 28).padEnd(30) +
      total +
      share +
      candidateStr.padEnd(14) +
      p.description
    );
  }

  console.log('');
}

async function applyYouPaidMatch(expense, candidate, context) {
  const txn = candidate.transaction;
  const marker = splitwiseMarker(expense.id);
  await api.updateTransaction(txn.id, {
    is_parent: true,
    category: null,
    notes: `${SPLITWISE_MARKER} ${expense.description} ${marker}`,
    subtransactions: [
      buildSplitChild(txn, {
        amount: -expense.yourShareCents,
        category: context.reviewCategoryId,
        notes: 'Your share',
      }),
      buildSplitChild(txn, {
        amount: -expense.othersShareCents,
        payee: context.clearingPayeeId,
        category: null,
        notes: 'Splitwise clearing',
      }),
    ],
  });

  return buildApplicationRecord(expense, 'matched', {
    actualTxnId: txn.id,
    accountId: txn.account,
  });
}

async function createYouPaidPlaceholder(expense, account, context) {
  const marker = splitwiseMarker(expense.id);
  const notes = `${PENDING_MARKER} ${expense.description} ${marker}`;
  const existing = await findMarkedTransaction(account.id, {
    date: expense.date,
    amount: -expense.paidCents,
    marker,
  });

  if (existing) {
    return buildApplicationRecord(expense, 'placeholder', {
      actualTxnId: existing.id,
      accountId: account.id,
    });
  }

  await api.addTransactions(account.id, [{
    date: expense.date,
    amount: -expense.paidCents,
    payee_name: `Splitwise: ${expense.description}`,
    notes,
    cleared: false,
    subtransactions: [
      {
        amount: -expense.yourShareCents,
        category: context.reviewCategoryId,
        notes: 'Your share',
      },
      {
        amount: -expense.othersShareCents,
        payee: context.clearingPayeeId,
        category: null,
        notes: 'Splitwise clearing',
      },
    ],
  }], { runTransfers: true });

  const created = await findCreatedTransaction(account.id, {
    date: expense.date,
    amount: -expense.paidCents,
    marker,
  });

  return buildApplicationRecord(expense, 'placeholder', {
    actualTxnId: created.id,
    accountId: account.id,
  });
}

async function createTheyPaidClearingExpense(expense, context) {
  const marker = splitwiseMarker(expense.id);
  const existing = await findMarkedTransaction(context.clearingId, {
    date: expense.date,
    amount: -expense.yourShareCents,
    marker,
  });

  if (existing) {
    return buildApplicationRecord(expense, 'matched', {
      actualTxnId: existing.id,
      accountId: context.clearingId,
    });
  }

  await api.addTransactions(context.clearingId, [{
    date: expense.date,
    amount: -expense.yourShareCents,
    payee_name: `Splitwise: ${expense.description}`,
    category: context.reviewCategoryId,
    notes: `${SPLITWISE_MARKER} They paid, your share ${marker}`,
    cleared: false,
  }], { runTransfers: true });

  const created = await findCreatedTransaction(context.clearingId, {
    date: expense.date,
    amount: -expense.yourShareCents,
    marker,
  });

  return buildApplicationRecord(expense, 'matched', {
    actualTxnId: created.id,
    accountId: context.clearingId,
  });
}

async function applySettlementMatch(expense, candidate, context) {
  const txn = candidate.transaction;
  const marker = splitwiseMarker(expense.id);
  await api.updateTransaction(txn.id, {
    payee: context.clearingPayeeId,
    category: null,
    notes: `${SPLITWISE_MARKER} Settlement ${marker}`,
  });

  return buildApplicationRecord(expense, 'matched', {
    actualTxnId: txn.id,
    accountId: txn.account,
  });
}

async function createSettlementPlaceholder(expense, account, context) {
  const marker = splitwiseMarker(expense.id);
  const amount = expense.youPaid ? -expense.settlementCents : expense.settlementCents;
  const existing = await findMarkedTransaction(account.id, {
    date: expense.date,
    amount,
    marker,
  });

  if (existing) {
    return buildApplicationRecord(expense, 'placeholder', {
      actualTxnId: existing.id,
      accountId: account.id,
    });
  }

  await api.addTransactions(account.id, [{
    date: expense.date,
    amount,
    payee: context.clearingPayeeId,
    category: null,
    notes: `${PENDING_MARKER} Settlement ${marker}`,
    cleared: false,
  }], { runTransfers: true });

  const created = await findCreatedTransaction(account.id, {
    date: expense.date,
    amount,
    marker,
  });

  return buildApplicationRecord(expense, 'placeholder', {
    actualTxnId: created.id,
    accountId: account.id,
  });
}

async function resolveCandidate(proposal, context, accountCache) {
  const exactCandidates = proposal.candidates.filter(c => c.transaction.date === proposal.expense.date);

  if (exactCandidates.length === 1 && proposal.candidates.length === 1) {
    return { action: 'match', candidate: exactCandidates[0] };
  }

  if (!context.canPrompt) {
    return { action: 'skip', reason: proposal.candidates.length ? 'ambiguous/non-exact match' : 'no bank match' };
  }

  if (proposal.candidates.length > 0) {
    const choice = await chooseCandidate(proposal.candidates, proposal.expense, context.allowPlaceholders);
    if (choice.action !== 'placeholder') return choice;

    const account = await chooseAccount(context.bankAccounts, accountCache, proposal.expense);
    if (!account) return { action: 'skip', reason: 'no account selected' };
    return { action: 'placeholder', account };
  }

  if (!context.allowPlaceholders) {
    return { action: 'skip', reason: 'no bank match' };
  }

  const create = await yesNo(`No bank match for "${proposal.expense.description}". Create placeholder? [y/N] `, false);
  if (!create) return { action: 'skip', reason: 'user skipped placeholder' };

  const account = await chooseAccount(context.bankAccounts, accountCache, proposal.expense);
  if (!account) return { action: 'skip', reason: 'no account selected' };
  return { action: 'placeholder', account };
}

async function findExistingApplicationRecord(expense, type, context) {
  const marker = splitwiseMarker(expense.id);
  let transaction = null;

  if (type === 'they_paid') {
    transaction = await findMarkedTransaction(context.clearingId, {
      date: expense.date,
      amount: -expense.yourShareCents,
      marker,
    });
  } else if (type === 'you_paid') {
    transaction = await findMarkedTransactionInAccounts(context.bankAccounts.map(a => a.id), {
      date: expense.date,
      amount: -expense.paidCents,
      marker,
      windowDays: 3,
    });
  } else if (type === 'settlement') {
    transaction = await findMarkedTransactionInAccounts(context.bankAccounts.map(a => a.id), {
      date: expense.date,
      amount: expense.youPaid ? -expense.settlementCents : expense.settlementCents,
      marker,
      windowDays: 3,
    });
  }

  if (!transaction) return null;

  const status = (transaction.notes || '').includes(PENDING_MARKER)
    ? 'placeholder'
    : 'matched';

  return buildApplicationRecord(expense, status, {
    actualTxnId: transaction.id,
    accountId: transaction.account,
  });
}

/**
 * Apply confirmed proposals to Actual Budget.
 */
export async function applyProposals(proposals, context) {
  const records = [];
  const skipped = [];
  const failed = [];
  const accountCache = {};

  for (const p of proposals) {
    const e = p.expense;

    try {
      if (p.type === 'changed' || p.type === 'unsupported_currency') {
        console.log(`  ⚠ ${p.description}: ${e.description}`);
        skipped.push({ expense: e, reason: p.description });
        continue;
      }

      const existingRecord = await findExistingApplicationRecord(e, p.type, context);
      if (existingRecord) {
        records.push(existingRecord);
        console.log(`  ✓ Already in Actual: ${e.description} → recorded existing ${existingRecord.status}`);
        continue;
      }

      if (p.type === 'they_paid') {
        const record = await createTheyPaidClearingExpense(e, context);
        records.push(record);
        console.log(`  ✓ Clearing expense: ${e.description} → ${formatAmount(e.yourShareCents)}`);
        continue;
      }

      const resolution = await resolveCandidate(p, context, accountCache);
      if (resolution.action === 'skip') {
        console.log(`  ⚠ Skipped: ${e.description} (${resolution.reason || 'skipped'})`);
        skipped.push({ expense: e, reason: resolution.reason || 'skipped' });
        continue;
      }

      let record;
      if (p.type === 'you_paid') {
        if (resolution.action === 'match') {
          record = await applyYouPaidMatch(e, resolution.candidate, context);
          console.log(`  ✓ Split: ${e.description} → ${formatAmount(e.yourShareCents)} expense + ${formatAmount(e.othersShareCents)} clearing`);
        } else {
          record = await createYouPaidPlaceholder(e, resolution.account, context);
          console.log(`  ✓ Placeholder split: ${e.description} in ${resolution.account.name}`);
        }
      } else if (p.type === 'settlement') {
        if (resolution.action === 'match') {
          record = await applySettlementMatch(e, resolution.candidate, context);
          console.log(`  ✓ Settlement transfer: ${e.description} → ${formatAmount(e.settlementCents)}`);
        } else {
          record = await createSettlementPlaceholder(e, resolution.account, context);
          console.log(`  ✓ Settlement placeholder: ${e.description} in ${resolution.account.name}`);
        }
      }

      if (record) records.push(record);
    } catch (err) {
      console.error(`  ✗ Failed: ${e.description} — ${err.message}`);
      failed.push({ expense: e, error: err });
    }
  }

  return { records, skipped, failed };
}

/**
 * Prompt user for yes/no confirmation.
 */
export function confirm(question) {
  return yesNo(question);
}
