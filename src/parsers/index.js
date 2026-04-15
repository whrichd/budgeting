import * as eqbank from './eqbank.js';
import * as wealthsimple from './wealthsimple.js';
import * as ofx from './ofx.js';
import { getAvailableAccounts } from '../config.js';

const parsers = [
  { name: 'eqbank', module: eqbank },
  { name: 'wealthsimple', module: wealthsimple },
  { name: 'ofx', module: ofx },
];

/**
 * Try to resolve account from filename by matching against configured account keys.
 * e.g. "td_chequing-march-2026.ofx" matches account key "td_chequing".
 */
function resolveAccountFromFilename(filename) {
  const lower = filename.toLowerCase();
  const keys = getAvailableAccounts();
  // Sort by length descending so "ws_chequing" matches before "ws" if both exist
  const sorted = keys.sort((a, b) => b.length - a.length);
  for (const key of sorted) {
    if (lower.includes(key)) return key;
  }
  return null;
}

/**
 * Detect which parser handles a file and resolve the target account.
 *
 * Resolution order: --account flag > parser's resolveAccount > filename match
 *
 * @param {string} content - file content
 * @param {string} filename - original filename
 * @param {string|null} accountOverride - from --account CLI flag
 * @returns {{ parser: object, parserName: string, account: string } | null}
 */
export function detectParser(content, filename, accountOverride = null) {
  for (const { name, module: mod } of parsers) {
    if (mod.detect(content, filename)) {
      const account = accountOverride || mod.resolveAccount(content, filename) || resolveAccountFromFilename(filename);
      return { parser: mod, parserName: name, account };
    }
  }
  return null;
}
