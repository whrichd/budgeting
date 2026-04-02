#!/usr/bin/env node

import { Command } from 'commander';
import { readFileSync, readdirSync, statSync } from 'fs';
import { resolve, basename, extname } from 'path';
import { detectParser, resolveAccountFromFilename } from './parsers/index.js';
import { getAccountId, getAvailableAccounts } from './config.js';
import { connect, importTransactions, getAccounts, disconnect } from './actual.js';

const program = new Command();

program
  .name('budget')
  .description('Import bank transactions into Actual Budget')
  .version('0.1.0');

program
  .command('import')
  .description('Import CSV/XLS files into Actual Budget')
  .argument('<path>', 'File or directory to import')
  .option('--account <key>', 'Explicit account key (from accounts.yml)')
  .option('--dry-run', 'Parse and show results without importing')
  .action(async (inputPath, opts) => {
    const absPath = resolve(inputPath);
    let files;

    const stat = statSync(absPath);
    if (stat.isDirectory()) {
      files = readdirSync(absPath)
        .filter(f => /\.(csv|xls|xlsx)$/i.test(f))
        .map(f => resolve(absPath, f));
    } else {
      files = [absPath];
    }

    if (files.length === 0) {
      console.error('No CSV/XLS files found at', inputPath);
      process.exit(1);
    }

    console.log(`Found ${files.length} file(s) to import.\n`);

    // Parse all files first (before connecting to Actual)
    const fileResults = [];

    for (const filePath of files) {
      const filename = basename(filePath);
      const ext = extname(filePath).toLowerCase();
      const isBinary = ext === '.xls' || ext === '.xlsx';

      // For binary files, pass empty content — the parser reads the file directly
      const content = isBinary ? '' : readFileSync(filePath, 'utf-8');

      const detected = detectParser(content, filename, opts.account);

      if (!detected) {
        console.error(`  [SKIP] ${filename} — could not detect bank format.`);
        console.error(`         Use --account <key>. Available: ${getAvailableAccounts().join(', ')}`);
        continue;
      }

      let { parser, parserName, account } = detected;

      // Tier 2: filename convention (for TD)
      if (!account) {
        account = resolveAccountFromFilename(filename);
      }

      if (!account) {
        console.error(`  [SKIP] ${filename} — detected as ${parserName}, but cannot determine account.`);
        console.error(`         Use --account <key> or rename file (e.g., td_credit.csv).`);
        console.error(`         Available: ${getAvailableAccounts().join(', ')}`);
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

program.parse();
