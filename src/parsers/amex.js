import { readFileSync } from 'fs';
import XLSX from 'xlsx';
import { generateImportedId } from './utils.js';

// Amex Canada exports binary .xls files.
// First ~12 rows are summary/header info.
// Transaction data starts at the row with headers:
//   Date, Date Processed, Description, Amount, Foreign Spend Amount,
//   Commission, Exchange Rate, Merchant, Merchant Address, Additional Information
// Date format: DD MMM. YYYY (e.g., "26 Mar. 2026")
// Amount: $-prefixed, signed. Positive = charge (outflow), negative = payment/credit (inflow).

const MONTHS = {
  'jan': '01', 'feb': '02', 'mar': '03', 'apr': '04',
  'may': '05', 'jun': '06', 'jul': '07', 'aug': '08',
  'sep': '09', 'oct': '10', 'nov': '11', 'dec': '12',
};

function parseAmexDate(dateStr) {
  // "26 Mar. 2026" → "2026-03-26"
  const match = dateStr.match(/^(\d{1,2})\s+(\w{3})\.?\s+(\d{4})$/);
  if (!match) return null;
  const [, day, monthAbbr, year] = match;
  const month = MONTHS[monthAbbr.toLowerCase()];
  if (!month) return null;
  return `${year}-${month}-${day.padStart(2, '0')}`;
}

export function detect(content, filename) {
  return /\.xls$/i.test(filename);
}

export function resolveAccount(content, filename) {
  return 'amex';
}

export function parseFile(content, filename) {
  // For XLS files, content is the file path — we need to read the binary
  const workbook = XLSX.readFile(filename);
  const sheet = workbook.Sheets[workbook.SheetNames[0]];
  const rows = XLSX.utils.sheet_to_json(sheet, { header: 1, defval: '' });

  // Find the header row (contains "Date" and "Description")
  let headerIdx = -1;
  for (let i = 0; i < rows.length; i++) {
    const row = rows[i].map(c => String(c).trim().toLowerCase());
    if (row.includes('date') && row.includes('description') && row.includes('amount')) {
      headerIdx = i;
      break;
    }
  }

  if (headerIdx === -1) {
    return { transactions: [], errors: [{ line: 0, row: [], reason: 'Could not find transaction header row in XLS' }] };
  }

  const headers = rows[headerIdx].map(c => String(c).trim().toLowerCase());
  const dateCol = headers.indexOf('date');
  const descCol = headers.indexOf('description');
  const amountCol = headers.indexOf('amount');

  const transactions = [];
  const errors = [];

  for (let i = headerIdx + 1; i < rows.length; i++) {
    const row = rows[i];
    if (!row || row.length === 0) continue;

    const rawDate = String(row[dateCol] || '').trim();
    const description = String(row[descCol] || '').trim();
    const rawAmount = String(row[amountCol] || '').trim();

    if (!rawDate || !description) continue;

    const date = parseAmexDate(rawDate);
    if (!date) {
      errors.push({ line: i + 1, row, reason: `Cannot parse date: "${rawDate}"` });
      continue;
    }

    // Amount: remove $ and commas. Positive = charge (outflow → negative in our system)
    const cleaned = rawAmount.replace(/[$,]/g, '');
    const parsedAmount = parseFloat(cleaned);
    if (isNaN(parsedAmount)) {
      errors.push({ line: i + 1, row, reason: `Cannot parse amount: "${rawAmount}"` });
      continue;
    }
    // Amex: positive = charge (you spent money), negative = credit/payment
    // Our convention: negative = outflow, positive = inflow
    const amount = Math.round(-parsedAmount * 100);

    transactions.push({
      date,
      amount,
      payee_name: description,
      imported_id: generateImportedId('amex', date, amount, description, i),
      notes: '',
    });
  }

  return { transactions, errors };
}
