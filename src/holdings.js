import { parse } from 'csv-parse/sync';

const BANK_OF_CANADA_URL = 'https://www.bankofcanada.ca/valet/observations/FXUSDCAD/json?recent=1';

/**
 * Detect if a file is a Wealthsimple holdings report.
 */
export function isHoldingsReport(content, filename) {
  if (!/holdings/i.test(filename)) return false;
  const firstLine = content.split('\n')[0];
  return firstLine.includes('Account Name') && firstLine.includes('Market Value');
}

/**
 * Fetch current USD/CAD exchange rate from Bank of Canada.
 */
export async function fetchUsdCadRate() {
  const res = await fetch(BANK_OF_CANADA_URL);
  if (!res.ok) throw new Error(`Failed to fetch exchange rate: ${res.status}`);
  const data = await res.json();
  const obs = data.observations;
  const latest = obs[obs.length - 1];
  return parseFloat(latest.FXUSDCAD.v);
}

/**
 * Parse a Wealthsimple holdings report CSV.
 * Returns per-account totals in CAD.
 *
 * @returns {{ accounts: Array<{ name: string, type: string, marketValueCAD: number, bookValueCAD: number, holdings: number }>, date: string, usdCadRate: number }}
 */
export async function parseHoldingsReport(content) {
  // Strip the trailing "As of ..." line
  const lines = content.trimEnd().split('\n');
  const dataLines = lines.filter(l => l.trim() && !l.startsWith('"As of'));
  const csvContent = dataLines.join('\n');

  const records = parse(csvContent, {
    columns: true,
    skip_empty_lines: true,
    relax_column_count: true,
  });

  const rate = await fetchUsdCadRate();

  // Group by Account Name + Account Type
  const accountMap = new Map();

  for (const row of records) {
    const key = row['Account Name'];
    const type = row['Account Type'];
    const marketValue = parseFloat(row['Market Value']) || 0;
    const currency = row['Market Value Currency'];
    const bookValueCAD = parseFloat(row['Book Value (CAD)']) || 0;

    const marketValueCAD = currency === 'USD' ? marketValue * rate : marketValue;

    if (!accountMap.has(key)) {
      accountMap.set(key, { name: key, type, marketValueCAD: 0, bookValueCAD: 0, holdings: 0 });
    }

    const acct = accountMap.get(key);
    acct.marketValueCAD += marketValueCAD;
    acct.bookValueCAD += bookValueCAD;
    acct.holdings += 1;
  }

  // Extract date from the "As of" line
  const asOfLine = lines.find(l => l.startsWith('"As of'));
  const date = asOfLine ? asOfLine.replace(/^"As of\s+/, '').replace(/"$/, '').trim() : null;

  return {
    accounts: Array.from(accountMap.values()),
    date,
    usdCadRate: rate,
  };
}
