import { parse } from 'csv-parse/sync';
import { generateImportedId } from './utils.js';

// Wealthsimple has two CSV formats:
//
// Chequing: date, transaction, description, amount, balance, currency
//   - transaction has type codes: E_TRFOUT, TRFOUT, INT, AFT_OUT, AFT_IN, P2P_RECEIVED, P2P_SENT, etc.
//   - Amount is signed (negative = outflow)
//   - Account ID is in the filename (e.g., WK1YRQV30CAD)
//
// Credit Card: transaction_date, post_date, type, details, amount, currency
//   - type: Payment (negative = credit), Purchase (positive = charge)
//   - Positive amount = charge (outflow from user's perspective)

export function detect(content, filename) {
  const firstLine = content.split('\n')[0].toLowerCase();
  return isChequing(firstLine) || isCreditCard(firstLine);
}

function isChequing(firstLineLower) {
  return firstLineLower.includes('transaction') && firstLineLower.includes('balance');
}

function isCreditCard(firstLineLower) {
  return firstLineLower.includes('post_date') && firstLineLower.includes('type');
}

export function resolveAccount(content, filename) {
  const firstLine = content.split('\n')[0].toLowerCase();
  if (isCreditCard(firstLine)) return 'ws_credit';
  if (isChequing(firstLine)) return 'ws_chequing';
  return null;
}

export function parseFile(content, filename) {
  const firstLine = content.split('\n')[0].toLowerCase();

  if (isCreditCard(firstLine)) {
    return parseCreditCard(content, filename);
  }
  return parseChequing(content, filename);
}

function parseChequing(content, filename) {
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const transactions = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const dateStr = row['date'];
    const txnType = row['transaction'] || '';
    const description = row['description'] || txnType;
    const amountStr = row['amount'];

    if (!dateStr || !amountStr) {
      errors.push({ line: i + 2, row, reason: 'Missing date or amount' });
      continue;
    }

    const amount = Math.round(parseFloat(amountStr) * 100);
    if (isNaN(amount)) {
      errors.push({ line: i + 2, row, reason: `Cannot parse amount: "${amountStr}"` });
      continue;
    }

    const payee = description || txnType;

    transactions.push({
      date: dateStr,
      amount,
      payee_name: payee,
      imported_id: generateImportedId('ws_chq', dateStr, amount, `${txnType}:${description}`, i),
      notes: txnType !== description ? `Type: ${txnType}` : '',
    });
  }

  return { transactions, errors };
}

function parseCreditCard(content, filename) {
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const transactions = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const dateStr = row['transaction_date'];
    const type = row['type'] || '';
    const details = row['details'] || type;
    const amountStr = row['amount'];

    if (!dateStr || !amountStr) {
      errors.push({ line: i + 2, row, reason: 'Missing date or amount' });
      continue;
    }

    const parsedAmount = parseFloat(amountStr);
    if (isNaN(parsedAmount)) {
      errors.push({ line: i + 2, row, reason: `Cannot parse amount: "${amountStr}"` });
      continue;
    }

    // WS Credit Card: positive = charge (outflow → negative), negative = payment (inflow → positive)
    const amount = Math.round(-parsedAmount * 100);

    transactions.push({
      date: dateStr,
      amount,
      payee_name: details,
      imported_id: generateImportedId('ws_cc', dateStr, amount, `${type}:${details}`, i),
      notes: '',
    });
  }

  return { transactions, errors };
}
