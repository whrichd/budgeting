import { parse } from 'csv-parse/sync';
import { generateImportedId } from './utils.js';

// EQ Bank CSV has headers:
// Transfer date, Description, Amount, Balance
// Amounts have $ prefix and are signed (negative = outflow)

export function detect(content, filename) {
  const firstLine = content.split('\n')[0];
  return firstLine.toLowerCase().includes('transfer date');
}

export function resolveAccount(content, filename) {
  return 'eq_savings';
}

export function parseFile(content, filename) {
  const rows = parse(content, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  });

  const transactions = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    const dateStr = row['Transfer date'];
    const description = row['Description'];
    const amountStr = row['Amount'];

    if (!dateStr || !amountStr) {
      errors.push({ line: i + 2, row, reason: 'Missing date or amount' });
      continue;
    }

    // Parse amount: remove $ and commas, keep sign
    const cleaned = amountStr.replace(/[$,]/g, '');
    const amount = Math.round(parseFloat(cleaned) * 100);

    if (isNaN(amount)) {
      errors.push({ line: i + 2, row, reason: `Cannot parse amount: "${amountStr}"` });
      continue;
    }

    transactions.push({
      date: dateStr,
      amount,
      payee_name: description,
      imported_id: generateImportedId('eqbank', dateStr, amount, description, i),
      notes: '',
    });
  }

  return { transactions, errors };
}
