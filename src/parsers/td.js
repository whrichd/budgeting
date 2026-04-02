import { parse } from 'csv-parse/sync';
import { generateImportedId } from './utils.js';

// TD CSVs have no headers. Format:
// MM/DD/YYYY, Description, Debit, Credit, Balance
// Debit/Credit columns — one is empty per row.
// Credit and chequing use the same format — disambiguation via filename or --account flag.

const DATE_RE = /^\d{2}\/\d{2}\/\d{4}$/;

export function detect(content, filename) {
  const firstLine = content.split('\n')[0];
  if (!firstLine) return false;
  const cols = parse(firstLine, { relax_column_count: true })[0];
  if (!cols || cols.length < 4) return false;
  return DATE_RE.test(cols[0].trim());
}

export function resolveAccount(content, filename) {
  const lower = filename.toLowerCase();
  if (lower.includes('credit')) return 'td_credit';
  if (lower.includes('chequing') || lower.includes('checking')) return 'td_chequing';
  return null; // ambiguous — needs --account flag
}

export function parseFile(content, filename) {
  const rows = parse(content, {
    relax_column_count: true,
    skip_empty_lines: true,
  });

  const transactions = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 4) {
      errors.push({ line: i + 1, row, reason: `Expected at least 4 columns, got ${row.length}` });
      continue;
    }

    const [dateStr, description, debitStr, creditStr] = row.map(c => c.trim());

    // Parse date MM/DD/YYYY → YYYY-MM-DD
    const match = dateStr.match(/^(\d{2})\/(\d{2})\/(\d{4})$/);
    if (!match) {
      errors.push({ line: i + 1, row, reason: `Invalid date: ${dateStr}` });
      continue;
    }
    const [, month, day, year] = match;
    const date = `${year}-${month}-${day}`;

    // Amount: debit is outflow (negative), credit is inflow (positive)
    const debit = debitStr ? parseFloat(debitStr.replace(/,/g, '')) : 0;
    const credit = creditStr ? parseFloat(creditStr.replace(/,/g, '')) : 0;
    const amount = Math.round((credit - debit) * 100); // integer cents

    if (isNaN(amount)) {
      errors.push({ line: i + 1, row, reason: `Cannot parse amount: debit="${debitStr}" credit="${creditStr}"` });
      continue;
    }

    transactions.push({
      date,
      amount,
      payee_name: description,
      imported_id: generateImportedId('td', date, amount, description, i),
      notes: '',
    });
  }

  return { transactions, errors };
}
