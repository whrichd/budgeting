import { parseStringPromise } from 'xml2js';

// OFX files use SGML (or XML in newer versions).
// Parsing logic ported from @actual-app/core's ofx2json.ts.

export function detect(content, filename) {
  return content.includes('OFXHEADER') || /\.(ofx|qfx)$/i.test(filename);
}

export function resolveAccount(content, filename) {
  // OFX files don't reliably identify the bank — require --account flag
  return null;
}

export function parseFile(content, filename) {
  // ofx2json is async (xml2js), but our parser interface is sync.
  // We'll parse synchronously by returning a promise-wrapped result.
  // Actually, the CLI awaits the result, so let's make this async-compatible
  // by wrapping in a sync shim — but the existing parsers are sync.
  // Instead, do the SGML→XML conversion and XML parsing inline.

  // Split into header and body at the <OFX> tag
  const parts = content.split(/<OFX\s?>/, 2);
  if (parts.length < 2) {
    return { transactions: [], errors: [{ line: 0, reason: 'No <OFX> tag found — not a valid OFX file' }] };
  }

  const sgmlBody = `<OFX>${parts[1]}`;

  // Convert SGML to well-formed XML
  const xml = sgml2Xml(sgmlBody);

  // We need async XML parsing, so return a promise
  return parseXmlTransactions(xml);
}

function sgml2Xml(sgml) {
  return sgml
    .replace(/&/g, '&#038;')
    .replace(/&amp;/g, '&#038;')
    .replace(/>\s+</g, '><')
    .replace(/\s+</g, '<')
    .replace(/>\s+/g, '>')
    .replace(/\.(?=[^<>]*>)/g, '')
    .replace(/<(\w+?)>([^<]+)/g, '<$1>$2</<added>$1>')
    .replace(/<\/<added>(\w+?)>(<\/\1>)?/g, '</$1>');
}

function htmlDecode(value) {
  if (!value) return '';
  return value
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&#39;/g, "'")
    .replace(/&quot;/g, '"')
    .replace(/(&amp;|&#038;)/g, '&');
}

async function parseXmlTransactions(xml) {
  let data;
  try {
    data = await parseStringPromise(xml, { explicitArray: false, trim: true });
  } catch {
    return { transactions: [], errors: [{ line: 0, reason: 'Failed to parse OFX XML structure' }] };
  }

  const ofx = data?.['OFX'];
  const rawTxns = extractStatementTransactions(ofx);

  const transactions = [];
  const errors = [];

  for (let i = 0; i < rawTxns.length; i++) {
    const t = rawTxns[i];
    const dtPosted = t['DTPOSTED'];
    if (!dtPosted) {
      errors.push({ line: i, reason: 'Missing DTPOSTED' });
      continue;
    }

    const year = dtPosted.substring(0, 4);
    const month = dtPosted.substring(4, 6);
    const day = dtPosted.substring(6, 8);
    const date = `${year}-${month}-${day}`;

    const amountStr = t['TRNAMT'];
    if (!amountStr) {
      errors.push({ line: i, reason: 'Missing TRNAMT' });
      continue;
    }
    const amount = Math.round(parseFloat(amountStr) * 100);
    if (isNaN(amount)) {
      errors.push({ line: i, reason: `Cannot parse amount: "${amountStr}"` });
      continue;
    }

    const name = htmlDecode(t['NAME'] || '');
    const memo = htmlDecode(t['MEMO'] || '');
    const payee = name || memo || 'Unknown';
    const fitId = t['FITID'] || '';

    transactions.push({
      date,
      amount,
      payee_name: payee,
      imported_id: fitId ? `ofx:${fitId}` : `ofx:${date}:${amount}:${i}`,
      notes: memo && memo !== payee ? memo : '',
    });
  }

  return { transactions, errors };
}

function extractStatementTransactions(ofx) {
  if (!ofx) return [];

  if (ofx['CREDITCARDMSGSRSV1']) {
    return extractFromPath(ofx, ['CREDITCARDMSGSRSV1', 'CCSTMTTRNRS', 'CCSTMTRS', 'BANKTRANLIST', 'STMTTRN']);
  }
  if (ofx['INVSTMTMSGSRSV1']) {
    return extractInvestmentTxns(ofx);
  }
  return extractFromPath(ofx, ['BANKMSGSRSV1', 'STMTTRNRS', 'STMTRS', 'BANKTRANLIST', 'STMTTRN']);
}

function extractFromPath(obj, path) {
  let current = obj;
  for (const key of path.slice(0, -1)) {
    current = asArray(current?.[key])?.[0];
    if (!current) {
      // Try flattening — some OFX files have multiple statement responses
      break;
    }
  }
  if (!current) {
    // Walk again, flatMapping arrays
    current = obj;
    for (const key of path.slice(0, -1)) {
      const val = current?.[key];
      if (Array.isArray(val)) {
        // Multiple statements — flatMap the rest of the path
        return val.flatMap(item => {
          const remaining = path.slice(path.indexOf(key) + 1);
          return extractFromPath({ [remaining[0]]: item[remaining[0]] }, remaining);
        });
      }
      current = val;
      if (!current) return [];
    }
  }
  const lastKey = path[path.length - 1];
  return asArray(current?.[lastKey]);
}

function extractInvestmentTxns(ofx) {
  const msg = ofx['INVSTMTMSGSRSV1'];
  const stmtTrnRs = asArray(msg?.['INVSTMTTRNRS']);
  return stmtTrnRs.flatMap(s => {
    const stmtRs = s?.['INVSTMTRS'];
    const tranList = stmtRs?.['INVTRANLIST'];
    const bankTrans = asArray(tranList?.['INVBANKTRAN']);
    return bankTrans.flatMap(t => asArray(t?.['STMTTRN']));
  });
}

function asArray(value) {
  if (Array.isArray(value)) return value;
  return value === undefined || value === null ? [] : [value];
}
