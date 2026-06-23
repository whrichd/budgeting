import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { parse } from 'csv-parse/sync';
import { parseFile as parseWealthsimpleCsv } from '../src/parsers/wealthsimple.js';
import { convertWealthsimplePdf, testInternals, WealthsimplePdfError } from '../src/wealthsimplePdf.js';

const { buildSummary, parseWealthsimplePdfLines, stringifyCsv, parseCadAmount } = testInternals;

test('parses chequing rows into existing Wealthsimple chequing CSV shape', async () => {
  const lines = [
    line('May 15, 2026', 96, 1000),
    line('Transfer out', 156, 911),
    line('Chequing', 156, 889),
    line('− $1,000.00 CAD', 752, 900),
    line('May 14, 2026', 96, 800),
    line('DIALPAD CANADA', 156, 711),
    line('Direct deposit Chequing', 156, 689),
    line('$3,595.96 CAD', 763, 700),
  ];

  const { rows, skipped } = parseWealthsimplePdfLines(lines, 'ws_chequing');
  assert.equal(skipped.length, 0);
  assert.deepEqual(rows, [
    {
      date: '2026-05-15',
      transaction: 'Transfer out',
      description: 'Transfer out',
      amount: '-1000.00',
      balance: '',
      currency: 'CAD',
    },
    {
      date: '2026-05-14',
      transaction: 'Direct deposit',
      description: 'DIALPAD CANADA',
      amount: '3595.96',
      balance: '',
      currency: 'CAD',
    },
  ]);

  const csv = stringifyCsv(['date', 'transaction', 'description', 'amount', 'balance', 'currency'], rows);
  const parsed = await parseWealthsimpleCsv(csv, 'ws_chequing-review.csv');
  assert.equal(parsed.transactions.length, 2);
  assert.equal(parsed.transactions[0].amount, -100000);
  assert.equal(parsed.transactions[1].amount, 359596);
});

test('uses date headers from the same PDF page as the transaction row', () => {
  const lines = [
    line('May 15, 2026', 96, 1000, 1),
    line('Transfer out', 156, 911, 1),
    line('Chequing', 156, 889, 1),
    line('− $1,000.00 CAD', 752, 900, 1),
    line('June 1, 2026', 96, 1000, 2),
    line('Direct deposit', 156, 911, 2),
    line('Direct deposit Chequing', 156, 889, 2),
    line('$2,000.00 CAD', 752, 900, 2),
  ];

  const { rows } = parseWealthsimplePdfLines(lines, 'ws_chequing');

  assert.equal(rows.length, 2);
  assert.equal(rows[0].date, '2026-05-15');
  assert.equal(rows[1].date, '2026-06-01');
});

test('parses credit rows and normalizes amounts for the existing credit parser', async () => {
  const lines = [
    line('Wealthsimple credit card', 144, 1100),
    line('May 15, 2026', 96, 1000),
    line('Wealthsimple', 156, 911),
    line('Interest charge Credit card • Wealthsimple credit card', 156, 889),
    line('− $17.83 CAD', 777, 900),
    line('May 7, 2026', 96, 800),
    line('Credit card payment', 156, 711),
    line('From: Chequing Credit card • Wealthsimple credit card', 156, 689),
    line('$833.35 CAD', 777, 700),
  ];

  const { rows, skipped } = parseWealthsimplePdfLines(lines, 'ws_credit');
  assert.equal(skipped.length, 0);
  assert.deepEqual(rows, [
    {
      transaction_date: '2026-05-15',
      post_date: '2026-05-15',
      type: 'Purchase',
      details: 'Wealthsimple',
      amount: '17.83',
      currency: 'CAD',
    },
    {
      transaction_date: '2026-05-07',
      post_date: '2026-05-07',
      type: 'Payment',
      details: 'Credit card payment',
      amount: '-833.35',
      currency: 'CAD',
    },
  ]);

  const csv = stringifyCsv(['transaction_date', 'post_date', 'type', 'details', 'amount', 'currency'], rows);
  const parsed = await parseWealthsimpleCsv(csv, 'ws_credit-review.csv');
  assert.equal(parsed.transactions.length, 2);
  assert.equal(parsed.transactions[0].amount, -1783);
  assert.equal(parsed.transactions[1].amount, 83335);
});

test('accepts credit card payments when From: Chequing is split into its own line', () => {
  const lines = [
    line('Wealthsimple credit card', 144, 1800),
    line('May 7, 2026', 96, 1000),
    line('Credit card payment', 156, 911),
    line('From: Chequing', 156, 889),
    line('$833.35 CAD', 777, 900),
  ];

  const { rows, skipped } = parseWealthsimplePdfLines(lines, 'ws_credit');

  assert.equal(skipped.length, 0);
  assert.deepEqual(rows, [{
    transaction_date: '2026-05-07',
    post_date: '2026-05-07',
    type: 'Payment',
    details: 'Credit card payment',
    amount: '-833.35',
    currency: 'CAD',
  }]);
});

test('rejects credit rows when visible type and sign disagree', () => {
  const lines = [
    line('Wealthsimple credit card', 144, 1100),
    line('April 9, 2026', 96, 1000),
    line('Merchant', 156, 911),
    line('Purchase Credit card • Wealthsimple credit card', 156, 889),
    line('$51.45 CAD', 777, 900),
    line('April 6, 2026', 96, 800),
    line('Credit card payment', 156, 711),
    line('From: Chequing Credit card • Wealthsimple credit card', 156, 689),
    line('$42.72 CAD', 777, 700),
  ];

  const { rows, skipped } = parseWealthsimplePdfLines(lines, 'ws_credit');
  assert.equal(rows.length, 1);
  assert.equal(skipped[0].reason, 'credit-type-sign-mismatch');
});

test('rejects account mismatches', () => {
  const lines = [
    line('May 15, 2026', 96, 1000),
    line('Transfer out', 156, 911),
    line('Chequing', 156, 889),
    line('− $1,000.00 CAD', 752, 900),
  ];

  assert.throws(
    () => parseWealthsimplePdfLines(lines, 'ws_credit'),
    err => err instanceof WealthsimplePdfError && err.code === 'shape-mismatch'
  );
});

test('rejects mixed chequing activity when exporting credit rows', () => {
  const lines = [
    line('Wealthsimple credit card', 144, 1800),
    line('May 15, 2026', 96, 1000),
    line('Merchant', 156, 911),
    line('Purchase Credit card • Wealthsimple credit card', 156, 889),
    line('− $17.83 CAD', 777, 900),
    line('May 14, 2026', 96, 800),
    line('DIALPAD CANADA', 156, 711),
    line('Direct deposit Chequing', 156, 689),
    line('$3,595.96 CAD', 763, 700),
  ];

  assert.throws(
    () => parseWealthsimplePdfLines(lines, 'ws_credit'),
    err =>
      err instanceof WealthsimplePdfError &&
      err.code === 'shape-mismatch' &&
      err.message.includes('looks-like-mixed-chequing-activity')
  );
});

test('protects existing diagnostic report files unless force is supplied', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-pdf-'));
  const reportPath = join(dir, 'report.json');
  const outPath = join(dir, 'review.csv');
  writeFileSync(reportPath, '{}\n');

  await assert.rejects(
    () => convertWealthsimplePdf({
      inputPath: join(dir, 'missing.pdf'),
      account: 'ws_credit',
      outPath,
      reportPath,
    }),
    err => err instanceof WealthsimplePdfError && err.code === 'report-exists'
  );
});

test('rejects matching output and report paths before writing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-pdf-'));
  const samePath = join(dir, 'review.csv');

  await assert.rejects(
    () => convertWealthsimplePdf({
      inputPath: join(dir, 'source.pdf'),
      account: 'ws_credit',
      outPath: samePath,
      reportPath: samePath,
      force: true,
    }),
    err => err instanceof WealthsimplePdfError && err.code === 'path-conflict'
  );
});

test('rejects output paths that match the input PDF even with force', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'ws-pdf-'));
  const pdfPath = join(dir, 'source.pdf');
  const outPath = join(dir, 'review.csv');

  await assert.rejects(
    () => convertWealthsimplePdf({
      inputPath: pdfPath,
      account: 'ws_credit',
      outPath: pdfPath,
      force: true,
    }),
    err => err instanceof WealthsimplePdfError && err.code === 'path-conflict'
  );

  await assert.rejects(
    () => convertWealthsimplePdf({
      inputPath: pdfPath,
      account: 'ws_credit',
      outPath,
      reportPath: pdfPath,
      force: true,
    }),
    err => err instanceof WealthsimplePdfError && err.code === 'path-conflict'
  );
});

test('summary includes privacy-safe skipped row examples', () => {
  const summary = buildSummary({
    rows: [],
    skipped: [
      { reason: 'unsupported-credit-type', page: 2, y: 900 },
      { reason: 'missing-date', page: 3, y: null },
    ],
  }, 'ws_credit', '/tmp/source.pdf', '/tmp/review.csv');

  assert.deepEqual(summary.skippedExamples, [
    { reason: 'unsupported-credit-type', page: 2, y: 900 },
    { reason: 'missing-date', page: 3, y: null },
  ]);
});

test('parses unicode and ascii CAD signs', () => {
  assert.deepEqual(parseCadAmount('− $51.45 CAD'), { value: 51.45, negative: true });
  assert.deepEqual(parseCadAmount('- $51.45 CAD'), { value: 51.45, negative: true });
  assert.deepEqual(parseCadAmount('$833.35 CAD'), { value: 833.35, negative: false });
});

test('CSV stringification escapes import-compatible fields', () => {
  const csv = stringifyCsv(
    ['date', 'transaction', 'description', 'amount', 'balance', 'currency'],
    [{
      date: '2026-05-01',
      transaction: 'Direct deposit',
      description: 'Employer, Inc.',
      amount: '1.00',
      balance: '',
      currency: 'CAD',
    }]
  );

  const rows = parse(csv, { columns: true });
  assert.equal(rows[0].description, 'Employer, Inc.');
});

function line(text, x, y, page = 1) {
  return { page, text, x, y, items: [] };
}
