import { parse } from 'csv-parse/sync';
import { generateImportedId } from './utils.js';

// CIBC has two formats, both headerless, both YYYY-MM-DD:
//
// Credit: YYYY-MM-DD, "Description", Debit, Credit, CardNumber
//   - 5 columns, card mask like 5268********8064 in column 5
//
// Chequing: YYYY-MM-DD, LongDescription, Debit, Credit
//   - 4 columns, verbose descriptions with transaction type prefixes

const CARD_MASK_RE = /^\d{4}\*+\d{4}$/;
const YYYY_MM_DD_RE = /^\d{4}-\d{2}-\d{2}$/;

export function detect(content, filename) {
  const firstLine = content.split('\n')[0];
  if (!firstLine) return false;
  const cols = parse(firstLine, { relax_column_count: true })[0];
  if (!cols || cols.length < 4) return false;
  return YYYY_MM_DD_RE.test(cols[0].trim());
}

export function resolveAccount(content, filename) {
  const firstLine = content.split('\n')[0];
  if (!firstLine) return null;
  const cols = parse(firstLine, { relax_column_count: true })[0];
  if (!cols) return null;

  // 5 columns with card mask → credit
  if (cols.length >= 5 && CARD_MASK_RE.test(cols[4].trim())) {
    return 'cibc_credit';
  }
  // 4 columns → chequing
  if (cols.length === 4) {
    return 'cibc_chequing';
  }
  return null;
}

function cleanChequingDescription(desc) {
  // Extract meaningful payee from verbose CIBC chequing descriptions
  const patterns = [
    // "Point of Sale - Interac RETAIL PURCHASE 607812266366 CONSULATE GENER" → last part
    { re: /(?:Point of Sale.*?PURCHASE\s+\d+\s+)(.+)/i, group: 1 },
    // "Point of Sale - Visa Debit VISA DEBIT RETAIL PURCHASE AFFIRM CANADA 606518308847" → company name before number
    { re: /VISA DEBIT RETAIL PURCHASE\s+(.+?)\s+\d+$/i, group: 1 },
    // "Electronic Funds Transfer PAY 10677735683 DIALPAD CANADA INC" → company after number
    { re: /Electronic Funds Transfer PAY\s+\d+\s+(.+)/i, group: 1 },
    // "Electronic Funds Transfer PREAUTHORIZED DEBIT Wealthsimple Investments Inc." → after DEBIT
    { re: /PREAUTHORIZED DEBIT\s+(.+)/i, group: 1 },
    // "Internet Banking INTERNET TRANSFER 000000116465" → "Internet Transfer"
    { re: /Internet Banking INTERNET TRANSFER/i, replace: 'Internet Transfer' },
    // "Internet Banking FULFILL REQUEST 105560697116 Canadian Tire Bank" → after number
    { re: /Internet Banking FULFILL REQUEST\s+\d+\s+(.+)/i, group: 1 },
    // "Branch Transaction SERVICE CHARGE..." → "Service Charge"
    { re: /Branch Transaction SERVICE CHARGE/i, replace: 'Service Charge' },
    // "Branch Transaction CREDIT MEMO..." → "Credit Memo"
    { re: /Branch Transaction CREDIT MEMO/i, replace: 'Credit Memo' },
    // "Automated Banking Machine ATM WITHDRAWAL..." → "ATM Withdrawal"
    { re: /Automated Banking Machine ATM WITHDRAWAL/i, replace: 'ATM Withdrawal' },
    // "Electronic Funds Transfer PAY..." with company → "EFT - Company"
    { re: /Electronic Funds Transfer\s+(.+)/i, group: 1 },
  ];

  for (const pattern of patterns) {
    if (pattern.replace) {
      if (pattern.re.test(desc)) return pattern.replace;
    } else {
      const match = desc.match(pattern.re);
      if (match) return match[pattern.group].trim();
    }
  }

  return desc;
}

export function parseFile(content, filename) {
  const rows = parse(content, {
    relax_column_count: true,
    skip_empty_lines: true,
  });

  const account = resolveAccount(content, filename);
  const isCredit = account === 'cibc_credit';
  const transactions = [];
  const errors = [];

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    if (row.length < 4) {
      errors.push({ line: i + 1, row, reason: `Expected at least 4 columns, got ${row.length}` });
      continue;
    }

    const dateStr = row[0].trim();
    const rawDescription = row[1].trim();
    const debitStr = row[2].trim();
    const creditStr = row[3].trim();

    if (!YYYY_MM_DD_RE.test(dateStr)) {
      errors.push({ line: i + 1, row, reason: `Invalid date: ${dateStr}` });
      continue;
    }

    const debit = debitStr ? parseFloat(debitStr.replace(/,/g, '')) : 0;
    const credit = creditStr ? parseFloat(creditStr.replace(/,/g, '')) : 0;
    const amount = Math.round((credit - debit) * 100);

    if (isNaN(amount)) {
      errors.push({ line: i + 1, row, reason: `Cannot parse amount: debit="${debitStr}" credit="${creditStr}"` });
      continue;
    }

    const payee_name = isCredit ? rawDescription : cleanChequingDescription(rawDescription);

    transactions.push({
      date: dateStr,
      amount,
      payee_name,
      imported_id: generateImportedId('cibc', dateStr, amount, rawDescription, i),
      notes: isCredit ? '' : rawDescription, // Keep full description in notes for chequing
    });
  }

  return { transactions, errors };
}
