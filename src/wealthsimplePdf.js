import { existsSync, readFileSync, statSync, writeFileSync } from 'fs';
import { basename, resolve } from 'path';
import * as pdfjs from 'pdfjs-dist/legacy/build/pdf.mjs';

const MAX_PDF_BYTES = 25 * 1024 * 1024;
const MAX_PAGES = 20;
const EXTRACTION_TIMEOUT_MS = 15_000;
const MAIN_X_MIN = 90;
const MAIN_X_MAX = 910;

const ACCOUNT_HEADERS = {
  ws_chequing: ['date', 'transaction', 'description', 'amount', 'balance', 'currency'],
  ws_credit: ['transaction_date', 'post_date', 'type', 'details', 'amount', 'currency'],
};

export class WealthsimplePdfError extends Error {
  constructor(message, code = 'wealthsimple-pdf-error') {
    super(message);
    this.name = 'WealthsimplePdfError';
    this.code = code;
  }
}

export async function convertWealthsimplePdf({ inputPath, account, outPath, force = false, reportPath = null }) {
  validateAccount(account);
  const pdfPath = resolve(inputPath);
  const csvPath = resolve(outPath);
  const diagnosticPath = reportPath ? resolve(reportPath) : null;

  validateOutputPaths({ pdfPath, csvPath, diagnosticPath });

  if (existsSync(csvPath) && !force) {
    throw new WealthsimplePdfError(`Output file already exists: ${csvPath}. Use --force to overwrite.`, 'out-exists');
  }
  if (diagnosticPath && existsSync(diagnosticPath) && !force) {
    throw new WealthsimplePdfError(`Report file already exists: ${diagnosticPath}. Use --force to overwrite.`, 'report-exists');
  }

  const extracted = await extractPdfText(pdfPath);
  const parsed = parseWealthsimplePdfLines(extracted.lines, account);
  const csv = stringifyCsv(ACCOUNT_HEADERS[account], parsed.rows);
  writeFileSync(csvPath, csv);

  const summary = buildSummary(parsed, account, pdfPath, csvPath);
  if (diagnosticPath) {
    writeFileSync(diagnosticPath, JSON.stringify(summary, null, 2) + '\n');
  }

  return summary;
}

export async function extractPdfText(pdfPath) {
  const stats = statSync(pdfPath);
  if (stats.size > MAX_PDF_BYTES) {
    throw new WealthsimplePdfError(
      `PDF is over the 25 MB limit. Export a smaller date range and try again: ${pdfPath}`,
      'pdf-too-large'
    );
  }

  return withTimeout(async () => {
    const data = new Uint8Array(readFileSync(pdfPath));
    const loadingTask = pdfjs.getDocument({
      data,
      disableAutoFetch: true,
      disableFontFace: true,
      disableRange: true,
      disableStream: true,
      isEvalSupported: false,
      stopAtErrors: true,
      useSystemFonts: false,
    });

    const doc = await loadingTask.promise;
    if (doc.numPages > MAX_PAGES) {
      throw new WealthsimplePdfError(
        `PDF has ${doc.numPages} pages, over the 20 page limit. Export a smaller date range and try again.`,
        'too-many-pages'
      );
    }

    const items = [];
    for (let pageNum = 1; pageNum <= doc.numPages; pageNum++) {
      const page = await doc.getPage(pageNum);
      const content = await page.getTextContent({ disableCombineTextItems: false });
      for (const item of content.items) {
        if (!item.str?.trim()) continue;
        items.push({
          page: pageNum,
          text: item.str,
          x: item.transform[4],
          y: item.transform[5],
          width: item.width,
          height: item.height,
        });
      }
    }

    return { items, lines: groupTextItemsIntoLines(items), pageCount: doc.numPages };
  }, EXTRACTION_TIMEOUT_MS, 'PDF text extraction exceeded 15 seconds. Export a smaller date range and try again.');
}

export function parseWealthsimplePdfLines(lines, account) {
  validateAccount(account);
  const mainLines = lines.filter(line => line.x >= MAIN_X_MIN && line.x <= MAIN_X_MAX);
  const candidates = findTransactionCandidates(mainLines);
  const rows = [];
  const skipped = [];
  const dateHeaders = findDateHeaders(mainLines);

  for (const candidate of candidates) {
    const date = findDateForCandidate(dateHeaders, candidate);
    if (!date) {
      skipped.push(skip(candidate, 'missing-date'));
      continue;
    }

    const parsed = account === 'ws_chequing'
      ? parseChequingCandidate(candidate, date)
      : parseCreditCandidate(candidate, date);

    if (parsed.row) {
      rows.push(parsed.row);
    } else {
      skipped.push(skip(candidate, parsed.reason));
    }
  }

  const validation = validateShape(rows, account, mainLines, candidates);
  for (const reason of validation.reasons) {
    skipped.push({ reason, page: 1, y: null });
  }

  if (!validation.ok) {
    throw new WealthsimplePdfError(
      `PDF does not look like a ${account} Wealthsimple export (${validation.reasons.join(', ')}).`,
      'shape-mismatch'
    );
  }

  return { rows, skipped };
}

function validateAccount(account) {
  if (!ACCOUNT_HEADERS[account]) {
    throw new WealthsimplePdfError('Use --account ws_chequing or --account ws_credit.', 'invalid-account');
  }
}

function validateOutputPaths({ pdfPath, csvPath, diagnosticPath }) {
  if (csvPath === pdfPath) {
    throw new WealthsimplePdfError('Output CSV path must not be the input PDF path.', 'path-conflict');
  }
  if (diagnosticPath === pdfPath) {
    throw new WealthsimplePdfError('Report path must not be the input PDF path.', 'path-conflict');
  }
  if (diagnosticPath === csvPath) {
    throw new WealthsimplePdfError('Report path must be different from the output CSV path.', 'path-conflict');
  }
}

function groupTextItemsIntoLines(items) {
  const sorted = [...items].sort((a, b) => {
    if (a.page !== b.page) return a.page - b.page;
    if (Math.abs(b.y - a.y) > 3) return b.y - a.y;
    return a.x - b.x;
  });

  const lines = [];
  for (const item of sorted) {
    const line = lines.find(existing => existing.page === item.page && Math.abs(existing.y - item.y) <= 3);
    if (!line) {
      lines.push({ page: item.page, y: item.y, x: item.x, items: [item] });
      continue;
    }
    line.items.push(item);
    line.x = Math.min(line.x, item.x);
    line.y = (line.y + item.y) / 2;
  }

  return lines
    .flatMap(line => splitItemsIntoSegments(line.items).map(segment => ({
      page: line.page,
      x: Math.min(...segment.map(item => item.x)),
      y: segment.reduce((sum, item) => sum + item.y, 0) / segment.length,
      text: joinLineText(segment),
      items: segment,
    })))
    .filter(line => line.text.trim())
    .sort((a, b) => {
      if (a.page !== b.page) return a.page - b.page;
      if (Math.abs(b.y - a.y) > 3) return b.y - a.y;
      return a.x - b.x;
    });
}

function splitItemsIntoSegments(items) {
  const sorted = [...items].sort((a, b) => a.x - b.x);
  const segments = [];
  let current = [];
  let previousEnd = null;

  for (const item of sorted) {
    if (previousEnd !== null && item.x - previousEnd > 80) {
      segments.push(current);
      current = [];
    }
    current.push(item);
    previousEnd = item.x + item.width;
  }

  if (current.length > 0) segments.push(current);
  return segments;
}

function joinLineText(items) {
  let text = '';
  let previousEnd = null;
  for (const item of items) {
    if (previousEnd !== null && item.x - previousEnd > 3) text += ' ';
    text += item.text;
    previousEnd = item.x + item.width;
  }
  return normalizeText(text);
}

function normalizeText(text) {
  return text.replace(/\s+/g, ' ').trim();
}

function findDateHeaders(lines) {
  const headers = [];
  for (const line of lines) {
    const itemMatches = line.items
      .filter(item => item.x >= 90 && item.x <= 260 && isDateHeader(normalizeText(item.text)))
      .map(item => ({
        page: line.page,
        x: item.x,
        y: item.y,
        text: normalizeText(item.text),
        date: toIsoDate(normalizeText(item.text)),
      }));
    headers.push(...itemMatches);

    if (line.x >= 90 && line.x <= 260 && isDateHeader(line.text)) {
      headers.push({ ...line, date: toIsoDate(line.text) });
    }
  }

  const unique = new Map();
  for (const header of headers.filter(header => header.date)) {
    unique.set(`${header.page}:${Math.round(header.y)}:${header.date}`, header);
  }
  return [...unique.values()];
}

function findDateForCandidate(dateHeaders, candidate) {
  const { page, y } = candidate.amountLine;
  const above = dateHeaders
    .filter(header => header.page === page && header.y > y)
    .sort((a, b) => a.y - b.y);
  return above[0]?.date ?? null;
}

function findTransactionCandidates(lines) {
  const amountLines = lines.filter(line => parseCadAmount(line.text) && line.x >= 680 && line.x <= 900);

  return amountLines
    .map(amountLine => {
      const pageLines = lines.filter(line => line.page === amountLine.page);
      const titleLine = nearestLeftLine(pageLines, amountLine.y + 11, 5);
      const detailLine = nearestLeftLine(pageLines, amountLine.y - 11, 5);
      return { amountLine, titleLine, detailLine };
    })
    .filter(candidate => candidate.titleLine && candidate.detailLine);
}

function nearestLeftLine(lines, targetY, tolerance) {
  return lines
    .filter(line => line.x >= 140 && line.x < 650 && Math.abs(line.y - targetY) <= tolerance)
    .sort((a, b) => Math.abs(a.y - targetY) - Math.abs(b.y - targetY))[0] ?? null;
}

function parseChequingCandidate(candidate, date) {
  const amount = parseCadAmount(candidate.amountLine.text);
  if (!amount) return { reason: 'missing-amount' };

  const detail = candidate.detailLine.text;
  if (!detail.includes('Chequing')) return { reason: 'non-chequing-row' };

  const transaction = detail.replace(/\bChequing\b/g, '').trim() || candidate.titleLine.text;
  if (!candidate.titleLine.text || !transaction) return { reason: 'missing-required-field' };

  return {
    row: {
      date,
      transaction,
      description: candidate.titleLine.text,
      amount: formatSignedAmount(amount),
      balance: '',
      currency: 'CAD',
    },
  };
}

function parseCreditCandidate(candidate, date) {
  const amount = parseCadAmount(candidate.amountLine.text);
  if (!amount) return { reason: 'missing-amount' };

  const title = candidate.titleLine.text;
  const detail = candidate.detailLine.text;

  if (detail.includes('Purchase') && detail.includes('Wealthsimple credit card')) {
    if (!amount.negative) return { reason: 'credit-type-sign-mismatch' };
    return creditRow(date, 'Purchase', title, amount.value);
  }

  if (detail.includes('Interest charge') && detail.includes('Wealthsimple credit card')) {
    if (!amount.negative) return { reason: 'credit-type-sign-mismatch' };
    return creditRow(date, 'Purchase', title, amount.value);
  }

  if (title === 'Credit card payment' && detail.includes('From') && detail.includes('Chequing')) {
    if (amount.negative) return { reason: 'credit-type-sign-mismatch' };
    return creditRow(date, 'Payment', title, -amount.value);
  }

  return { reason: 'unsupported-credit-type' };
}

function creditRow(date, type, details, amount) {
  return {
    row: {
      transaction_date: date,
      post_date: date,
      type,
      details,
      amount: formatPlainAmount(amount),
      currency: 'CAD',
    },
  };
}

function parseCadAmount(text) {
  const match = text.match(/([−-])?\s*\$([\d,]+\.\d{2})\s+CAD/);
  if (!match) return null;
  const value = Number(match[2].replace(/,/g, ''));
  if (!Number.isFinite(value)) return null;
  return { value, negative: Boolean(match[1]) };
}

function formatSignedAmount(amount) {
  const value = amount.negative ? -amount.value : amount.value;
  return formatPlainAmount(value);
}

function formatPlainAmount(value) {
  return value.toFixed(2);
}

function isDateHeader(text) {
  return /^[A-Z][a-z]+ \d{1,2}, \d{4}$/.test(text);
}

function toIsoDate(text) {
  const date = new Date(`${text} 00:00:00 UTC`);
  if (Number.isNaN(date.getTime())) return null;
  return date.toISOString().slice(0, 10);
}

function validateShape(rows, account, lines, candidates) {
  const allText = lines.map(line => line.text).join('\n');
  const reasons = [];

  if (rows.length === 0) reasons.push('no-supported-rows');
  if (account === 'ws_credit' && !allText.includes('Wealthsimple credit card')) {
    reasons.push('missing-credit-card-text');
  }
  if (account === 'ws_chequing' && !allText.includes('Chequing')) {
    reasons.push('missing-chequing-text');
  }
  if (account === 'ws_credit' && candidates.some(looksLikeChequingActivityCandidate)) {
    reasons.push('looks-like-mixed-chequing-activity');
  }
  if (account === 'ws_chequing' && looksLikeCreditCardAccountPage(lines)) {
    reasons.push('looks-like-credit-card-page');
  }
  if (account === 'ws_chequing' && lines.some(line => /Credit card .* Wealthsimple credit card/.test(line.text))) {
    reasons.push('looks-like-credit-card-page');
  }

  return { ok: reasons.length === 0, reasons };
}

function looksLikeChequingActivityCandidate(candidate) {
  const title = candidate.titleLine.text;
  const detail = candidate.detailLine.text;
  if (title === 'Credit card payment') return false;
  return /\bChequing\b/.test(detail) && !/Credit card|Wealthsimple credit card/.test(detail);
}

function looksLikeCreditCardAccountPage(lines) {
  const texts = new Set(lines.map(line => line.text));
  return (
    texts.has('Total balance') &&
    texts.has('Available credit') &&
    texts.has('Cash back') &&
    texts.has('Recent activity')
  );
}

function skip(candidate, reason) {
  return {
    reason,
    page: candidate.amountLine.page,
    y: Math.round(candidate.amountLine.y),
  };
}

function stringifyCsv(headers, rows) {
  const lines = [headers.join(',')];
  for (const row of rows) {
    lines.push(headers.map(header => csvCell(row[header] ?? '')).join(','));
  }
  return lines.join('\n') + '\n';
}

function csvCell(value) {
  const text = String(value);
  if (!/[",\n\r]/.test(text)) return text;
  return `"${text.replace(/"/g, '""')}"`;
}

function buildSummary(parsed, account, pdfPath, csvPath) {
  const dates = parsed.rows
    .map(row => row.date || row.transaction_date)
    .filter(Boolean)
    .sort();
  const skippedByReason = {};
  for (const item of parsed.skipped) {
    skippedByReason[item.reason] = (skippedByReason[item.reason] ?? 0) + 1;
  }
  const skippedExamples = parsed.skipped.slice(0, 5).map(item => ({
    reason: item.reason,
    page: item.page,
    y: item.y,
  }));

  return {
    account,
    inputFile: basename(pdfPath),
    outputFile: csvPath,
    exportedRows: parsed.rows.length,
    skippedRows: parsed.skipped.length,
    skippedByReason,
    skippedExamples,
    dateRange: {
      from: dates[0] ?? null,
      to: dates[dates.length - 1] ?? null,
    },
    lowConfidenceRows: 0,
  };
}

async function withTimeout(fn, timeoutMs, message) {
  let timeoutId;
  try {
    return await Promise.race([
      fn(),
      new Promise((_, reject) => {
        timeoutId = setTimeout(() => reject(new WealthsimplePdfError(message, 'pdf-timeout')), timeoutMs);
      }),
    ]);
  } finally {
    clearTimeout(timeoutId);
  }
}

export const testInternals = {
  buildSummary,
  groupTextItemsIntoLines,
  parseCadAmount,
  parseWealthsimplePdfLines,
  stringifyCsv,
};
