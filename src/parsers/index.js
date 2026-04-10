import * as eqbank from './eqbank.js';
import * as wealthsimple from './wealthsimple.js';

const parsers = [
  { name: 'eqbank', module: eqbank },
  { name: 'wealthsimple', module: wealthsimple },
];

/**
 * Detect which parser handles a file and resolve the target account.
 *
 * @param {string} content - file content
 * @param {string} filename - original filename
 * @param {string|null} accountOverride - from --account CLI flag
 * @returns {{ parser: object, parserName: string, account: string } | null}
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
