import { readFileSync } from 'fs';
import { parse as parseYaml } from 'yaml';
import { resolve } from 'path';

const CONFIG_PATH = resolve(process.cwd(), 'config', 'accounts.yml');

let _config = null;

export function loadConfig() {
  if (_config) return _config;

  let raw;
  try {
    raw = readFileSync(CONFIG_PATH, 'utf-8');
  } catch (err) {
    if (err.code === 'ENOENT') {
      console.error(`Config not found: ${CONFIG_PATH}`);
      console.error('Copy config/accounts.example.yml to config/accounts.yml and fill in your values.');
      process.exit(1);
    }
    throw err;
  }

  _config = parseYaml(raw);

  if (!_config.actual?.serverURL || !_config.actual?.password) {
    console.error('Config missing required fields: actual.serverURL, actual.password');
    process.exit(1);
  }
  if (!_config.accounts || Object.keys(_config.accounts).length === 0) {
    console.error('Config missing account mappings. See accounts.example.yml.');
    process.exit(1);
  }

  return _config;
}

export function getAccountId(accountKey) {
  const config = loadConfig();
  const id = config.accounts[accountKey];
  if (!id || id === 'actual-account-uuid') {
    console.error(`Account "${accountKey}" not configured in accounts.yml.`);
    console.error(`Available accounts: ${Object.keys(config.accounts).join(', ')}`);
    process.exit(1);
  }
  return id;
}

export function getAvailableAccounts() {
  const config = loadConfig();
  return Object.keys(config.accounts);
}
