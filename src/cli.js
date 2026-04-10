#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, basename, extname } from 'path';
import { detectParser } from './parsers/index.js';
import { getAccountId, getAvailableAccounts } from './config.js';
import { connect, importTransactions, getAccounts, getAccountBalance, disconnect } from './actual.js';
import { isHoldingsReport, parseHoldingsReport } from './holdings.js';

const program = new Command();

program
  .name('budget')
  .description('Import bank transactions into Actual Budget')
  .version('0.1.0');

program
  .command('import')
  .description('Import CSV files into Actual Budget (EQ Bank, Wealthsimple)')
  .argument('<path>', 'File or directory to import')
  .option('--account <key>', 'Explicit account key (from accounts.yml)')
  .option('--dry-run', 'Parse and show results without importing')
  .action(async (inputPath, opts) => {
    const absPath = resolve(inputPath);
    let files;

    const stat = statSync(absPath);
    if (stat.isDirectory()) {
      files = readdirSync(absPath)
        .filter(f => /\.csv$/i.test(f))
        .map(f => resolve(absPath, f));
    } else {
      files = [absPath];
    }

    if (files.length === 0) {
      console.error('No CSV files found at', inputPath);
      process.exit(1);
    }

    console.log(`Found ${files.length} file(s) to import.\n`);

    // Parse all files first (before connecting to Actual)
    const fileResults = [];

    for (const filePath of files) {
      const filename = basename(filePath);
      const content = readFileSync(filePath, 'utf-8');

      if (isHoldingsReport(content, filename)) {
        console.log(`  [SKIP] ${filename} — holdings report (use 'holdings' command)`);
        continue;
      }

      const detected = detectParser(content, filename, opts.account);

      if (!detected) {
        console.log(`  [SKIP] ${filename} — not a supported CSV format (use Actual Budget UI for OFX imports)`);
        continue;
      }

      let { parser, parserName, account } = detected;

      if (!account) {
        console.error(`  [SKIP] ${filename} — detected as ${parserName}, but cannot determine account.`);
        console.error(`         Use --account <key>. Available: ${getAvailableAccounts().join(', ')}`);
        continue;
      }

      console.log(`  Parsing ${filename} → ${parserName} → account: ${account}`);

      const { transactions, errors } = parser.parseFile(content, filePath);
      fileResults.push({ filename, account, transactions, errors, parserName });
    }

    if (fileResults.length === 0) {
      console.error('\nNo files could be parsed. Check file formats and --account flag.');
      process.exit(1);
    }

    // Summary of parse phase
    console.log('\n--- Parse Results ---');
    let totalTxns = 0;
    let totalErrors = 0;
    for (const { filename, account, transactions, errors } of fileResults) {
      console.log(`  ${filename} (${account}): ${transactions.length} transactions, ${errors.length} errors`);
      totalTxns += transactions.length;
      totalErrors += errors.length;

      for (const err of errors) {
        console.error(`    Line ${err.line}: ${err.reason}`);
      }
    }
    console.log(`  Total: ${totalTxns} transactions, ${totalErrors} errors\n`);

    if (opts.dryRun) {
      console.log('Dry run — not importing.');
      // Print sample transactions
      for (const { filename, transactions } of fileResults) {
        if (transactions.length > 0) {
          console.log(`\nSample from ${filename}:`);
          for (const t of transactions.slice(0, 3)) {
            console.log(`  ${t.date}  ${(t.amount / 100).toFixed(2).padStart(10)}  ${t.payee_name}`);
          }
          if (transactions.length > 3) console.log(`  ... and ${transactions.length - 3} more`);
        }
      }
      return;
    }

    // Import into Actual Budget
    console.log('Connecting to Actual Budget...');
    await connect();

    for (const { filename, account, transactions } of fileResults) {
      if (transactions.length === 0) continue;

      const accountId = getAccountId(account);
      console.log(`  Importing ${transactions.length} transactions into ${account}...`);

      try {
        const result = await importTransactions(accountId, transactions);
        const added = result?.added?.length ?? '?';
        const updated = result?.updated?.length ?? '?';
        console.log(`  ✓ ${account}: ${added} added, ${updated} updated`);
      } catch (err) {
        console.error(`  ✗ ${account}: import failed — ${err.message}`);
      }
    }

    await disconnect();
    console.log('\nDone.');
  });

program
  .command('balances')
  .description('Show account balances from Actual Budget')
  .action(async () => {
    await connect();
    const accounts = await getAccounts();

    console.log('\nAccounts in Actual Budget:\n');
    for (const acct of accounts) {
      const type = acct.offbudget ? 'tracking' : 'on-budget';
      const closed = acct.closed ? ' (closed)' : '';
      console.log(`  ${acct.name.padEnd(30)} ${type.padEnd(12)} ${closed}`);
    }

    await disconnect();
  });

// --- Holdings / net worth ---

const HOLDINGS_ACCOUNT_MAP = {
  'RRSP': 'ws_rrsp',
  'TFSA': 'ws_tfsa',
};

program
  .command('holdings')
  .description('Update investment account balances from Wealthsimple holdings report')
  .argument('<file>', 'Holdings report CSV file')
  .option('--dry-run', 'Show totals without updating Actual Budget')
  .action(async (filePath, opts) => {
    const absPath = resolve(filePath);
    const content = readFileSync(absPath, 'utf-8');
    const filename = basename(absPath);

    if (!isHoldingsReport(content, filename)) {
      console.error('File does not appear to be a Wealthsimple holdings report.');
      process.exit(1);
    }

    console.log('Parsing holdings report...');
    const { accounts, date, usdCadRate } = await parseHoldingsReport(content);

    console.log(`\nReport date: ${date || 'unknown'}`);
    console.log(`USD/CAD rate: ${usdCadRate.toFixed(4)}\n`);

    for (const acct of accounts) {
      const unrealized = acct.marketValueCAD - acct.bookValueCAD;
      const sign = unrealized >= 0 ? '+' : '';
      console.log(`  ${acct.name.padEnd(8)} ${acct.holdings} holdings  Market: $${acct.marketValueCAD.toFixed(2).padStart(12)}  Book: $${acct.bookValueCAD.toFixed(2).padStart(12)}  ${sign}$${unrealized.toFixed(2)}`);
    }

    if (opts.dryRun) {
      console.log('\nDry run — not updating Actual Budget.');
      return;
    }

    console.log('\nConnecting to Actual Budget...');
    await connect();

    for (const acct of accounts) {
      const accountKey = HOLDINGS_ACCOUNT_MAP[acct.name];
      if (!accountKey) {
        console.log(`  [SKIP] ${acct.name} — no account mapping (add to HOLDINGS_ACCOUNT_MAP)`);
        continue;
      }

      const accountId = getAccountId(accountKey);
      const currentBalance = await getAccountBalance(accountId);
      const targetBalance = Math.round(acct.marketValueCAD * 100); // cents
      const diff = targetBalance - currentBalance;

      if (diff === 0) {
        console.log(`  ${acct.name} — already up to date ($${(currentBalance / 100).toFixed(2)})`);
        continue;
      }

      const today = new Date().toISOString().slice(0, 10);
      const txn = {
        date: today,
        amount: diff,
        payee_name: 'Balance adjustment',
        imported_id: `holdings-${acct.name.toLowerCase()}-${today}`,
        notes: `Holdings report ${date || today} — market value update`,
      };

      const result = await importTransactions(accountId, [txn]);
      const added = result?.added?.length ?? 0;
      const updated = result?.updated?.length ?? 0;

      const arrow = diff > 0 ? '↑' : '↓';
      console.log(`  ${acct.name} — ${arrow} $${(Math.abs(diff) / 100).toFixed(2)} adjustment → $${(targetBalance / 100).toFixed(2)} (${added} added, ${updated} updated)`);
    }

    await disconnect();
    console.log('\nDone.');
  });

// --- Splitwise commands ---

const sw = program
  .command('splitwise')
  .description('Splitwise integration — sync shared expenses');

sw.command('expenses')
  .description('List recent Splitwise expenses')
  .option('--since <date>', 'Start date (YYYY-MM-DD)')
  .action(async (opts) => {
    const { getCurrentUser, getExpenses, parseExpense } = await import('./splitwise/client.js');
    const { getDefaultSinceDate } = await import('./splitwise/state.js');

    const since = opts.since || getDefaultSinceDate();
    console.log(`Fetching expenses since ${since}...\n`);

    const user = await getCurrentUser();
    const expenses = await getExpenses(since);

    console.log(
      'Date'.padEnd(12) +
      'Description'.padEnd(30) +
      'Total'.padEnd(10) +
      'Your Share'.padEnd(12) +
      'Who Paid'
    );
    console.log('-'.repeat(80));

    for (const raw of expenses) {
      const e = parseExpense(raw, user.id);
      if (!e) continue;

      const total = `$${(e.totalCents / 100).toFixed(2)}`;
      const share = e.isPayment ? '-' : `$${(e.yourShareCents / 100).toFixed(2)}`;
      const whoPaid = e.isPayment ? 'Settlement' : (e.youPaid ? 'You' : 'They');

      console.log(
        e.date.padEnd(12) +
        e.description.slice(0, 28).padEnd(30) +
        total.padEnd(10) +
        share.padEnd(12) +
        whoPaid
      );
    }

    console.log(`\n${expenses.length} expenses total.`);
  });

sw.command('balances')
  .description('Show who owes whom on Splitwise')
  .action(async () => {
    const { getFriends } = await import('./splitwise/client.js');

    const friends = await getFriends();
    console.log('\nSplitwise Balances:\n');

    let hasBalances = false;
    for (const friend of friends) {
      const balances = friend.balance || [];
      for (const b of balances) {
        const amount = parseFloat(b.amount);
        if (amount === 0) continue;
        hasBalances = true;
        const name = `${friend.first_name} ${friend.last_name || ''}`.trim();
        if (amount > 0) {
          console.log(`  ${name} owes you $${amount.toFixed(2)} ${b.currency_code}`);
        } else {
          console.log(`  You owe ${name} $${Math.abs(amount).toFixed(2)} ${b.currency_code}`);
        }
      }
    }

    if (!hasBalances) console.log('  All settled up!');
    console.log('');
  });

sw.command('sync')
  .description('Sync Splitwise expenses with Actual Budget')
  .option('--since <date>', 'Start date (YYYY-MM-DD)')
  .action(async (opts) => {
    const { buildProposals, displayProposals, applyProposals, confirm } = await import('./splitwise/sync.js');

    await connect();

    const proposals = await buildProposals(opts.since);
    displayProposals(proposals);

    if (proposals.length === 0) {
      await disconnect();
      return;
    }

    const yes = await confirm(`Apply ${proposals.length} changes? [y/n] `);
    if (!yes) {
      console.log('Cancelled.');
      await disconnect();
      return;
    }

    console.log('\nApplying changes...');
    const applied = await applyProposals(proposals);
    console.log(`\n${applied} changes applied.`);

    await disconnect();
  });

program.parse();
