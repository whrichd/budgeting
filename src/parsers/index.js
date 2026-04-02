import * as td from './td.js';
import * as cibc from './cibc.js';
import * as eqbank from './eqbank.js';
import * as amex from './amex.js';
import * as wealthsimple from './wealthsimple.js';

const parsers = [
  { name: 'amex', module: amex },
  { name: 'eqbank', module: eqbank },
  { name: 'wealthsimple', module: wealthsimple },
  { name: 'td', module: td },
  { name: 'cibc', module: cibc },
];

/**
 * Detect which parser handles a file and resolve the target account.
 *
 * Resolution order:
 *   1. --account CLI flag (explicit override)
 *   2. Parser's resolveAccount() (content + filename heuristics)
 *   3. Error with available account names
 *
 * @param {string} content - file content (empty string for binary files like XLS)
 * @param {string} filename - original filename
 * @param {string|null} accountOverride - from --account CLI flag
 * @returns {{ parser: object, account: string } | null}
 */
export function detectParser(content, filename, accountOverride = null) {
  for (const { name, module: mod } of parsers) {
    if (mod.detect(content, filename)) {
      const account = accountOverride || mod.resolveAccount(content, filename);
      return { parser: mod, parserName: name, account };
    }
  }
  return null;
}

/**
 * For TD files, also try filename-based account resolution.
 * Called by CLI when detectParser returns a null account for TD.
 */
export function resolveAccountFromFilename(filename) {
  const lower = filename.toLowerCase();
  // TD filename convention
  if (lower.includes('credit')) return 'td_credit';
  if (lower.includes('chequing') || lower.includes('checking')) return 'td_chequing';
  return null;
}
